//! The user's login environment. A Mac app launched from Finder inherits a
//! bare PATH, so `claude`, `codex` and `grok` (installed under the home folder)
//! would not be found. The PATH is read once from a login shell and applied to
//! every subprocess and terminal Orbit IDE starts.

use std::process::Command;
use std::sync::OnceLock;

pub fn user_shell() -> String {
    std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".to_string())
}

pub fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let from_shell = Command::new(user_shell())
            .args(["-lc", "printf '%s' \"$PATH\""])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let mut parts: Vec<String> = Vec::new();
        for p in from_shell
            .iter()
            .chain(std::env::var("PATH").ok().iter())
            .flat_map(|s| s.split(':'))
            .chain(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
        {
            if !p.is_empty() && !parts.iter().any(|q| q == p) {
                parts.push(p.to_string());
            }
        }
        if let Some(home) = std::env::var_os("HOME") {
            let home = home.to_string_lossy();
            for extra in [format!("{home}/.local/bin"), format!("{home}/.grok/bin"), format!("{home}/.codex/bin"), format!("{home}/.cargo/bin")] {
                if !parts.contains(&extra) {
                    parts.push(extra);
                }
            }
        }
        parts.join(":")
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
/// the session markers described above.
pub fn command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("PATH", login_path());
    for var in inherited_agent_vars() {
        cmd.env_remove(var);
    }
    cmd
}

/// Where `program` lives on the login PATH, if anywhere.
pub fn which(program: &str) -> Option<String> {
    for dir in login_path().split(':') {
        let candidate = std::path::Path::new(dir).join(program);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}
