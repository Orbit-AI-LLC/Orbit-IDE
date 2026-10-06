//! Git through the `git` command line, which every Mac with the developer
//! tools has. Nothing here prompts: credential prompts are turned off so a
//! push without saved credentials fails with a message instead of hanging.

use std::process::Command;

use serde::Serialize;

fn git_cmd(repo: &str) -> Command {
    let mut cmd = crate::shell::command("git");
    cmd.current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C");
    cmd
}

fn run(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = git_cmd(repo).args(args).output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        Err(if msg.is_empty() { format!("git {} failed", args.join(" ")) } else { msg })
    }
}

fn run_bytes(repo: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = git_cmd(repo).args(args).output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(Serialize, Default)]
pub struct StatusEntry {
    pub path: String,
    pub orig_path: Option<String>,
    pub index: String,
    pub worktree: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflicted: bool,
    pub staged_add: u32,
    pub staged_del: u32,
    pub work_add: u32,
    pub work_del: u32,
    /// Lines added and removed in the working tree against HEAD: the whole
    /// change, whether staged or not.
    pub add: u32,
    pub del: u32,
    /// A submodule (or a nested repository recorded as one).
    pub submodule: bool,
    /// The submodule's checked-out commit differs from the recorded one,
    /// which the outer repository can stage.
    pub sub_commit_changed: bool,
    /// Modified or untracked files inside the submodule. They can only be
    /// committed from inside it.
    pub sub_dirty: bool,
    pub sub_changes: u32,
    /// Whether `git add` in the outer repository can stage anything here.
    pub stageable: bool,
}

#[derive(Serialize, Default)]
pub struct Status {
    pub is_repo: bool,
    pub root: String,
    pub branch: String,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<StatusEntry>,
    pub has_commits: bool,
}

pub fn status(repo: &str) -> Result<Status, String> {
    let root = match run(repo, &["rev-parse", "--show-toplevel"]) {
        Ok(r) => r.trim().to_string(),
        Err(_) => return Ok(Status { is_repo: false, root: repo.to_string(), ..Status::default() }),
    };
    // The status, the HEAD check and the line counts don't depend on each
    // other: run them at once, so a refresh takes about one git call, not six.
    let (raw, has_commits, counts) = std::thread::scope(|s| {
        let has_commits = s.spawn(|| run(&root, &["rev-parse", "--verify", "HEAD"]).is_ok());
        let counts = s.spawn(|| LineCounts::read(&root));
        // Version 2 says which entries are submodules and how they changed.
        let raw = run_bytes(&root, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]);
        (raw, has_commits.join().unwrap_or(false), counts.join().unwrap_or_default())
    });
    let raw = raw?;
    // The page joins entry paths to the root and matches them against the
    // file tree, so the root takes the form project paths have: resolved,
    // and with forward slashes on Windows.
    let mut status = Status { is_repo: true, root: crate::fsops::resolve(&root).path, has_commits, ..Status::default() };
    let records: Vec<&[u8]> = raw.split(|b| *b == 0).collect();
    let mut i = 0;
    while i < records.len() {
        let rec = String::from_utf8_lossy(records[i]).to_string();
        i += 1;
        if rec.is_empty() {
            continue;
        }
        if let Some(header) = rec.strip_prefix("# ") {
            parse_branch_header(header, &mut status);
            continue;
        }
        let kind = &rec[..1];
        let (xy, sub, path) = match kind {
            "1" => {
                let f: Vec<&str> = rec.splitn(9, ' ').collect();
                if f.len() < 9 { continue; }
                (f[1].to_string(), f[2].to_string(), f[8].to_string())
            }
            "2" => {
                let f: Vec<&str> = rec.splitn(10, ' ').collect();
                if f.len() < 10 { continue; }
                (f[1].to_string(), f[2].to_string(), f[9].to_string())
            }
            "u" => {
                let f: Vec<&str> = rec.splitn(11, ' ').collect();
                if f.len() < 11 { continue; }
                (f[1].to_string(), f[2].to_string(), f[10].to_string())
            }
            "?" => ("??".to_string(), "N...".to_string(), rec[2..].to_string()),
            _ => continue, // "!" ignored entries
        };
        let dot = |c: char| if c == '.' { " ".to_string() } else { c.to_string() };
        let mut chars = xy.chars();
        let x = dot(chars.next().unwrap_or('.'));
        let y = dot(chars.next().unwrap_or('.'));
        let mut entry = StatusEntry { path, index: x.clone(), worktree: y.clone(), ..StatusEntry::default() };
        if kind == "2" && i < records.len() {
            entry.orig_path = Some(String::from_utf8_lossy(records[i]).to_string());
            i += 1;
        }
        if kind == "?" {
            entry.untracked = true;
            entry.unstaged = true;
            // With --untracked-files=all git lists files, except a folder that
            // is its own repository (an agent worktree, a clone), which it
            // lists once with a trailing slash. Treat that as nested.
            if entry.path.ends_with('/') {
                entry.path = entry.path.trim_end_matches('/').to_string();
                let inner = std::path::Path::new(&root).join(&entry.path);
                if inner.join(".git").exists() {
                    entry.submodule = true;
                    entry.sub_dirty = true;
                }
            }
        } else {
            entry.conflicted = kind == "u";
            entry.staged = x != " " && !entry.conflicted;
            entry.unstaged = y != " " || entry.conflicted;
        }
        // sub is "N..." for a plain path, or "S" + C (commit changed) M (tracked
        // changes inside) U (untracked files inside), each "." when not.
        let sb: Vec<char> = sub.chars().collect();
        if sb.first() == Some(&'S') {
            entry.submodule = true;
            entry.sub_commit_changed = sb.get(1) == Some(&'C');
            entry.sub_dirty = sb.get(2) == Some(&'M') || sb.get(3) == Some(&'U');
            // Only a moved pointer (or an add, delete or rename of the
            // submodule itself) is something the outer repository can stage.
            entry.stageable = entry.sub_commit_changed || x != " " || matches!(y.as_str(), "D" | "A");
            if entry.sub_dirty {
                let inner = std::path::Path::new(&root).join(&entry.path);
                entry.sub_changes = run_bytes(&inner.to_string_lossy(), &["status", "--porcelain=v1", "-z", "--untracked-files=normal"])
                    .map(|raw| raw.split(|b| *b == 0).filter(|r| r.len() > 3).count() as u32)
                    .unwrap_or(0);
            }
        } else {
            entry.stageable = !entry.submodule;
        }
        status.entries.push(entry);
    }
    status.entries.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    add_line_counts(&root, &mut status, &counts);
    Ok(status)
}

fn parse_branch_header(header: &str, status: &mut Status) {
    if let Some(head) = header.strip_prefix("branch.head ") {
        if head == "(detached)" {
            status.branch = "HEAD".to_string();
            status.detached = true;
        } else {
            status.branch = head.to_string();
        }
    } else if let Some(upstream) = header.strip_prefix("branch.upstream ") {
        status.upstream = Some(upstream.to_string());
    } else if let Some(ab) = header.strip_prefix("branch.ab ") {
        for part in ab.split(' ') {
            if let Some(n) = part.strip_prefix('+') {
                status.ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix('-') {
                status.behind = n.parse().unwrap_or(0);
            }
        }
    }
}

/// Lines added and removed per file: staged, unstaged, and against HEAD
/// (none before the first commit).
#[derive(Default)]
struct LineCounts {
    staged: std::collections::HashMap<String, (u32, u32)>,
    work: std::collections::HashMap<String, (u32, u32)>,
    head: Option<std::collections::HashMap<String, (u32, u32)>>,
}

impl LineCounts {
    fn read(root: &str) -> LineCounts {
        std::thread::scope(|s| {
            let staged = s.spawn(|| numstat(root, true));
            let work = s.spawn(|| numstat(root, false));
            let head = numstat_head(root);
            LineCounts { staged: staged.join().unwrap_or_default(), work: work.join().unwrap_or_default(), head }
        })
    }
}

/// Lines added and removed per file, from `git diff --numstat`, plus the
/// line count of each untracked text file.
fn add_line_counts(root: &str, status: &mut Status, counts: &LineCounts) {
    let LineCounts { staged, work, head } = counts;
    for entry in status.entries.iter_mut() {
        match head.as_ref().and_then(|h| h.get(&entry.path)) {
            Some((a, d)) => {
                entry.add = *a;
                entry.del = *d;
            }
            None => {
                let (sa, sd) = staged.get(&entry.path).copied().unwrap_or((0, 0));
                let (wa, wd) = work.get(&entry.path).copied().unwrap_or((0, 0));
                entry.add = sa + wa;
                entry.del = sd + wd;
            }
        }
        if let Some((a, d)) = staged.get(&entry.path) {
            entry.staged_add = *a;
            entry.staged_del = *d;
        }
        if let Some((a, d)) = work.get(&entry.path) {
            entry.work_add = *a;
            entry.work_del = *d;
        }
        if entry.untracked {
            entry.work_add = count_lines(&std::path::Path::new(root).join(&entry.path));
            entry.add = entry.work_add;
        }
    }
}

fn numstat_head(root: &str) -> Option<std::collections::HashMap<String, (u32, u32)>> {
    run_bytes(root, &["diff", "HEAD", "--numstat", "-z", "-M"]).ok().map(|raw| parse_numstat(&raw))
}

fn numstat(root: &str, staged: bool) -> std::collections::HashMap<String, (u32, u32)> {
    let mut out = std::collections::HashMap::new();
    let args: &[&str] = if staged { &["diff", "--cached", "--numstat", "-z", "-M"] } else { &["diff", "--numstat", "-z", "-M"] };
    let Ok(raw) = run_bytes(root, args) else { return out };
    out = parse_numstat(&raw);
    out
}

fn parse_numstat(raw: &[u8]) -> std::collections::HashMap<String, (u32, u32)> {
    let mut out = std::collections::HashMap::new();
    // Records: "add\tdel\tpath\0" or, for renames, "add\tdel\t\0old\0new\0".
    let fields: Vec<&[u8]> = raw.split(|b| *b == 0).collect();
    let mut i = 0;
    while i < fields.len() {
        let rec = String::from_utf8_lossy(fields[i]).to_string();
        i += 1;
        if rec.is_empty() {
            continue;
        }
        let mut parts = rec.splitn(3, '\t');
        let (Some(a), Some(d), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let a = a.parse::<u32>().unwrap_or(0);
        let d = d.parse::<u32>().unwrap_or(0);
        let path = if path.is_empty() {
            // Rename: the old and new names follow as two records.
            i += 1;
            let new = fields.get(i).map(|f| String::from_utf8_lossy(f).to_string()).unwrap_or_default();
            i += 1;
            new
        } else {
            path.to_string()
        };
        out.insert(path, (a, d));
    }
    out
}

fn count_lines(path: &std::path::Path) -> u32 {
    let Ok(meta) = std::fs::metadata(path) else { return 0 };
    if !meta.is_file() || meta.len() > 4 * 1024 * 1024 {
        return 0;
    }
    let Ok(bytes) = std::fs::read(path) else { return 0 };
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return 0;
    }
    let newlines = bytes.iter().filter(|b| **b == b'\n').count();
    (newlines + usize::from(!bytes.is_empty() && !bytes.ends_with(b"\n"))) as u32
}

pub fn stage(repo: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        run(repo, &["add", "-A"])?;
        return Ok(());
    }
    let mut args = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    run(repo, &args).map(|_| ())
}

pub fn unstage(repo: &str, paths: &[String]) -> Result<(), String> {
    let has_head = run(repo, &["rev-parse", "--verify", "HEAD"]).is_ok();
    let mut args: Vec<&str> = if has_head { vec!["reset", "-q", "--"] } else { vec!["rm", "-r", "-q", "--cached", "--"] };
    if paths.is_empty() {
        if has_head {
            run(repo, &["reset", "-q"])?;
        } else {
            run(repo, &["rm", "-r", "-q", "--cached", "."])?;
        }
        return Ok(());
    }
    args.extend(paths.iter().map(|s| s.as_str()));
    run(repo, &args).map(|_| ())
}

/// Throws away working-tree changes. Untracked paths are removed with
/// `git clean`; tracked ones are restored from the index.
pub fn discard(repo: &str, tracked: &[String], untracked: &[String]) -> Result<(), String> {
    if !tracked.is_empty() {
        let mut args = vec!["checkout", "--"];
        args.extend(tracked.iter().map(|s| s.as_str()));
        run(repo, &args)?;
    }
    if !untracked.is_empty() {
        let mut args = vec!["clean", "-f", "-d", "-q", "--"];
        args.extend(untracked.iter().map(|s| s.as_str()));
        run(repo, &args)?;
    }
    Ok(())
}

pub fn diff(repo: &str, path: &str, staged: bool, untracked: bool) -> Result<String, String> {
    if untracked {
        let out = git_cmd(repo).args(["diff", "--no-index", "--no-color", "--", "/dev/null", path]).output().map_err(|e| e.to_string())?;
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }
    if staged {
        run(repo, &["diff", "--cached", "--no-color", "--", path])
    } else {
        run(repo, &["diff", "--no-color", "--", path])
    }
}

pub fn diff_all(repo: &str, staged: bool) -> Result<String, String> {
    if staged {
        run(repo, &["diff", "--cached", "--no-color", "--stat=120", "--patch"])
    } else {
        run(repo, &["diff", "--no-color", "--stat=120", "--patch"])
    }
}

/// `spec` is a revision:path pair such as `HEAD:src/main.rs` or `:src/main.rs`
/// (the index). Missing objects give an empty string: the file is new.
pub fn show(repo: &str, spec: &str) -> Result<String, String> {
    match run_bytes(repo, &["show", spec]) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).to_string()),
        Err(_) => Ok(String::new()),
    }
}

pub fn commit(repo: &str, message: &str, amend: bool) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("The commit message is empty.".to_string());
    }
    // Whitespace only: "strip" would drop lines that start with "#", such as
    // a subject like "#42 Fix the login redirect".
    let mut args = vec!["commit", "-q", "--cleanup=whitespace", "-m", message];
    if amend {
        args.push("--amend");
    }
    if let Err(err) = run(repo, &args) {
        // With nothing staged git prints the whole status; say what it means.
        if err.contains("no changes added to commit") || err.contains("nothing to commit") || err.contains("nothing added to commit") {
            return Err("Nothing is staged, so there is nothing to commit.".to_string());
        }
        return Err(err);
    }
    run(repo, &["log", "-1", "--format=%h %s"]).map(|s| s.trim().to_string())
}

#[derive(Serialize)]
pub struct LogEntry {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub when: String,
}

pub fn log(repo: &str, count: u32) -> Result<Vec<LogEntry>, String> {
    let n = format!("-{}", count.clamp(1, 500));
    let raw = match run(repo, &["log", &n, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1e"]) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };
    Ok(raw
        .split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_matches(|c| c == '\n' || c == '\r').split('\x1f').collect();
            (f.len() >= 5).then(|| LogEntry { hash: f[0].to_string(), short: f[1].to_string(), subject: f[2].to_string(), author: f[3].to_string(), when: f[4].to_string() })
        })
        .collect())
}

#[derive(Serialize)]
pub struct Branches {
    pub current: String,
    pub local: Vec<String>,
    pub remote: Vec<String>,
}

pub fn branches(repo: &str) -> Result<Branches, String> {
    let current = run(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default();
    // lstrip=2, not short: short names refs/remotes/origin/HEAD "origin" and a
    // branch that shares a tag's name "heads/<name>"; both check out detached.
    let local = run(repo, &["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads/"])?.lines().map(|s| s.to_string()).collect();
    let remote = run(repo, &["for-each-ref", "--format=%(refname:lstrip=2)", "refs/remotes/"])?.lines().filter(|s| !s.ends_with("/HEAD")).map(|s| s.to_string()).collect();
    Ok(Branches { current, local, remote })
}

pub fn checkout(repo: &str, name: &str, create: bool) -> Result<(), String> {
    if create {
        run(repo, &["checkout", "-b", name]).map(|_| ())
    } else {
        run(repo, &["checkout", name]).map(|_| ())
    }
}

pub fn push(repo: &str) -> Result<String, String> {
    let branch = run(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    let has_upstream = run(repo, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_ok();
    let out = if has_upstream {
        git_cmd(repo).args(["push", "--porcelain"]).output()
    } else {
        git_cmd(repo).args(["push", "--porcelain", "-u", "origin", &branch]).output()
    }
    .map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() { Ok(text.trim().to_string()) } else { Err(text.trim().to_string()) }
}

pub fn pull(repo: &str) -> Result<String, String> {
    let out = git_cmd(repo).args(["pull", "--no-rebase", "--no-edit"]).output().map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() { Ok(text.trim().to_string()) } else { Err(text.trim().to_string()) }
}

pub fn fetch(repo: &str) -> Result<String, String> {
    let out = git_cmd(repo).args(["fetch", "--all", "--prune"]).output().map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() { Ok(text.trim().to_string()) } else { Err(text.trim().to_string()) }
}

pub fn init(path: &str) -> Result<(), String> {
    run(path, &["init", "-q"]).map(|_| ())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_repo_opened_through_a_symlink_reports_the_project_path() {
        let dir = std::env::temp_dir().join(format!("orbit-ide-git-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("real/src")).unwrap();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).unwrap();
        let link = dir.join("link").to_string_lossy().to_string();
        init(&link).unwrap();
        std::fs::write(dir.join("real/src/a.rs"), "fn main() {}\n").unwrap();

        // git names the resolved folder, so a project kept as the link path
        // never matched the files git lists.
        let toplevel = run(&link, &["rev-parse", "--show-toplevel"]).unwrap().trim().to_string();
        assert_ne!(toplevel, link);

        // The project is added by its resolved path; git's root is the same
        // string, so a changed file joins to the path the explorer shows.
        let project = crate::fsops::resolve(&link).path;
        let status = status(&project).unwrap();
        assert_eq!(status.root, project);
        let entry = status.entries.iter().find(|e| e.path == "src/a.rs").expect("src/a.rs listed");
        assert_eq!(format!("{}/{}", status.root, entry.path), crate::fsops::resolve(&format!("{link}/src/a.rs")).path);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
