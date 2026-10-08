//! Orbit IDE: the native half of an offline code editor.
//!
//! The page in `ui/` is the editor, the project, file and git sidebars and the
//! AI dock. This side owns what a web page cannot: the filesystem, git,
//! pseudo-terminals for the agent CLIs, the settings file, the OpenRouter
//! connection and updates from Orbit Mission Control.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod fsops;
mod git;
mod pty;
mod settings;
mod shell;
mod updates;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;

use settings::Settings;

type Res<T> = Result<T, String>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---- app & settings ------------------------------------------------------

#[derive(Serialize)]
struct AppInfo {
    version: String,
    home: String,
    shell: String,
    path: String,
    selftest: bool,
    os: String,
    /// Whether this copy updates itself, so Settings offers Check for Updates.
    updates: bool,
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        home: fsops::page_path(std::path::Path::new(&std::env::var("HOME").unwrap_or_default())),
        shell: shell::user_shell(),
        path: shell::login_path().to_string(),
        selftest: std::env::var_os("ORBIT_IDE_SELFTEST").is_some(),
        os: std::env::consts::OS.to_string(),
        updates: updates::available(),
    }
}

/// The page's console, for debugging from a terminal: `cargo run` shows it.
#[tauri::command]
fn ui_log(level: String, message: String) {
    eprintln!("[ui:{level}] {message}");
}

#[tauri::command]
async fn settings_load(app: AppHandle) -> Res<Settings> {
    blocking(move || {
        let mut settings = settings::load(&app);
        // Projects saved before their paths were resolved, or with Windows
        // backslashes. Resolving touches each folder, so off the main thread.
        if settings::migrate_paths(&mut settings, |path| fsops::resolve(path).path) {
            let _ = settings::save(&app, &settings);
        }
        Ok(settings)
    })
    .await
}

#[tauri::command]
fn settings_save(app: AppHandle, settings: Settings) -> Res<()> {
    settings::save(&app, &settings)
}

#[tauri::command]
fn default_commit_instructions() -> String {
    settings::DEFAULT_COMMIT_INSTRUCTIONS.to_string()
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Res<Option<String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().set_title("Open a project folder").pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    blocking(move || rx.recv().map_err(|e| e.to_string())).await.map(|picked| picked.and_then(|p| p.into_path().ok()).map(|p| fsops::page_path(&p)))
}

// ---- files ---------------------------------------------------------------

/// A folder or file as the page should know it: symlinks resolved, so the
/// path matches what the watcher and git report.
#[tauri::command]
async fn fs_resolve(path: String) -> Res<fsops::Resolved> {
    blocking(move || Ok(fsops::resolve(&path))).await
}

#[tauri::command]
async fn fs_list(path: String) -> Res<Vec<fsops::Entry>> {
    blocking(move || fsops::list_dir(&path)).await
}

#[tauri::command]
async fn fs_read(path: String) -> Res<fsops::FileContent> {
    blocking(move || fsops::read_file(&path)).await
}

#[tauri::command]
async fn fs_write(path: String, content: String) -> Res<()> {
    blocking(move || fsops::write_file(&path, &content)).await
}

#[tauri::command]
async fn fs_create(path: String, is_dir: bool) -> Res<()> {
    blocking(move || fsops::create(&path, is_dir)).await
}

#[tauri::command]
async fn fs_rename(from: String, to: String) -> Res<()> {
    blocking(move || fsops::rename(&from, &to)).await
}

#[tauri::command]
async fn fs_delete(path: String) -> Res<()> {
    blocking(move || fsops::delete(&path)).await
}

#[tauri::command]
fn fs_reveal(path: String) -> Res<()> {
    fsops::reveal(&path)
}

#[tauri::command]
fn open_external(target: String) -> Res<()> {
    if !(target.starts_with("https://") || target.starts_with("http://") || target.starts_with('/')) {
        return Err("only web links and files can be opened".to_string());
    }
    fsops::open_external(&target)
}

#[tauri::command]
async fn fs_walk(root: String) -> Res<Vec<String>> {
    blocking(move || fsops::walk(&root, 30_000)).await
}

#[tauri::command]
async fn fs_search(root: String, query: String) -> Res<Vec<fsops::Hit>> {
    blocking(move || fsops::search(&root, &query, 500)).await
}

#[tauri::command]
fn fs_watch(app: AppHandle, state: State<'_, fsops::WatchState>, root: String) -> Res<()> {
    fsops::watch(&app, &state, &root)
}

// ---- git -----------------------------------------------------------------

#[tauri::command]
async fn git_status(repo: String) -> Res<git::Status> {
    blocking(move || git::status(&repo)).await
}

#[tauri::command]
async fn git_stage(repo: String, paths: Vec<String>) -> Res<()> {
    blocking(move || git::stage(&repo, &paths)).await
}

#[tauri::command]
async fn git_unstage(repo: String, paths: Vec<String>) -> Res<()> {
    blocking(move || git::unstage(&repo, &paths)).await
}

#[tauri::command]
async fn git_discard(repo: String, tracked: Vec<String>, untracked: Vec<String>) -> Res<()> {
    blocking(move || git::discard(&repo, &tracked, &untracked)).await
}

#[tauri::command]
async fn git_diff(repo: String, path: String, staged: bool, untracked: bool) -> Res<String> {
    blocking(move || git::diff(&repo, &path, staged, untracked)).await
}

#[tauri::command]
async fn git_diff_all(repo: String, staged: bool) -> Res<String> {
    blocking(move || git::diff_all(&repo, staged)).await
}

#[tauri::command]
async fn git_show(repo: String, spec: String) -> Res<String> {
    blocking(move || git::show(&repo, &spec)).await
}

#[tauri::command]
async fn git_commit(repo: String, message: String, amend: bool) -> Res<String> {
    blocking(move || git::commit(&repo, &message, amend)).await
}

#[tauri::command]
async fn git_log(repo: String, count: u32) -> Res<Vec<git::LogEntry>> {
    blocking(move || git::log(&repo, count)).await
}

#[tauri::command]
async fn git_branches(repo: String) -> Res<git::Branches> {
    blocking(move || git::branches(&repo)).await
}

#[tauri::command]
async fn git_checkout(repo: String, name: String, create: bool) -> Res<()> {
    blocking(move || git::checkout(&repo, &name, create)).await
}

#[tauri::command]
async fn git_push(repo: String) -> Res<String> {
    blocking(move || git::push(&repo)).await
}

#[tauri::command]
async fn git_pull(repo: String) -> Res<String> {
    blocking(move || git::pull(&repo)).await
}

#[tauri::command]
async fn git_fetch(repo: String) -> Res<String> {
    blocking(move || git::fetch(&repo)).await
}

#[tauri::command]
async fn git_init(path: String) -> Res<()> {
    blocking(move || git::init(&path)).await
}

// ---- terminals -----------------------------------------------------------

#[tauri::command]
fn pty_spawn(app: AppHandle, state: State<'_, pty::PtyState>, cwd: String, program: Option<String>, args: Option<Vec<String>>, cols: u16, rows: u16) -> Res<u32> {
    pty::spawn(&app, &state, &cwd, program, args.unwrap_or_default(), cols, rows)
}

#[tauri::command]
fn pty_write(state: State<'_, pty::PtyState>, id: u32, data: String) -> Res<()> {
    pty::write(&state, id, &data)
}

#[tauri::command]
fn pty_resize(state: State<'_, pty::PtyState>, id: u32, cols: u16, rows: u16) -> Res<()> {
    pty::resize(&state, id, cols, rows)
}

#[tauri::command]
fn pty_kill(state: State<'_, pty::PtyState>, id: u32) -> Res<()> {
    pty::kill(&state, id)
}

// ---- AI ------------------------------------------------------------------

#[tauri::command]
async fn ai_providers(app: AppHandle) -> Res<Vec<ai::Provider>> {
    blocking(move || Ok(ai::providers(&settings::load(&app)))).await
}

#[tauri::command]
async fn ai_complete(app: AppHandle, provider: String, prompt: String, cwd: String, model: Option<String>) -> Res<String> {
    blocking(move || ai::complete(&provider, &prompt, &cwd, model.as_deref(), &settings::load(&app))).await
}

#[tauri::command]
async fn ai_claude_sessions() -> Res<Vec<ai::ClaudeSession>> {
    blocking(ai::claude_sessions).await
}

#[tauri::command]
async fn ai_openrouter_models(app: AppHandle) -> Res<Vec<ai::ModelInfo>> {
    blocking(move || ai::openrouter_models(&settings::load(&app))).await
}

#[tauri::command]
fn ai_openrouter_chat(app: AppHandle, id: String, model: String, messages: Vec<ai::Message>) -> Res<()> {
    let settings = settings::load(&app);
    ai::openrouter_chat(app, id, model, messages, settings);
    Ok(())
}

#[tauri::command]
fn ai_cancel(state: State<'_, ai::ChatState>, id: String) {
    ai::cancel(&state, &id);
}

/// Writes every panic to panic.log in the app's data folder, so a crash can
/// be diagnosed from a Finder-launched app that has no terminal.
fn install_panic_log() {
    let dir = dirs_fallback();
    std::panic::set_hook(Box::new(move |info| {
        let message = match info.payload().downcast_ref::<&str>() {
            Some(s) => s.to_string(),
            None => info.payload().downcast_ref::<String>().cloned().unwrap_or_else(|| "panic".to_string()),
        };
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let backtrace = std::backtrace::Backtrace::force_capture();
        let line = format!("[{}] panic: {message} at {location}\n{backtrace}\n\n", chrono_like_now());
        eprintln!("{line}");
        if let Some(dir) = &dir {
            let _ = std::fs::create_dir_all(dir);
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("panic.log")) {
                use std::io::Write;
                let _ = f.write_all(line.as_bytes());
            }
        }
    }));
}

fn dirs_fallback() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let home = std::path::PathBuf::from(home);
    Some(if cfg!(target_os = "macos") {
        home.join("Library/Application Support/ai.com.orbit.ide")
    } else if cfg!(windows) {
        home.join("AppData/Roaming/ai.com.orbit.ide")
    } else {
        home.join(".local/share/ai.com.orbit.ide")
    })
}

fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("unix {secs}")
}

/// The Mac menu bar: Tauri's usual menus, with *Check for Updates…* in Help.
/// (Windows and Linux have it in Settings, About.)
#[cfg(target_os = "macos")]
fn mac_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, HELP_SUBMENU_ID};

    let menu = Menu::default(app)?;
    if let Some(help) = menu.get(HELP_SUBMENU_ID) {
        menu.remove(&help)?;
    }
    menu.append(&updates::help_menu(app)?)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id() == updates::MENU_ID {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { updates::check(&app, true).await });
        }
    });
    Ok(())
}

fn main() {
    install_panic_log();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Updates::default())
        .manage(pty::PtyState::default())
        .manage(fsops::WatchState::default())
        .manage(ai::ChatState::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            ui_log,
            settings_load,
            settings_save,
            default_commit_instructions,
            pick_folder,
            fs_resolve,
            fs_list,
            fs_read,
            fs_write,
            fs_create,
            fs_rename,
            fs_delete,
            fs_reveal,
            open_external,
            fs_walk,
            fs_search,
            fs_watch,
            git_status,
            git_stage,
            git_unstage,
            git_discard,
            git_diff,
            git_diff_all,
            git_show,
            git_commit,
            git_log,
            git_branches,
            git_checkout,
            git_push,
            git_pull,
            git_fetch,
            git_init,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            ai_providers,
            ai_complete,
            ai_claude_sessions,
            ai_openrouter_models,
            ai_openrouter_chat,
            ai_cancel,
            updates::check_for_updates,
        ])
        .setup(|app| {
            // Warm the login PATH off the main thread so the first terminal is quick.
            std::thread::spawn(|| {
                let _ = shell::login_path();
            });
            #[cfg(target_os = "macos")]
            mac_menu(app.handle())?;
            // The Windows installer closes the app itself; the terminals go first.
            updates::start(app.handle(), |app| pty::kill_all(&app.state::<pty::PtyState>()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Orbit IDE");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            pty::kill_all(&app.state::<pty::PtyState>());
            updates::install_on_quit(app);
        }
    });
}
