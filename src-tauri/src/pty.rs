//! Terminals. Each session is a pseudo-terminal running the user's login
//! shell, either on its own or exec'ing an agent (`claude`, `codex`, `grok`)
//! in the project folder, so the agent has every tool it has in Terminal.app.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, Session>>,
    next: AtomicU32,
}

#[derive(Serialize, Clone)]
struct Data {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct Exit {
    id: u32,
    code: Option<u32>,
}

pub fn spawn(app: &AppHandle, state: &PtyState, cwd: &str, program: Option<String>, args: Vec<String>, cols: u16, rows: u16) -> Result<u32, String> {
    let pty = native_pty_system();
    let pair = pty.openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;

    let shell = crate::shell::user_shell();
    let mut cmd = if cfg!(windows) {
        match program {
            Some(program) => {
                // /k keeps the prompt open after the agent exits.
                let mut cmd = CommandBuilder::new("cmd.exe");
                cmd.args(["/d", "/k", &program]);
                for a in args {
                    cmd.arg(a);
                }
                cmd
            }
            None => CommandBuilder::new(&shell),
        }
    } else {
        let mut cmd = CommandBuilder::new(&shell);
        match program {
            Some(program) => {
                // The login shell sets up the user's environment and runs the agent.
                // When the agent exits the shell stays open, with the agent's last
                // output still visible, until the user closes the tab.
                cmd.arg("-lc");
                cmd.arg(format!(
                    "\"$0\" \"$@\"; s=$?; printf '\\n\\033[2m[%s exited with status %s. This shell stays open: run it again, or close the tab.]\\033[0m\\n' \"$0\" \"$s\"; exec '{shell}' -l",
                    shell = shell.replace('\'', "'\\''")
                ));
                cmd.arg(program);
                for a in args {
                    cmd.arg(a);
                }
            }
            None => {
                cmd.arg("-l");
            }
        }
        cmd
    };
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "OrbitIDE");
    cmd.env("ORBIT_IDE", "1");
    cmd.env("PATH", crate::shell::login_path());
    // An agent started inside another agent's session would run as a nested
    // child: no transcript, no resume. Hand it a clean environment.
    for var in crate::shell::inherited_agent_vars() {
        cmd.env_remove(&var);
    }
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("cannot start terminal: {e}"))?;
    if cfg!(debug_assertions) {
        eprintln!("[pty] spawned shell={shell} cwd={cwd} pid={:?}", child.process_id());
    }
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    state.sessions.lock().map_err(|e| e.to_string())?.insert(id, Session { master: pair.master, writer, child });

    let app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => { if cfg!(debug_assertions) { eprintln!("[pty:{id}] eof"); } break }
                Err(e) => { if cfg!(debug_assertions) { eprintln!("[pty:{id}] read error {e}"); } break }
                Ok(n) => {
                    if cfg!(debug_assertions) { eprintln!("[pty:{id}] read {n} bytes"); }
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app.emit("pty:data", Data { id, data });
                }
            }
        }
        let code = {
            let state: tauri::State<PtyState> = app.state();
            let session = state.sessions.lock().ok().and_then(|mut s| s.remove(&id));
            session.and_then(|mut s| s.child.wait().ok()).map(|status| status.exit_code())
        };
        let _ = app.emit("pty:exit", Exit { id, code });
    });
    Ok(id)
}

pub fn write(state: &PtyState, id: u32, data: &str) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("terminal is closed")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

pub fn resize(state: &PtyState, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("terminal is closed")?;
    session.master.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

pub fn kill(state: &PtyState, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get_mut(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

pub fn kill_all(state: &PtyState) {
    if let Ok(mut sessions) = state.sessions.lock() {
        for (_, session) in sessions.iter_mut() {
            let _ = session.child.kill();
        }
        sessions.clear();
    }
}

use tauri::Manager;
