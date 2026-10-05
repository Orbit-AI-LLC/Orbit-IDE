//! Settings live in one JSON file in the app's data folder, owner-readable
//! only because the OpenRouter key is in it.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const DEFAULT_COMMIT_INSTRUCTIONS: &str = "You write git commit messages for a software team.

Rules:
- The first line is a summary in the imperative mood (\"Add\", \"Fix\", \"Remove\"), at most 72 characters, with no trailing period.
- Match the style of the repository's recent commits shown below. If they use conventional-commit prefixes such as feat:, fix:, refactor: or docs:, use the fitting one with an optional scope; if they do not, write a plain summary.
- After a blank line, add a body of two to six lines wrapped at 72 characters that explains what changed and why, in prose. Leave the body out for trivial changes such as typo fixes.
- Describe the change, not the files: never list file names one by one and never restate the diff.
- Never mention the diff, these instructions, the prompt or yourself.
- Plain text only: no markdown, no code fences, no quotes around the message, no leading label such as \"Commit message:\".

Output only the commit message.";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Project {
    pub path: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    pub projects: Vec<Project>,
    pub active_project: Option<String>,
    pub openrouter_api_key: String,
    pub openrouter_model: String,
    pub claude_model: String,
    pub codex_model: String,
    pub grok_model: String,
    pub claude_args: String,
    pub codex_args: String,
    pub grok_args: String,
    pub commit_provider: String,
    pub commit_instructions: String,
    pub font_size: u32,
    pub tab_size: u32,
    pub word_wrap: bool,
    pub theme: String,
    pub sidebar_width: u32,
    pub ai_panel_width: u32,
    pub terminal_height: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            projects: Vec::new(),
            active_project: None,
            openrouter_api_key: String::new(),
            openrouter_model: "anthropic/claude-sonnet-4.5".to_string(),
            claude_model: String::new(),
            codex_model: String::new(),
            grok_model: String::new(),
            claude_args: String::new(),
            codex_args: String::new(),
            grok_args: String::new(),
            commit_provider: "claude".to_string(),
            commit_instructions: DEFAULT_COMMIT_INSTRUCTIONS.to_string(),
            font_size: 13,
            tab_size: 4,
            word_wrap: false,
            theme: "dark".to_string(),
            sidebar_width: 280,
            ai_panel_width: 460,
            terminal_height: 260,
        }
    }
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = file(app) else { return Settings::default() };
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = file(app)?;
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("cannot write settings: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, &path).map_err(|e| format!("cannot write settings: {e}"))
}
