//! The AI providers. Claude, Codex and Grok are driven through their own
//! command-line tools, so whatever the user has signed in to and whatever
//! tools those agents carry are available with no model restrictions.
//! OpenRouter is an HTTP API with a key from Settings.
//!
//! One-shot completions (commit messages) go through `complete`. The
//! OpenRouter chat panel streams through `openrouter_chat`.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::settings::Settings;

const OPENROUTER: &str = "https://openrouter.ai/api/v1";
const COMPLETION_TIMEOUT: Duration = Duration::from_secs(240);

#[derive(Serialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub available: bool,
    pub detail: String,
}

pub fn providers(settings: &Settings) -> Vec<Provider> {
    let cli = |id: &str, name: &str, binary: &str| {
        let path = crate::shell::which(binary);
        Provider {
            id: id.to_string(),
            name: name.to_string(),
            kind: "cli".to_string(),
            available: path.is_some(),
            detail: path.unwrap_or_else(|| format!("`{binary}` is not on your PATH. Install the CLI and sign in from a terminal.")),
        }
    };
    vec![
        cli("claude", "Claude Code", "claude"),
        cli("codex", "Codex", "codex"),
        cli("grok", "Grok", "grok"),
        Provider {
            id: "openrouter".to_string(),
            name: "OpenRouter".to_string(),
            kind: "api".to_string(),
            available: !settings.openrouter_api_key.trim().is_empty(),
            detail: if settings.openrouter_api_key.trim().is_empty() { "Add an API key in Settings.".to_string() } else { settings.openrouter_model.clone() },
        },
    ]
}

/// Runs `cmd` with `stdin` on its input, kills it after the timeout, and
/// returns stdout (or an error with stderr).
fn run_with_input(mut cmd: Command, stdin: Option<&str>) -> Result<String, String> {
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("cannot start {:?}: {e}", cmd.get_program()))?;
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let text = text.to_string();
        std::thread::spawn(move || {
            let _ = pipe.write_all(text.as_bytes());
        });
    }
    let pid = child.id();
    let done = Arc::new(AtomicBool::new(false));
    let flag = done.clone();
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        while start.elapsed() < COMPLETION_TIMEOUT {
            if flag.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let _ = Command::new("kill").arg(pid.to_string()).status();
    });
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    done.store(true, Ordering::Relaxed);
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if out.status.success() {
        Ok(stdout)
    } else if out.status.code().is_none() {
        Err("The provider took too long and was stopped.".to_string())
    } else {
        let msg = if stderr.trim().is_empty() { stdout } else { stderr };
        Err(msg.trim().chars().take(2000).collect())
    }
}

pub fn complete(provider: &str, prompt: &str, cwd: &str, model: Option<&str>, settings: &Settings) -> Result<String, String> {
    let model = model.map(|m| m.trim()).filter(|m| !m.is_empty());
    let cwd = if std::path::Path::new(cwd).is_dir() { cwd } else { "/" };
    let text = match provider {
        "claude" => {
            let mut cmd = crate::shell::command("claude");
            cmd.current_dir(cwd).args(["-p", "--output-format", "text"]);
            if let Some(m) = model.or(Some(settings.claude_model.as_str())).filter(|m| !m.is_empty()) {
                cmd.args(["--model", m]);
            }
            run_with_input(cmd, Some(prompt))?
        }
        "codex" => {
            let last = std::env::temp_dir().join(format!("orbit-ide-codex-{}.txt", std::process::id()));
            let _ = std::fs::remove_file(&last);
            let mut cmd = crate::shell::command("codex");
            cmd.current_dir(cwd).args(["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "--color", "never", "-C", cwd, "-o"]).arg(&last);
            if let Some(m) = model.or(Some(settings.codex_model.as_str())).filter(|m| !m.is_empty()) {
                cmd.args(["-m", m]);
            }
            cmd.arg("-");
            let stdout = run_with_input(cmd, Some(prompt))?;
            let from_file = std::fs::read_to_string(&last).unwrap_or_default();
            let _ = std::fs::remove_file(&last);
            if from_file.trim().is_empty() { stdout } else { from_file }
        }
        "grok" => {
            let mut cmd = crate::shell::command("grok");
            cmd.current_dir(cwd).args(["--output-format", "plain", "--no-plan", "--disable-web-search", "--no-subagents", "--cwd", cwd]);
            if let Some(m) = model.or(Some(settings.grok_model.as_str())).filter(|m| !m.is_empty()) {
                cmd.args(["-m", m]);
            }
            cmd.arg("-p").arg(prompt);
            run_with_input(cmd, None)?
        }
        "openrouter" => openrouter_complete(settings, model.unwrap_or(settings.openrouter_model.as_str()), prompt)?,
        other => return Err(format!("unknown provider {other}")),
    };
    Ok(text.trim().to_string())
}

fn openrouter_agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(20)).timeout_read(Duration::from_secs(300)).build()
}

fn openrouter_complete(settings: &Settings, model: &str, prompt: &str) -> Result<String, String> {
    let key = settings.openrouter_api_key.trim();
    if key.is_empty() {
        return Err("Add an OpenRouter API key in Settings.".to_string());
    }
    let body = json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
    });
    let resp = openrouter_agent()
        .post(&format!("{OPENROUTER}/chat/completions"))
        .set("Authorization", &format!("Bearer {key}"))
        .set("HTTP-Referer", "https://orbit.local/ide")
        .set("X-Title", "Orbit IDE")
        .send_json(body);
    let value: Value = match resp {
        Ok(r) => r.into_json().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            return Err(format!("OpenRouter answered {code}: {}", error_text(&text)));
        }
        Err(e) => return Err(format!("OpenRouter: {e}")),
    };
    value["choices"][0]["message"]["content"].as_str().map(|s| s.to_string()).ok_or_else(|| format!("OpenRouter returned no text: {value}"))
}

fn error_text(body: &str) -> String {
    serde_json::from_str::<Value>(body).ok().and_then(|v| v["error"]["message"].as_str().map(|s| s.to_string())).unwrap_or_else(|| body.chars().take(400).collect())
}

#[derive(Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub context: u64,
}

pub fn openrouter_models(settings: &Settings) -> Result<Vec<ModelInfo>, String> {
    let mut req = openrouter_agent().get(&format!("{OPENROUTER}/models"));
    if !settings.openrouter_api_key.trim().is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", settings.openrouter_api_key.trim()));
    }
    let value: Value = req.call().map_err(|e| format!("OpenRouter: {e}"))?.into_json().map_err(|e| e.to_string())?;
    let mut models: Vec<ModelInfo> = value["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    Some(ModelInfo {
                        id: m["id"].as_str()?.to_string(),
                        name: m["name"].as_str().unwrap_or("").to_string(),
                        context: m["context_length"].as_u64().unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

// ---- streaming chat --------------------------------------------------------

#[derive(Default)]
pub struct ChatState {
    cancelled: Mutex<HashSet<String>>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Clone)]
struct Delta {
    id: String,
    text: String,
}

#[derive(Serialize, Clone)]
struct Done {
    id: String,
    error: Option<String>,
}

pub fn cancel(state: &ChatState, id: &str) {
    if let Ok(mut set) = state.cancelled.lock() {
        set.insert(id.to_string());
    }
}

fn is_cancelled(state: &ChatState, id: &str) -> bool {
    state.cancelled.lock().map(|s| s.contains(id)).unwrap_or(false)
}

/// Streams an OpenRouter reply as `ai:delta` events, then `ai:done`.
pub fn openrouter_chat(app: AppHandle, id: String, model: String, messages: Vec<Message>, settings: Settings) {
    std::thread::spawn(move || {
        let finish = |error: Option<String>| {
            let _ = app.emit("ai:done", Done { id: id.clone(), error });
            if let Ok(mut set) = app.state::<ChatState>().cancelled.lock() {
                set.remove(&id);
            }
        };
        let key = settings.openrouter_api_key.trim().to_string();
        if key.is_empty() {
            return finish(Some("Add an OpenRouter API key in Settings.".to_string()));
        }
        let body = json!({ "model": model, "messages": messages, "stream": true });
        let resp = openrouter_agent()
            .post(&format!("{OPENROUTER}/chat/completions"))
            .set("Authorization", &format!("Bearer {key}"))
            .set("HTTP-Referer", "https://orbit.local/ide")
            .set("X-Title", "Orbit IDE")
            .send_json(body);
        let resp = match resp {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) => {
                let text = r.into_string().unwrap_or_default();
                return finish(Some(format!("OpenRouter answered {code}: {}", error_text(&text))));
            }
            Err(e) => return finish(Some(format!("OpenRouter: {e}"))),
        };
        let reader = BufReader::new(resp.into_reader());
        for line in reader.lines() {
            if is_cancelled(&app.state::<ChatState>(), &id) {
                return finish(None);
            }
            let Ok(line) = line else { break };
            let Some(data) = line.strip_prefix("data: ") else { continue };
            if data.trim() == "[DONE]" {
                break;
            }
            let Ok(value) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(err) = value["error"]["message"].as_str() {
                return finish(Some(err.to_string()));
            }
            if let Some(text) = value["choices"][0]["delta"]["content"].as_str() {
                if !text.is_empty() {
                    let _ = app.emit("ai:delta", Delta { id: id.clone(), text: text.to_string() });
                }
            }
        }
        finish(None);
    });
}

use tauri::Manager;
