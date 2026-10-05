//! Files and folders: listing, reading, writing, and a watcher that tells the
//! page when something on disk changed (an AI agent in a terminal edits files
//! the editor is showing).

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const MAX_FILE: u64 = 24 * 1024 * 1024;
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", ".venv", "venv", "__pycache__", ".next", "dist", "build", ".DS_Store"];

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
}

#[derive(Serialize)]
pub struct FileContent {
    pub content: String,
    pub binary: bool,
    pub size: u64,
}

pub fn list_dir(path: &str) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(path).map_err(|e| format!("{path}: {e}"))? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let meta = entry.metadata();
        let is_symlink = entry.file_type().map(|t| t.is_symlink()).unwrap_or(false);
        let is_dir = fs::metadata(entry.path()).map(|m| m.is_dir()).unwrap_or(false);
        out.push(Entry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            is_symlink,
            size: meta.map(|m| m.len()).unwrap_or(0),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

pub fn read_file(path: &str) -> Result<FileContent, String> {
    let meta = fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
    if meta.len() > MAX_FILE {
        return Err(format!("{path} is larger than 24 MB"));
    }
    let bytes = fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    let probe = &bytes[..bytes.len().min(8192)];
    if probe.contains(&0) {
        return Ok(FileContent { content: String::new(), binary: true, size: meta.len() });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(FileContent { content, binary: false, size: meta.len() }),
        Err(_) => Ok(FileContent { content: String::new(), binary: true, size: meta.len() }),
    }
}

pub fn write_file(path: &str, content: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    fs::write(path, content).map_err(|e| format!("{path}: {e}"))
}

pub fn create(path: &str, is_dir: bool) -> Result<(), String> {
    if Path::new(path).exists() {
        return Err(format!("{path} already exists"));
    }
    if is_dir {
        fs::create_dir_all(path).map_err(|e| format!("{path}: {e}"))
    } else {
        write_file(path, "")
    }
}

pub fn rename(from: &str, to: &str) -> Result<(), String> {
    if Path::new(to).exists() {
        return Err(format!("{to} already exists"));
    }
    fs::rename(from, to).map_err(|e| format!("{from}: {e}"))
}

/// Moves the item to the Trash; deletes outright only when the Trash is on
/// another volume and the move fails.
pub fn delete(path: &str) -> Result<(), String> {
    let source = PathBuf::from(path);
    if !source.exists() && fs::symlink_metadata(&source).is_err() {
        return Err(format!("{path} does not exist"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        let trash = PathBuf::from(home).join(".Trash");
        if trash.is_dir() {
            let name = source.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "item".into());
            let mut target = trash.join(&name);
            let mut n = 1;
            while target.exists() {
                target = trash.join(format!("{name} {n}"));
                n += 1;
            }
            if fs::rename(&source, &target).is_ok() {
                return Ok(());
            }
        }
    }
    if source.is_dir() {
        fs::remove_dir_all(&source).map_err(|e| format!("{path}: {e}"))
    } else {
        fs::remove_file(&source).map_err(|e| format!("{path}: {e}"))
    }
}

pub fn reveal(path: &str) -> Result<(), String> {
    std::process::Command::new("open").arg("-R").arg(path).status().map(|_| ()).map_err(|e| e.to_string())
}

pub fn open_external(target: &str) -> Result<(), String> {
    std::process::Command::new("open").arg(target).status().map(|_| ()).map_err(|e| e.to_string())
}

/// Every file under `root` for quick-open. Uses git's index when the folder is
/// a repository so ignored files stay out; walks the tree otherwise.
pub fn walk(root: &str, limit: usize) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let git = crate::shell::command("git")
        .args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .current_dir(root)
        .output();
    if let Ok(o) = git {
        if o.status.success() {
            for rel in o.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()) {
                out.push(String::from_utf8_lossy(rel).to_string());
                if out.len() >= limit {
                    break;
                }
            }
            return Ok(out);
        }
    }
    fn visit(dir: &Path, root: &Path, out: &mut Vec<String>, limit: usize) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            if out.len() >= limit {
                return;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if path.is_dir() {
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                visit(&path, root, out, limit);
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().to_string());
            }
        }
    }
    let root_path = Path::new(root);
    visit(root_path, root_path, &mut out, limit);
    Ok(out)
}

/// Finds text in the project with `git grep` or plain `grep`.
#[derive(Serialize)]
pub struct Hit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

pub fn search(root: &str, query: &str, limit: usize) -> Result<Vec<Hit>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut cmd = crate::shell::command("grep");
    cmd.args(["-rnI", "--fixed-strings", "--ignore-case", "--color=never"]);
    for skip in SKIP_DIRS {
        cmd.arg(format!("--exclude-dir={skip}"));
    }
    cmd.arg("--").arg(query).arg(".").current_dir(root);
    let out = cmd.output().map_err(|e| e.to_string())?;
    let mut hits = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut parts = line.splitn(3, ':');
        let (Some(path), Some(no), Some(text)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let Ok(line_no) = no.parse::<u32>() else { continue };
        hits.push(Hit {
            path: path.trim_start_matches("./").to_string(),
            line: line_no,
            text: text.trim().chars().take(240).collect(),
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

// ---- watcher -------------------------------------------------------------

#[derive(Default)]
pub struct WatchState(pub Mutex<Option<RecommendedWatcher>>);

#[derive(Serialize, Clone)]
struct Changed {
    root: String,
    paths: Vec<String>,
}

/// Watches `root`, replacing any earlier watch. Changes are batched and sent
/// to the page as `fs:changed` (files) and `git:changed` (the .git folder).
pub fn watch(app: &AppHandle, state: &WatchState, root: &str) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<notify::Event>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let _ = tx.send(event);
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(Path::new(root), RecursiveMode::Recursive).map_err(|e| format!("cannot watch {root}: {e}"))?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);

    let app = app.clone();
    let root = root.to_string();
    std::thread::spawn(move || {
        let mut files: BTreeSet<String> = BTreeSet::new();
        let mut git_changed = false;
        let mut last = Instant::now();
        loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(event) => {
                    for path in event.paths {
                        let s = path.to_string_lossy().to_string();
                        if s.contains("/.git/") || s.ends_with("/.git") {
                            // Only index, HEAD and refs matter; ignore lock churn.
                            if !s.ends_with(".lock") {
                                git_changed = true;
                            }
                        } else if files.len() < 500 {
                            files.insert(s);
                        }
                    }
                    last = Instant::now();
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if (!files.is_empty() || git_changed) && last.elapsed() >= Duration::from_millis(250) {
                if !files.is_empty() {
                    let _ = app.emit("fs:changed", Changed { root: root.clone(), paths: files.iter().cloned().collect() });
                    files.clear();
                }
                if git_changed {
                    let _ = app.emit("git:changed", Changed { root: root.clone(), paths: Vec::new() });
                    git_changed = false;
                }
            }
        }
    });
    Ok(())
}
