//! The user's environment for subprocesses and terminals.
//!
//! A Mac app launched from Finder inherits a bare PATH, so `claude`, `codex`
//! and `grok` (installed under the home folder) would not be found. On macOS
//! and Linux the PATH is read once from a login shell. On Windows the
//! process PATH is already the user's. Every subprocess and terminal gets it.

use std::process::Command;
use std::sync::OnceLock;

/// The shell terminals run: the login shell on Unix, PowerShell on Windows.
pub fn user_shell() -> String {
    if cfg!(windows) {
        return "powershell.exe".to_string();
    }
    std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".to_string())
}

pub fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let sep = if cfg!(windows) { ';' } else { ':' };
        let from_shell = if cfg!(windows) {
            None
        } else {
            Command::new(user_shell())
                .args(["-lc", "printf '%s' \"$PATH\""])
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
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
                vec![format!("{home}\\.local\\bin"), format!("{home}\\.grok\\bin"), format!("{home}\\AppData\\Roaming\\npm"), format!("{home}\\.cargo\\bin")]
            } else {
                vec![format!("{home}/.local/bin"), format!("{home}/.grok/bin"), format!("{home}/.codex/bin"), format!("{home}/.cargo/bin")]
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
/// the session markers described above. On Windows the program runs through
/// `cmd.exe` so `.cmd` launchers (the npm-installed CLIs) resolve.
pub fn command(program: &str) -> Command {
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/d", "/c", program]);
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
