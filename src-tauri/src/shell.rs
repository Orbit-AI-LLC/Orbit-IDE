//! The user's environment for subprocesses and terminals.
//!
//! A Mac app launched from Finder inherits a bare PATH, so `claude`, `codex`
//! and `grok` (installed under the home folder) would not be found. On macOS
//! and Linux the environment is read once from a login shell. On Windows the
//! process PATH is already the user's. Every subprocess and terminal gets the
//! PATH; agents get the whole login environment.

use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// The shell terminals run: the login shell on Unix, PowerShell on Windows.
pub fn user_shell() -> String {
    if cfg!(windows) {
        return "powershell.exe".to_string();
    }
    std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".to_string())
}

/// What the user's login shell exports (from `.zprofile`, `config.fish` and
/// the like), read once. Empty on Windows or when the shell can't be read.
pub fn login_env() -> &'static [(String, String)] {
    static ENV: OnceLock<Vec<(String, String)>> = OnceLock::new();
    ENV.get_or_init(|| if cfg!(windows) { Vec::new() } else { read_login_env(&user_shell()) })
}

const ENV_MARK: &str = "__ORBIT_IDE_ENV__";

/// Runs `shell` as a login shell to print its environment. The command is
/// two programs and a `;`, which every shell reads the same way, fish and
/// nushell included. The mark skips anything a profile prints first.
fn read_login_env(shell: &str) -> Vec<(String, String)> {
    let mut cmd = Command::new(shell);
    cmd.args(["-lc", &format!("printf {ENV_MARK}; /usr/bin/env -0")]).stdin(Stdio::null()).stderr(Stdio::null());
    for var in inherited_agent_vars() {
        cmd.env_remove(var);
    }
    cmd.output().map(|out| parse_env(&out.stdout)).unwrap_or_default()
}

fn parse_env(raw: &[u8]) -> Vec<(String, String)> {
    let text = String::from_utf8_lossy(raw);
    let Some(start) = text.find(ENV_MARK) else { return Vec::new() };
    text[start + ENV_MARK.len()..]
        .split('\0')
        .filter_map(|record| record.split_once('='))
        .filter(|(key, _)| !key.is_empty() && !key.contains('\n'))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

pub fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let sep = if cfg!(windows) { ';' } else { ':' };
        let from_shell = if cfg!(windows) {
            None
        } else {
            login_env().iter().find(|(key, _)| key == "PATH").map(|(_, value)| value.trim().to_string()).filter(|s| !s.is_empty()).or_else(|| {
                // A shell whose environment could not be listed may still print its PATH.
                Command::new(user_shell())
                    .args(["-lc", "printf '%s' \"$PATH\""])
                    .stdin(Stdio::null())
                    .output()
                    .ok()
                    .and_then(|o| String::from_utf8(o.stdout).ok())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            })
        };
        let mut parts: Vec<String> = Vec::new();
        let defaults: &[&str] = if cfg!(windows) { &[] } else { &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] };
        for p in from_shell
            .iter()
            .chain(std::env::var("PATH").ok().iter())
            .flat_map(|s| s.split(sep))
            .chain(defaults.iter().copied())
        {
            if !p.is_empty() && !parts.iter().any(|q| q == p) {
                parts.push(p.to_string());
            }
        }
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
        if let Some(home) = home {
            let home = home.to_string_lossy();
            let extras: Vec<String> = if cfg!(windows) {
                vec![format!("{home}\\.orbit\\bin"), format!("{home}\\.local\\bin"), format!("{home}\\.grok\\bin"), format!("{home}\\AppData\\Roaming\\npm"), format!("{home}\\.cargo\\bin")]
            } else {
                vec![format!("{home}/.orbit/bin"), format!("{home}/.local/bin"), format!("{home}/.grok/bin"), format!("{home}/.codex/bin"), format!("{home}/.cargo/bin")]
            };
            for extra in extras {
                if !parts.contains(&extra) {
                    parts.push(extra);
                }
            }
        }
        parts.join(&sep.to_string())
    })
}

/// Variables that mark a process as living inside an agent's session. When
/// Orbit IDE itself was launched from such a session (a developer running it
/// from Claude Code, say) they would be inherited and make the agents inside
/// think they are nested: transcripts off, resume refused.
pub fn inherited_agent_vars() -> Vec<String> {
    std::env::vars_os()
        .filter_map(|(k, _)| k.into_string().ok())
        .filter(|k| k.starts_with("CLAUDE") || k.starts_with("CODEX_SANDBOX") || k.starts_with("GROK_SESSION"))
        .collect()
}

/// A command that sees the same PATH as the user's terminal, and none of
/// the session markers described above. On Windows a program that is not an
/// `.exe` runs through `cmd.exe` so `.cmd` launchers (the npm-installed CLIs)
/// resolve.
pub fn command(program: &str) -> Command {
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        // An .exe such as git runs directly: cmd.exe would parse its arguments
        // again, and & | < > ^ % in a file name or commit message act as syntax.
        let mut cmd = match which(program).filter(|p| p.to_ascii_lowercase().ends_with(".exe")) {
            Some(exe) => Command::new(exe),
            None => {
                let mut cmd = Command::new("cmd.exe");
                cmd.args(["/d", "/c", program]);
                cmd
            }
        };
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new(program);
    cmd.env("PATH", login_path());
    for var in inherited_agent_vars() {
        cmd.env_remove(var);
    }
    cmd
}

/// Where `program` lives on the login PATH, if anywhere.
pub fn which(program: &str) -> Option<String> {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{program}.exe"), format!("{program}.cmd"), format!("{program}.bat"), program.to_string()]
    } else {
        vec![program.to_string()]
    };
    for dir in login_path().split(sep) {
        for name in &names {
            let candidate = std::path::Path::new(dir).join(name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn the_environment_is_read_past_whatever_a_profile_prints() {
        let raw = format!("Welcome back!\n{ENV_MARK}PATH=/opt/homebrew/bin:/usr/bin\0EMPTY=\0EQ=a=b\0MULTI=line one\nline two\0");
        assert_eq!(
            parse_env(raw.as_bytes()),
            vec![
                ("PATH".to_string(), "/opt/homebrew/bin:/usr/bin".to_string()),
                ("EMPTY".to_string(), String::new()),
                ("EQ".to_string(), "a=b".to_string()),
                ("MULTI".to_string(), "line one\nline two".to_string()),
            ]
        );
        assert!(parse_env(b"PATH=/usr/bin\0").is_empty(), "no mark, no environment");
    }

    #[test]
    fn a_login_shell_reports_its_environment() {
        for shell in ["/bin/sh", "/bin/zsh"] {
            if !std::path::Path::new(shell).exists() {
                continue;
            }
            let env = read_login_env(shell);
            let path = env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.as_str()).unwrap_or("");
            assert!(path.contains("/usr/bin"), "{shell}: PATH={path:?}");
            // Markers of an agent session Orbit IDE was started from stay out.
            for (key, _) in std::env::vars() {
                if inherited_agent_vars().contains(&key) {
                    assert!(!env.iter().any(|(k, _)| *k == key), "{shell} passed on {key}");
                }
            }
        }
    }
}
