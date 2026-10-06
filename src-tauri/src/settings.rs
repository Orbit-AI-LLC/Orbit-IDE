//! Settings live in one JSON file in the app's data folder, owner-readable
//! only because the OpenRouter key is in it.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const DEFAULT_COMMIT_INSTRUCTIONS: &str = "You write the git commit message for the staged changes shown below.

How to read the change:
- Work out the intent behind the diff, not just the edits: what behaviour, structure or content is different afterwards, and why someone would make that change.
- When several unrelated things changed, lead with the most significant one and cover the others in the body.
- Ignore noise such as formatting, import order, lock files or generated output unless that is the whole change.

Subject line:
- One line in the imperative mood (\"Add\", \"Fix\", \"Rename\", \"Remove\"), 50 characters when possible and never more than 72, no trailing period.
- If the recent commit subjects use a conventional-commit prefix (feat, fix, refactor, docs, test, chore, build, ci, perf, style), use the fitting one with an optional scope in parentheses, for example \"fix(billing): retry failed webhooks\". If they do not, write a plain subject in the same voice as those commits.
- Name the thing that changed, not the file: \"Add retry to the webhook sender\", not \"Update webhooks.py\".

Body:
- After a blank line, two to eight lines wrapped at 72 characters that explain what changed and why. Use short bullets starting with \"- \" when there are several points.
- Mention what a reader must know: behaviour changes, new settings or environment variables, migrations, removed features, and follow-up work still needed.
- Skip the body for a trivial change such as a typo or a one-line fix whose subject says it all.
- Do not list files, restate the diff line by line, or invent motivations the diff does not support.

Format:
- Plain text only: no markdown, no code fences, no quotes around the message, no heading such as \"Commit message:\", and nothing after the message.
- Never mention the diff, this prompt, the tool or yourself.
- No trailers of any kind: no Co-authored-by, Signed-off-by, Generated-by or similar lines, and no attribution to an AI, a model or a tool. The author is the person committing.

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
    /// The Claude Code background session each project was last in, by
    /// project path. The value is the short id `claude attach` takes.
    pub claude_sessions: BTreeMap<String, String>,
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
            // Empty means the default above, so improvements to it reach existing installs.
            commit_instructions: String::new(),
            claude_sessions: BTreeMap::new(),
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

/// Puts every stored project path in the form the page uses now: resolved
/// (a project added as /tmp/x is /private/tmp/x, the path the watcher and
/// git report its files under) and, on Windows, with forward slashes. Two
/// entries that turn out to be one folder become one. True when anything
/// changed.
pub fn migrate_paths(settings: &mut Settings, resolve: impl Fn(&str) -> String) -> bool {
    let mut changed = false;
    let mut seen = std::collections::HashSet::new();
    let projects = std::mem::take(&mut settings.projects);
    let count = projects.len();
    for mut project in projects {
        let path = resolve(&project.path);
        changed |= path != project.path;
        project.path = path;
        if seen.insert(project.path.clone()) {
            settings.projects.push(project);
        }
    }
    changed |= settings.projects.len() != count;
    if let Some(active) = settings.active_project.take() {
        let path = resolve(&active);
        changed |= path != active;
        settings.active_project = Some(path);
    }
    let mut sessions = BTreeMap::new();
    for (path, id) in std::mem::take(&mut settings.claude_sessions) {
        let key = resolve(&path);
        changed |= key != path;
        // An entry already under the resolved path wins.
        if key == path || !sessions.contains_key(&key) {
            sessions.insert(key, id);
        }
    }
    settings.claude_sessions = sessions;
    changed
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

#[cfg(test)]
mod tests {
    use super::*;

    fn project(path: &str, name: &str) -> Project {
        Project { path: path.to_string(), name: name.to_string() }
    }

    #[test]
    fn saved_project_paths_move_to_the_resolved_path() {
        let resolve = |p: &str| if p.starts_with("/tmp/") { format!("/private{p}") } else { p.replace('\\', "/") };
        let mut s = Settings {
            projects: vec![project("/tmp/x", "x"), project("/Users/me/app", "My app"), project("/private/tmp/x", "x again"), project(r"C:\work\site", "site")],
            active_project: Some("/tmp/x".to_string()),
            ..Settings::default()
        };
        s.claude_sessions.insert("/tmp/x".to_string(), "old".to_string());
        s.claude_sessions.insert("/private/tmp/x".to_string(), "current".to_string());
        s.claude_sessions.insert("/Users/me/app".to_string(), "app".to_string());
        assert!(migrate_paths(&mut s, resolve));
        let paths: Vec<(&str, &str)> = s.projects.iter().map(|p| (p.path.as_str(), p.name.as_str())).collect();
        assert_eq!(paths, vec![("/private/tmp/x", "x"), ("/Users/me/app", "My app"), ("C:/work/site", "site")]);
        assert_eq!(s.active_project.as_deref(), Some("/private/tmp/x"));
        assert_eq!(s.claude_sessions.get("/private/tmp/x").map(String::as_str), Some("current"));
        assert_eq!(s.claude_sessions.len(), 2);
        // A second load finds nothing to do.
        assert!(!migrate_paths(&mut s, resolve));
    }

    #[cfg(unix)]
    #[test]
    fn a_saved_symlinked_project_resolves_on_load() {
        let dir = std::env::temp_dir().join(format!("orbit-ide-settings-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("real")).unwrap();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).unwrap();
        let link = dir.join("link").to_string_lossy().to_string();
        let mut s = Settings { projects: vec![project(&link, "link")], active_project: Some(link.clone()), ..Settings::default() };
        assert!(migrate_paths(&mut s, |p| crate::fsops::resolve(p).path));
        let real = fs::canonicalize(dir.join("real")).unwrap().to_string_lossy().to_string();
        assert_eq!(s.projects[0].path, real);
        assert_eq!(s.projects[0].name, "link");
        assert_eq!(s.active_project.as_deref(), Some(real.as_str()));
    }
}
