//! Language servers: the ones already installed on this computer, found on
//! the login PATH. Each runs as a child process in the project folder and
//! speaks the Language Server Protocol over stdin and stdout; this side only
//! frames messages (`Content-Length` headers) and passes them through. The
//! page (`ui/js/lsp.js`) is the client: it opens documents, shows errors and
//! warnings, hover and Go to Definition.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// For each editor language, the servers to try in order: program and arguments.
const SERVERS: &[(&str, &[(&str, &[&str])])] = &[
    ("rust", &[("rust-analyzer", &[])]),
    ("typescript", &[("typescript-language-server", &["--stdio"])]),
    ("javascript", &[("typescript-language-server", &["--stdio"])]),
    ("python", &[("pyright-langserver", &["--stdio"]), ("basedpyright-langserver", &["--stdio"]), ("pylsp", &[])]),
    ("go", &[("gopls", &[])]),
    ("c", &[("clangd", &[])]),
    ("cpp", &[("clangd", &[])]),
];

/// A server this computer has, for one editor language.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Server {
    pub language: String,
    pub program: String,
}

/// The installed server for each language that has one.
pub fn servers() -> Vec<Server> {
    let mut works: HashMap<&str, bool> = HashMap::new();
    SERVERS
        .iter()
        .filter_map(|(language, candidates)| {
            candidates
                .iter()
                .find(|(program, _)| *works.entry(program).or_insert_with(|| installed(program)))
                .map(|(program, _)| Server { language: language.to_string(), program: program.to_string() })
        })
        .collect()
}

/// Whether `program` is on the PATH and is the real thing. rustup puts a
/// `rust-analyzer` there that only works once its component is added
/// (`rustup component add rust-analyzer`); before that it fails at once.
fn installed(program: &str) -> bool {
    if crate::shell::which(program).is_none() {
        return false;
    }
    if program != "rust-analyzer" {
        return true;
    }
    crate::shell::command(program)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn arguments(program: &str) -> Option<&'static [&'static str]> {
    SERVERS.iter().flat_map(|(_, candidates)| candidates.iter()).find(|(name, _)| *name == program).map(|(_, args)| *args)
}

struct Running {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct LspState {
    next: AtomicU64,
    running: Mutex<HashMap<u64, Running>>,
}

#[derive(Serialize, Clone)]
struct Message {
    id: u64,
    body: String,
}

/// A server stopped, with the last of what it wrote to stderr, which says
/// why when it couldn't start.
#[derive(Serialize, Clone)]
struct Exit {
    id: u64,
    log: String,
}

/// How much of a server's stderr is kept, for when it stops.
const LOG_LINES: usize = 12;

/// Start `program` (one of `SERVERS`) in `root`. Messages it sends arrive as
/// `lsp-message` events with this id; `lsp-exit` says it stopped.
pub fn start(app: &AppHandle, state: &LspState, root: &str, program: &str) -> Result<u64, String> {
    let args = arguments(program).ok_or_else(|| format!("{program} isn't a language server Orbit IDE knows"))?;
    crate::shell::which(program).ok_or_else(|| format!("{program} isn't installed"))?;
    let mut child = crate::shell::command(program)
        .args(args)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{program}: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    state.running.lock().map_err(|e| e.to_string())?.insert(id, Running { child, stdin });
    // Servers log to stderr freely: read it all (a full pipe would stop
    // them) and keep the last lines.
    let log = Arc::new(Mutex::new(VecDeque::new()));
    let kept = log.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Ok(mut kept) = kept.lock() {
                if kept.len() == LOG_LINES {
                    kept.pop_front();
                }
                kept.push_back(line);
            }
        }
    });
    let app = app.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Some(body) = read_message(&mut reader) {
            let _ = app.emit("lsp-message", Message { id, body });
        }
        // Let stderr's last lines arrive.
        std::thread::sleep(std::time::Duration::from_millis(150));
        let log = log.lock().map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n")).unwrap_or_default();
        let _ = app.emit("lsp-exit", Exit { id, log });
    });
    Ok(id)
}

/// One message from a server: headers, a blank line, then `Content-Length`
/// bytes of JSON. None once the stream ends or stops making sense.
fn read_message(reader: &mut impl BufRead) -> Option<String> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let mut body = vec![0; length?];
    reader.read_exact(&mut body).ok()?;
    String::from_utf8(body).ok()
}

fn frame(body: &str) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

pub fn send(state: &LspState, id: u64, body: &str) -> Result<(), String> {
    let mut running = state.running.lock().map_err(|e| e.to_string())?;
    let server = running.get_mut(&id).ok_or("That language server has stopped.")?;
    server.stdin.write_all(&frame(body)).and_then(|_| server.stdin.flush()).map_err(|e| e.to_string())
}

pub fn stop(state: &LspState, id: u64) {
    if let Ok(mut running) = state.running.lock() {
        if let Some(mut server) = running.remove(&id) {
            let _ = server.child.kill();
            let _ = server.child.wait();
        }
    }
}

pub fn stop_all(state: &LspState) {
    if let Ok(mut running) = state.running.lock() {
        for (_, mut server) in running.drain() {
            let _ = server.child.kill();
            let _ = server.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_framed_and_read_back() {
        let one = r#"{"jsonrpc":"2.0","id":1,"result":{"ok":"é"}}"#;
        let two = r#"{"jsonrpc":"2.0","method":"window/logMessage","params":{}}"#;
        let mut stream = frame(one);
        // Other headers, in any case, are read past.
        stream.extend_from_slice(format!("content-type: application/vscode-jsonrpc; charset=utf-8\r\nCONTENT-LENGTH: {}\r\n\r\n{two}", two.len()).as_bytes());
        let mut reader = BufReader::new(&stream[..]);
        assert_eq!(read_message(&mut reader).as_deref(), Some(one));
        assert_eq!(read_message(&mut reader).as_deref(), Some(two));
        assert_eq!(read_message(&mut reader), None);
        // The length counts bytes, not characters.
        assert!(String::from_utf8(frame(one)).unwrap().starts_with(&format!("Content-Length: {}\r\n\r\n", one.len())));
    }

    #[test]
    fn a_stream_cut_short_or_without_a_length_ends() {
        assert_eq!(read_message(&mut BufReader::new(&b"Content-Length: 50\r\n\r\n{\"short\":1}"[..])), None);
        assert_eq!(read_message(&mut BufReader::new(&b"X-Other: 1\r\n\r\n{}"[..])), None);
    }

    #[test]
    fn only_known_servers_start() {
        assert_eq!(arguments("typescript-language-server"), Some(&["--stdio"][..]));
        assert_eq!(arguments("rm"), None);
    }
}
