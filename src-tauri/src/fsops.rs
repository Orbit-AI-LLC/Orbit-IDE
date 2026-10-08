//! Files and folders: listing, reading, writing, and a watcher that tells the
//! page when something on disk changed (an AI agent in a terminal edits files
//! the editor is showing).

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use regex::{NoExpand, Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const MAX_FILE: u64 = 24 * 1024 * 1024;
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", ".venv", "venv", "__pycache__", ".next", "dist", "build", ".DS_Store"];

// ---- paths ---------------------------------------------------------------

/// A path as the page writes it. The page joins and splits paths on `/`, so
/// on Windows every path sent to it uses forward slashes; Windows accepts
/// them back. Elsewhere the path is unchanged.
pub fn page_path(path: &Path) -> String {
    page_string(&path.to_string_lossy(), cfg!(windows))
}

fn page_string(path: &str, windows: bool) -> String {
    if windows { path.replace('\\', "/") } else { path.to_string() }
}

/// A path from the page in the platform's own form, for the few Windows
/// programs (Explorer, the shell's file operations) that insist on `\`.
pub fn native_path(path: &str) -> String {
    if cfg!(windows) { path.replace('/', "\\") } else { path.to_string() }
}

/// On Windows `canonicalize` gives `\\?\C:\...`, which most programs and the
/// page cannot use. The plain form, or None for a path that has none.
fn strip_verbatim(path: &str) -> Option<String> {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return Some(format!(r"\\{unc}"));
    }
    match path.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => Some(rest.to_string()),
        Some(_) => None,
        None => Some(path.to_string()),
    }
}

/// The real path: symlinks resolved, `..` gone, and on the Mac the case the
/// disk uses. None when the path does not exist.
fn canonical(path: &Path) -> Option<PathBuf> {
    let real = fs::canonicalize(path).ok()?;
    strip_verbatim(&real.to_string_lossy()).map(PathBuf::from)
}

#[derive(Serialize, Debug)]
pub struct Resolved {
    /// The path with symlinks resolved (for a file, its folder's), as the
    /// page writes paths. The watcher and git report resolved paths, so a
    /// project known by this path matches what they report.
    pub path: String,
    /// The name of the item as given: a project linked under another name
    /// still shows by the folder name the user picked.
    pub name: String,
    pub is_dir: bool,
}

pub fn resolve(path: &str) -> Resolved {
    let given = Path::new(path);
    let is_dir = given.is_dir();
    let real = if is_dir {
        canonical(given)
    } else {
        // A file keeps its own name: only the folders above it resolve.
        match (given.parent(), given.file_name()) {
            (Some(dir), Some(name)) if !dir.as_os_str().is_empty() => canonical(dir).map(|d| d.join(name)),
            _ => None,
        }
    };
    let real = real.unwrap_or_else(|| given.components().collect());
    let name = given.file_name().or_else(|| real.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| page_path(&real));
    Resolved { path: page_path(&real), name, is_dir }
}

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
            path: page_path(&entry.path()),
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
    if Path::new(to).exists() && !is_case_change(from, to) {
        return Err(format!("{to} already exists"));
    }
    fs::rename(from, to).map_err(|e| format!("{from}: {e}"))
}

/// On a case-insensitive disk (the Mac's default) `readme.md` to `README.md`
/// finds `to` already there: it is `from` itself, so the rename is fine. The
/// folder listing tells the two apart from a real second file.
fn is_case_change(from: &str, to: &str) -> bool {
    let (from, to) = (Path::new(from), Path::new(to));
    let (Some(old), Some(new), Some(dir)) = (from.file_name(), to.file_name(), to.parent()) else { return false };
    from.parent() == Some(dir)
        && old != new
        && old.to_string_lossy().to_lowercase() == new.to_string_lossy().to_lowercase()
        && fs::read_dir(dir).map(|entries| !entries.flatten().any(|e| e.file_name() == new)).unwrap_or(false)
}

const TRASH: &str = if cfg!(windows) { "Recycle Bin" } else { "Trash" };

/// Moves the item to the Trash (the Recycle Bin on Windows) the way Finder
/// does, which on another disk means that disk's own Trash. When the system
/// cannot, the item stays where it is and the error says so: this never
/// deletes anything outright.
pub fn delete(path: &str) -> Result<(), String> {
    trash_with(Path::new(path), move_to_trash)
}

fn trash_with(path: &Path, trash: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
    if fs::symlink_metadata(path).is_err() {
        return Err(format!("{} does not exist", path.display()));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.display().to_string());
    trash(path).map_err(|why| {
        let why = why.trim();
        let note = format!("Couldn't move {name} to the {TRASH}. It is still in place.");
        if why.is_empty() { note } else { format!("{note} {why}") }
    })
}

#[cfg(target_os = "macos")]
fn move_to_trash(path: &Path) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    objc2::rc::autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        NSFileManager::defaultManager().trashItemAtURL_resultingItemURL_error(&url, None).map_err(|err| err.localizedDescription().to_string())
    })
}

#[cfg(windows)]
fn move_to_trash(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOF_WANTNUKEWARNING, FO_DELETE, SHFILEOPSTRUCTW};
    // A full path with backslashes, ended by two NULs. Where the Recycle Bin
    // cannot take the item (a network drive, say), the nuke warning makes
    // Windows ask before it deletes instead; a No leaves it in place.
    let native = native_path(&path.to_string_lossy());
    let mut from: Vec<u16> = std::ffi::OsStr::new(&native).encode_wide().collect();
    from.extend([0, 0]);
    let mut op = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT | FOF_WANTNUKEWARNING) as u16,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    // SAFETY: `op` and the buffer it points to outlive the call.
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        return Err(format!("Windows error {code:#x}."));
    }
    if op.fAnyOperationsAborted != 0 {
        return Err("The Recycle Bin can't take it.".to_string());
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn move_to_trash(path: &Path) -> Result<(), String> {
    let out = crate::shell::command("gio").arg("trash").arg(path).output().map_err(|e| format!("gio: {e}"))?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

pub fn reveal(path: &str) -> Result<(), String> {
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg("-R").arg(path).status()
    } else if cfg!(windows) {
        std::process::Command::new("explorer.exe").arg(format!("/select,{}", native_path(path))).status()
    } else {
        let dir = Path::new(path).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());
        std::process::Command::new("xdg-open").arg(dir).status()
    };
    status.map(|_| ()).map_err(|e| e.to_string())
}

pub fn open_external(target: &str) -> Result<(), String> {
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(target).status()
    } else if cfg!(windows) {
        std::process::Command::new("cmd.exe").args(["/d", "/c", "start", "", target]).status()
    } else {
        std::process::Command::new("xdg-open").arg(target).status()
    };
    status.map(|_| ()).map_err(|e| e.to_string())
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
                out.push(page_path(rel));
            }
        }
    }
    let root_path = Path::new(root);
    visit(root_path, root_path, &mut out, limit);
    Ok(out)
}

// ---- find and replace in the project -----------------------------------------

/// Text files bigger than this aren't searched.
const MAX_SEARCHED: u64 = 2 * 1024 * 1024;

/// How the page's search box reads its text: as typed, in any case unless
/// `case`, or as a regular expression with `regex`.
#[derive(Deserialize, Default, Clone, Copy)]
pub struct FindOptions {
    #[serde(default)]
    pub case: bool,
    #[serde(default)]
    pub regex: bool,
}

/// The search as a regular expression, or None for an empty one.
fn matcher(query: &str, options: FindOptions) -> Result<Option<Regex>, String> {
    if query.is_empty() {
        return Ok(None);
    }
    let pattern = if options.regex { query.to_string() } else { regex::escape(query) };
    let re = RegexBuilder::new(&pattern)
        .case_insensitive(!options.case)
        .build()
        .map_err(|e| format!("That isn't a regular expression Orbit IDE can read: {}", e.to_string().lines().last().unwrap_or("").trim_start_matches("error: ")))?;
    // One that matches nothing at all (`x*`, `^`) would match on every line,
    // and a replace would write between every character.
    if re.is_match("") {
        return Err("That regular expression matches empty text; make it match at least one character.".into());
    }
    Ok(Some(re))
}

/// Every file search and replace look in, in order: below `root`, outside
/// generated folders and .git, at most `MAX_SEARCHED`, with no NUL in its
/// first 8 KB (binary). Symlinks aren't followed, so a replace never writes
/// outside the project and a link to a parent folder can't loop. `each` gets
/// the path and the bytes, and returns false to stop.
fn text_files(root: &Path, each: &mut dyn FnMut(&Path, &[u8]) -> bool) {
    fn visit(dir: &Path, each: &mut dyn FnMut(&Path, &[u8]) -> bool) -> bool {
        let Ok(entries) = fs::read_dir(dir) else { return true };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                let name = entry.file_name();
                if SKIP_DIRS.iter().any(|skip| name == *skip) {
                    continue;
                }
                if !visit(&path, each) {
                    return false;
                }
            } else if kind.is_file() {
                if entry.metadata().map_or(true, |meta| meta.len() > MAX_SEARCHED) {
                    continue;
                }
                let Ok(bytes) = fs::read(&path) else { continue };
                if bytes[..bytes.len().min(8192)].contains(&0) {
                    continue;
                }
                if !each(&path, &bytes) {
                    return false;
                }
            }
        }
        true
    }
    visit(root, each);
}

/// A text's lines, each with its ending (`\n`, `\r\n`, or none on the last),
/// so a replace writes back the endings it read.
fn lines_with_endings(text: &str) -> impl Iterator<Item = (&str, &str)> {
    text.split_inclusive('\n').map(|piece| {
        let content = piece.strip_suffix('\n').map_or(piece, |line| line.strip_suffix('\r').unwrap_or(line));
        (content, &piece[content.len()..])
    })
}

#[derive(Serialize)]
pub struct Hit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

/// Lines in the project that match, up to `limit`. Files open with unsaved
/// changes (`unsaved`, by page path) are searched as the editor has them.
pub fn search(root: &str, query: &str, options: FindOptions, unsaved: &HashMap<String, String>, limit: usize) -> Result<Vec<Hit>, String> {
    let Some(re) = matcher(query, options)? else { return Ok(Vec::new()) };
    let root_path = Path::new(root);
    let mut hits = Vec::new();
    text_files(root_path, &mut |path, bytes| {
        let rel = path.strip_prefix(root_path).map(page_path).unwrap_or_default();
        let text = match unsaved.get(&rel) {
            Some(text) => std::borrow::Cow::Borrowed(text.as_str()),
            None => String::from_utf8_lossy(bytes),
        };
        for (i, (line, _)) in lines_with_endings(&text).enumerate() {
            if re.is_match(line) {
                hits.push(Hit { path: rel.clone(), line: i as u32 + 1, text: line.trim().chars().take(240).collect() });
                if hits.len() >= limit {
                    return false;
                }
            }
        }
        true
    });
    Ok(hits)
}

/// `text` with every match replaced, line by line as search finds them, and
/// how many there were. With `regex`, `$1` and `${name}` put in what a group
/// matched (`$$` is a dollar sign); plain text goes in as it is.
fn replace_in_text(text: &str, re: &Regex, replacement: &str, options: FindOptions) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut count = 0;
    for (line, ending) in lines_with_endings(text) {
        let found = re.find_iter(line).count();
        if found == 0 {
            out.push_str(line);
        } else if options.regex {
            out.push_str(&re.replace_all(line, replacement));
        } else {
            out.push_str(&re.replace_all(line, NoExpand(replacement)));
        }
        count += found;
        out.push_str(ending);
    }
    (out, count)
}

/// A replace across the project, from the page.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRequest {
    pub root: String,
    pub query: String,
    pub replacement: String,
    #[serde(default)]
    pub options: FindOptions,
    /// Only these files (page paths below the root), for a replace in one file.
    #[serde(default)]
    pub only: Option<Vec<String>>,
    /// Files open with unsaved changes, by page path, and the text the editor
    /// has: they are replaced in that text, which comes back for the editor,
    /// and are not written.
    #[serde(default)]
    pub unsaved: HashMap<String, String>,
    /// Count only; write nothing.
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Replaced {
    /// Files with replacements (written, unless a dry run or unsaved), as page paths.
    pub files: Vec<String>,
    pub replacements: usize,
    /// Files with matches that were left alone: they aren't UTF-8, so
    /// writing them back would change more than the matches.
    pub skipped: Vec<String>,
    /// The new text of each unsaved file that had matches, for the editor.
    pub unsaved: HashMap<String, String>,
    /// Files that couldn't be written, and why.
    pub failed: Vec<String>,
}

pub fn replace(request: ReplaceRequest) -> Result<Replaced, String> {
    let Some(re) = matcher(&request.query, request.options)? else { return Ok(Replaced::default()) };
    let root = Path::new(&request.root);
    let mut done = Replaced::default();
    text_files(root, &mut |path, bytes| {
        let rel = path.strip_prefix(root).map(page_path).unwrap_or_default();
        if request.only.as_ref().is_some_and(|only| !only.contains(&rel)) {
            return true;
        }
        if let Some(text) = request.unsaved.get(&rel) {
            let (new, count) = replace_in_text(text, &re, &request.replacement, request.options);
            if count > 0 {
                done.files.push(rel.clone());
                done.replacements += count;
                done.unsaved.insert(rel, new);
            }
            return true;
        }
        let Ok(text) = std::str::from_utf8(bytes) else {
            if lines_with_endings(&String::from_utf8_lossy(bytes)).any(|(line, _)| re.is_match(line)) {
                done.skipped.push(rel);
            }
            return true;
        };
        let (new, count) = replace_in_text(text, &re, &request.replacement, request.options);
        if count == 0 {
            return true;
        }
        if !request.dry_run && new != text {
            if let Err(e) = fs::write(path, &new) {
                done.failed.push(format!("{rel}: {e}"));
                return true;
            }
        }
        done.files.push(rel);
        done.replacements += count;
        true
    });
    Ok(done)
}

// ---- watcher -------------------------------------------------------------

#[derive(Default)]
pub struct WatchState(pub Mutex<Option<RecommendedWatcher>>);

#[derive(Serialize, Clone)]
struct Changed {
    root: String,
    paths: Vec<String>,
    /// More files changed than one batch lists (a checkout, a formatter run
    /// over the tree): the page rechecks every open file and the whole tree.
    overflow: bool,
}

/// Build output and installed dependencies. A build writes thousands of
/// files there, which would crowd the files the editor shows out of a batch.
const IGNORED_DIRS: &[&str] = &["node_modules", "target", "dist", "build", ".next", "__pycache__", ".venv"];

/// Past this many files a batch stops listing them and asks for a recheck.
const BATCH_CAP: usize = 500;

#[derive(Debug, PartialEq)]
enum Kind {
    /// The .git folder: the index, HEAD or a ref moved.
    Git,
    /// Lock files in .git and anything inside build output.
    Ignored,
    File,
}

/// What a changed path means to the page, by its path components below the
/// project, so it reads the same with `/` or `\` and wherever the project is.
fn classify(roots: &[PathBuf], path: &Path) -> Kind {
    let (rel, under_root) = match roots.iter().find_map(|root| path.strip_prefix(root).ok()) {
        Some(rel) => (rel, true),
        None => (path, false),
    };
    let names: Vec<&std::ffi::OsStr> = rel.components().filter_map(|c| if let Component::Normal(name) = c { Some(name) } else { None }).collect();
    if names.iter().any(|name| *name == ".git") {
        // Only the index, HEAD and refs matter; git's lock files come and go.
        let lock = names.last().is_some_and(|name| name.to_string_lossy().ends_with(".lock"));
        return if lock { Kind::Ignored } else { Kind::Git };
    }
    // Files inside build output. The folder itself, made or removed, stays:
    // the tree shows it.
    let parents = &names[..names.len().saturating_sub(1)];
    if under_root && parents.iter().any(|name| IGNORED_DIRS.iter().any(|dir| *name == *dir)) {
        return Kind::Ignored;
    }
    Kind::File
}

/// The changes gathered between two messages to the page.
#[derive(Default)]
struct Batch {
    files: BTreeSet<String>,
    overflow: bool,
    git: bool,
}

impl Batch {
    /// Adds a changed path; true when the page needs to hear about it.
    fn add(&mut self, roots: &[PathBuf], path: &Path) -> bool {
        match classify(roots, path) {
            Kind::Ignored => false,
            Kind::Git => {
                self.git = true;
                true
            }
            Kind::File => {
                if !self.overflow {
                    let path = page_path(path);
                    if self.files.len() < BATCH_CAP || self.files.contains(&path) {
                        self.files.insert(path);
                    } else {
                        // Never drop a file silently: the page rechecks them all.
                        self.overflow = true;
                        self.files.clear();
                    }
                }
                true
            }
        }
    }

    fn is_empty(&self) -> bool {
        self.files.is_empty() && !self.overflow && !self.git
    }
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
    // Events name resolved paths; the project's path is resolved when it is
    // added, but a folder that was missing then may not be.
    let mut roots = vec![PathBuf::from(&root)];
    roots.extend(canonical(Path::new(&root)).filter(|real| *real != roots[0]));
    std::thread::spawn(move || {
        let mut batch = Batch::default();
        let mut first = Instant::now();
        let mut last = Instant::now();
        loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(event) => {
                    for path in event.paths {
                        let was_empty = batch.is_empty();
                        // Only changes the page cares about hold the batch back:
                        // a build writing to target/ must not delay an edit.
                        if batch.add(&roots, &path) {
                            if was_empty {
                                first = Instant::now();
                            }
                            last = Instant::now();
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            // Send once things go quiet, and at least every 1.5 seconds while an
            // agent writes without a pause.
            let due = last.elapsed() >= Duration::from_millis(250) || first.elapsed() >= Duration::from_millis(1500);
            if !batch.is_empty() && due {
                let done = std::mem::take(&mut batch);
                if done.overflow || !done.files.is_empty() {
                    let _ = app.emit("fs:changed", Changed { root: root.clone(), paths: done.files.into_iter().collect(), overflow: done.overflow });
                }
                if done.git {
                    let _ = app.emit("git:changed", Changed { root: root.clone(), paths: Vec::new(), overflow: false });
                }
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("orbit-ide-fsops-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn request(root: &Path, query: &str, replacement: &str, options: FindOptions) -> ReplaceRequest {
        ReplaceRequest {
            root: root.to_string_lossy().to_string(),
            query: query.into(),
            replacement: replacement.into(),
            options,
            only: None,
            unsaved: HashMap::new(),
            dry_run: false,
        }
    }

    #[test]
    fn replace_changes_exactly_what_search_finds() {
        let dir = tmp("replace");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules/x")).unwrap();
        fs::write(dir.join("src/a.rs"), "let Total = total();\r\nlet other = 1;\r\nTOTAL\n").unwrap();
        fs::write(dir.join("b.txt"), "no match here").unwrap();
        fs::write(dir.join("node_modules/x/c.js"), "total").unwrap();
        let root = dir.to_str().unwrap();

        let hits = search(root, "total", FindOptions::default(), &HashMap::new(), 100).unwrap();
        assert_eq!(hits.iter().map(|h| (h.path.as_str(), h.line)).collect::<Vec<_>>(), vec![("src/a.rs", 1), ("src/a.rs", 3)]);
        assert_eq!(search(root, "Total", FindOptions { case: true, regex: false }, &HashMap::new(), 100).unwrap().len(), 1);

        // A dry run counts and writes nothing.
        let counted = replace(ReplaceRequest { dry_run: true, ..request(&dir, "total", "sum", FindOptions::default()) }).unwrap();
        assert_eq!((counted.files.clone(), counted.replacements), (vec!["src/a.rs".to_string()], 3));
        assert!(fs::read_to_string(dir.join("src/a.rs")).unwrap().contains("Total"));

        let done = replace(request(&dir, "total", "sum", FindOptions::default())).unwrap();
        assert_eq!(done.replacements, 3);
        // Line endings stay as they were; generated folders are left alone.
        assert_eq!(fs::read_to_string(dir.join("src/a.rs")).unwrap(), "let sum = sum();\r\nlet other = 1;\r\nsum\n");
        assert_eq!(fs::read_to_string(dir.join("node_modules/x/c.js")).unwrap(), "total");
        assert!(search(root, "total", FindOptions::default(), &HashMap::new(), 100).unwrap().is_empty());
    }

    #[test]
    fn regular_expressions_bring_in_groups_and_plain_text_goes_in_as_it_is() {
        let dir = tmp("replace-regex");
        fs::write(dir.join("a.py"), "def get_name(self):\n    return self.get_name_value()\n").unwrap();
        let regex = FindOptions { case: true, regex: true };
        replace(request(&dir, r"get_(\w+)\(", "fetch_$1(", regex)).unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.py")).unwrap(), "def fetch_name(self):\n    return self.fetch_name_value()\n");
        replace(request(&dir, "fetch_name(", "$1 costs $5", FindOptions::default())).unwrap();
        assert!(fs::read_to_string(dir.join("a.py")).unwrap().starts_with("def $1 costs $5self):"));
    }

    #[test]
    fn unsaved_files_are_replaced_in_the_editor_text_and_not_written() {
        let dir = tmp("replace-unsaved");
        fs::write(dir.join("open.js"), "old on disk").unwrap();
        fs::write(dir.join("other.js"), "old").unwrap();
        let mut unsaved = HashMap::new();
        unsaved.insert("open.js".to_string(), "old, old, edited".to_string());
        let done = replace(ReplaceRequest { unsaved, ..request(&dir, "old", "new", FindOptions::default()) }).unwrap();
        assert_eq!(done.replacements, 3);
        assert_eq!(done.unsaved.get("open.js").map(String::as_str), Some("new, new, edited"));
        assert_eq!(fs::read_to_string(dir.join("open.js")).unwrap(), "old on disk");
        // Search sees the editor's text too.
        let mut editor = HashMap::new();
        editor.insert("open.js".to_string(), "fresh\nnew line".to_string());
        let hits = search(dir.to_str().unwrap(), "new", FindOptions::default(), &editor, 10).unwrap();
        assert_eq!(hits.iter().map(|h| (h.path.as_str(), h.line)).collect::<Vec<_>>(), vec![("open.js", 2), ("other.js", 1)]);
        assert_eq!(fs::read_to_string(dir.join("other.js")).unwrap(), "new");
        // One file only.
        fs::write(dir.join("other.js"), "old").unwrap();
        fs::write(dir.join("third.js"), "old").unwrap();
        let one = replace(ReplaceRequest { only: Some(vec!["third.js".into()]), ..request(&dir, "old", "new", FindOptions::default()) }).unwrap();
        assert_eq!(one.files, vec!["third.js".to_string()]);
        assert_eq!(fs::read_to_string(dir.join("other.js")).unwrap(), "old");
    }

    #[test]
    fn files_that_are_not_utf8_and_links_out_of_the_project_are_left_alone() {
        let dir = tmp("replace-skip");
        let outside = tmp("replace-outside");
        fs::write(outside.join("secret.txt"), "old").unwrap();
        fs::write(dir.join("latin1.txt"), b"caf\xe9 old").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
        let done = replace(request(&dir, "old", "new", FindOptions::default())).unwrap();
        assert_eq!((done.replacements, done.skipped.clone()), (0, vec!["latin1.txt".to_string()]));
        assert_eq!(fs::read(dir.join("latin1.txt")).unwrap(), b"caf\xe9 old");
        assert_eq!(fs::read_to_string(outside.join("secret.txt")).unwrap(), "old");
    }

    #[test]
    fn patterns_that_match_nothing_or_dont_parse_are_refused() {
        let regex = FindOptions { case: false, regex: true };
        assert!(matcher("x*", regex).unwrap_err().contains("matches empty text"));
        assert!(matcher("(open", regex).unwrap_err().starts_with("That isn't a regular expression"));
        assert!(matcher("", FindOptions::default()).unwrap().is_none());
        // Plain text is plain, brackets and all.
        assert!(matcher("(open", FindOptions::default()).unwrap().unwrap().is_match("f(open)"));
    }

    #[test]
    fn page_paths_use_forward_slashes_on_windows_only() {
        assert_eq!(page_string(r"C:\Users\me\proj\src\a.rs", true), "C:/Users/me/proj/src/a.rs");
        assert_eq!(page_string(r"/Users/me/odd\name.txt", false), r"/Users/me/odd\name.txt");
    }

    #[test]
    fn verbatim_prefixes_are_removed() {
        assert_eq!(strip_verbatim(r"\\?\C:\Users\me").as_deref(), Some(r"C:\Users\me"));
        assert_eq!(strip_verbatim(r"\\?\UNC\server\share\x").as_deref(), Some(r"\\server\share\x"));
        assert_eq!(strip_verbatim(r"\\?\Volume{1234}\x"), None);
        assert_eq!(strip_verbatim("/private/tmp/x").as_deref(), Some("/private/tmp/x"));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_project_resolves_to_the_real_folder_and_keeps_its_name() {
        let dir = tmp("resolve");
        fs::create_dir_all(dir.join("real-folder/src")).unwrap();
        fs::write(dir.join("real-folder/src/a.rs"), "").unwrap();
        std::os::unix::fs::symlink(dir.join("real-folder"), dir.join("linked")).unwrap();
        let real = fs::canonicalize(dir.join("real-folder")).unwrap().to_string_lossy().to_string();

        let project = resolve(&format!("{}/", dir.join("linked").display()));
        assert_eq!(project.path, real);
        assert_eq!(project.name, "linked");
        assert!(project.is_dir);

        // A file keeps its own name; the folders above it resolve.
        let file = resolve(&dir.join("linked/src/a.rs").to_string_lossy());
        assert_eq!(file.path, format!("{real}/src/a.rs"));
        assert!(!file.is_dir);

        // The temporary folder itself is behind a symlink on the Mac
        // (/var -> /private/var), as /tmp is: the watcher and git report the
        // /private form, and so does the project now.
        #[cfg(target_os = "macos")]
        assert!(project.path.starts_with("/private/"), "{}", project.path);

        // A folder that is gone keeps its path, tidied.
        let gone = resolve("/no/such/orbit-folder/");
        assert_eq!(gone.path, "/no/such/orbit-folder");
        assert_eq!(gone.name, "orbit-folder");
    }

    #[test]
    fn watcher_sorts_changes_by_path_components() {
        let roots = [PathBuf::from("/p")];
        let kind = |p: &str| classify(&roots, Path::new(p));
        assert_eq!(kind("/p/src/main.rs"), Kind::File);
        assert_eq!(kind("/p/.git"), Kind::Git);
        assert_eq!(kind("/p/.git/index"), Kind::Git);
        assert_eq!(kind("/p/.git/refs/heads/main"), Kind::Git);
        assert_eq!(kind("/p/.git/index.lock"), Kind::Ignored);
        assert_eq!(kind("/p/vendor/lib/.git/HEAD"), Kind::Git);
        // Not .git: only a whole component counts.
        assert_eq!(kind("/p/.gitignore"), Kind::File);
        assert_eq!(kind("/p/docs/.github/ci.yml"), Kind::File);
        for inside in ["target/debug/app", "node_modules/a/index.js", "web/node_modules/b.js", "dist/app.js", "build/out.o", ".next/cache/x", "app/__pycache__/m.pyc", ".venv/lib/site.py"] {
            assert_eq!(kind(&format!("/p/{inside}")), Kind::Ignored, "{inside}");
        }
        // The folder itself appearing or going is shown in the tree.
        assert_eq!(kind("/p/target"), Kind::File);
        // Names that only look alike are files.
        assert_eq!(kind("/p/src/build.rs"), Kind::File);
        assert_eq!(kind("/p/targets/x"), Kind::File);
        // Folders above the project don't count.
        let nested = [PathBuf::from("/home/me/build/app")];
        assert_eq!(classify(&nested, Path::new("/home/me/build/app/src/a.rs")), Kind::File);
        // The resolved root matches too.
        let both = [PathBuf::from("/tmp/p"), PathBuf::from("/private/tmp/p")];
        assert_eq!(classify(&both, Path::new("/private/tmp/p/target/x")), Kind::Ignored);
    }

    #[cfg(windows)]
    #[test]
    fn watcher_reads_windows_paths_by_component() {
        let roots = [PathBuf::from("C:/p")];
        assert_eq!(classify(&roots, Path::new(r"C:/p\.git\index")), Kind::Git);
        assert_eq!(classify(&roots, Path::new(r"C:/p\target\debug\x")), Kind::Ignored);
        assert_eq!(classify(&roots, Path::new(r"C:/p\src\a.rs")), Kind::File);
    }

    #[test]
    fn build_output_does_not_crowd_out_an_edit() {
        let roots = [PathBuf::from("/p")];
        let mut batch = Batch::default();
        for i in 0..5000 {
            assert!(!batch.add(&roots, Path::new(&format!("/p/target/debug/deps/{i}.o"))));
        }
        assert!(batch.add(&roots, Path::new("/p/src/main.rs")));
        assert_eq!(batch.files.iter().collect::<Vec<_>>(), vec!["/p/src/main.rs"]);
        assert!(!batch.overflow);
    }

    #[test]
    fn a_full_batch_asks_for_a_recheck_instead_of_dropping_files() {
        let roots = [PathBuf::from("/p")];
        let mut batch = Batch::default();
        for i in 0..BATCH_CAP {
            batch.add(&roots, Path::new(&format!("/p/src/{i}.rs")));
        }
        // Repeats of a listed file fit.
        batch.add(&roots, Path::new("/p/src/0.rs"));
        assert!(!batch.overflow);
        assert_eq!(batch.files.len(), BATCH_CAP);
        batch.add(&roots, Path::new("/p/src/open-in-the-editor.rs"));
        assert!(batch.overflow);
        assert!(batch.files.is_empty());
        assert!(!batch.is_empty());
        batch.add(&roots, Path::new("/p/.git/index"));
        assert!(batch.git);
    }

    #[test]
    fn a_failed_trash_leaves_the_item_in_place() {
        let dir = tmp("trash");
        fs::write(dir.join("notes.txt"), "keep me").unwrap();
        fs::create_dir_all(dir.join("folder/inner")).unwrap();
        for name in ["notes.txt", "folder"] {
            let path = dir.join(name);
            let err = trash_with(&path, |_| Err("The volume does not support the Trash.".to_string())).unwrap_err();
            assert_eq!(err, format!("Couldn't move {name} to the {TRASH}. It is still in place. The volume does not support the Trash."));
            assert!(path.exists(), "{name} was removed");
        }
        assert_eq!(fs::read_to_string(dir.join("notes.txt")).unwrap(), "keep me");
        assert!(dir.join("folder/inner").is_dir());

        let mut asked = None;
        trash_with(&dir.join("notes.txt"), |p| {
            asked = Some(p.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(asked, Some(dir.join("notes.txt")));

        let err = trash_with(&dir.join("missing.txt"), |_| panic!("asked to trash a missing file")).unwrap_err();
        assert!(err.ends_with("does not exist"), "{err}");
    }
}
