//! Updates, as Orbit Mission Control hands them out.
//!
//! Half a minute after launch and every four hours after that (and from
//! *Help > Check for Updates…* on the Mac, or the button in Settings, About
//! on Windows and Linux) the app asks
//! `https://control.orbit.com.ai/api/updates/orbit-ide/{target}/{arch}/{version}?build={n}`.
//! Mission Control answers from this repository's GitHub releases: `204` when
//! this is the newest build, else the newer build's version, download link and
//! signature. The download is checked against the public key in
//! `tauri.conf.json` (`plugins > updater > pubkey`) before anything is
//! installed, and the signature must name the version announced, so nobody
//! between here and GitHub can slip in another build.
//!
//! Once a build is downloaded the app asks whether to restart now. On the Mac
//! *Later* installs it when Orbit IDE quits; on Windows the installer has to
//! close the app, so it waits until the person chooses to restart and asks
//! again at the next launch.
//!
//! The build number comes from `ORBIT_BUILD` at compile time (the release
//! workflow's run number); a local build has none and is compared by version.
//! Debug builds don't check unless `ORBIT_UPDATES_URL` points them at a
//! Mission Control, e.g. `ORBIT_UPDATES_URL=http://127.0.0.1:8001 sh run.sh`.
//!
//! On Linux only the AppImage updates itself (the updater replaces the file it
//! runs from); a copy installed from the .deb or .rpm is left to its package,
//! and the Orbit Installer or a new package brings it up to date.
//!
//! The same module is in Orbit Chat, Orbit Mail and Orbit Pass for Windows and Linux; keep them in step.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The app's name in Mission Control's catalog.
const SLUG: &str = "orbit-ide";
const SERVER: &str = "https://control.orbit.com.ai";
const FIRST_CHECK: Duration = Duration::from_secs(30);
const EVERY: Duration = Duration::from_secs(4 * 3600);

#[derive(Default)]
pub struct Updates {
    /// A downloaded, verified build waiting to be installed.
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    /// Set while a check runs, so the timer and the menu never overlap.
    checking: AtomicBool,
}

/// Run before the Windows installer closes the app (it exits the process itself).
static BEFORE_EXIT: OnceLock<Box<dyn Fn(&AppHandle) + Send + Sync>> = OnceLock::new();

fn build_number() -> Option<u64> {
    option_env!("ORBIT_BUILD").and_then(|n| n.trim().parse().ok())
}

fn endpoint() -> Result<Url, String> {
    let server = std::env::var("ORBIT_UPDATES_URL").unwrap_or_else(|_| SERVER.to_string());
    let mut url = format!(
        "{}/api/updates/{SLUG}/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}",
        server.trim_end_matches('/')
    );
    if let Some(build) = build_number() {
        url.push_str(&format!("?build={build}"));
    }
    url.parse().map_err(|e| format!("bad update URL {url}: {e}"))
}

/// Starts checking in the background. `before_exit` is what the app does when it quits.
pub fn start(app: &AppHandle, before_exit: impl Fn(&AppHandle) + Send + Sync + 'static) {
    let _ = BEFORE_EXIT.set(Box::new(before_exit));
    if cfg!(debug_assertions) && std::env::var_os("ORBIT_UPDATES_URL").is_none() {
        return;
    }
    if !updates_itself() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut wait = FIRST_CHECK;
        loop {
            std::thread::sleep(wait);
            tauri::async_runtime::block_on(check(&app, false));
            wait = EVERY;
        }
    });
}

/// Whether this copy can replace itself: everywhere but a Linux package install.
fn updates_itself() -> bool {
    !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some()
}

/// Checks now. `manual` (from the menu) also says when there is nothing new or the check failed.
pub async fn check(app: &AppHandle, manual: bool) {
    if !updates_itself() {
        return;
    }
    let state = app.state::<Updates>();
    if state.checking.swap(true, Ordering::SeqCst) {
        return;
    }
    let ready = state.ready.lock().unwrap().as_ref().map(|(update, _)| update.version.clone());
    let result = match ready {
        // Already downloaded: the timer stays quiet, the menu asks again.
        Some(version) => Ok(manual.then_some(version)),
        None => download(app).await,
    };
    state.checking.store(false, Ordering::SeqCst);

    let name = app.package_info().name.clone();
    match result {
        Ok(Some(version)) => ask_to_restart(app, &version),
        Ok(None) if manual => {
            let current = app.package_info().version.to_string();
            app.dialog()
                .message(format!("{name} {current} is the newest version."))
                .title("You're up to date")
                .show(|_| {});
        }
        Err(error) => {
            eprintln!("[updates] {error}");
            if manual {
                app.dialog()
                    .message(format!("{name} couldn't check for updates. Check your connection and try again.\n\n{error}"))
                    .title("Update check failed")
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            }
        }
        Ok(None) => {}
    }
}

/// Asks Mission Control and downloads a newer build. `Some(version)` once one is ready.
async fn download(app: &AppHandle) -> Result<Option<String>, String> {
    let before_exit_app = app.clone();
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint()?])
        .map_err(|e| e.to_string())?
        // Mission Control only answers with a build that is newer by build number,
        // which semver can't always tell (0.2.0-build.21 comes after 0.2.0).
        .version_comparator(|current, release| release.version != current)
        .on_before_exit(move || {
            if let Some(before_exit) = BEFORE_EXIT.get() {
                before_exit(&before_exit_app);
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let version = update.version.clone();
    *app.state::<Updates>().ready.lock().unwrap() = Some((update, bytes));
    Ok(Some(version))
}

fn ask_to_restart(app: &AppHandle, version: &str) {
    let name = app.package_info().name.clone();
    let later = if cfg!(target_os = "macos") {
        format!("Or keep working: it installs when you quit {name}.")
    } else {
        "Or keep working and restart later.".to_string()
    };
    let app = app.clone();
    app.dialog()
        .message(format!("{name} {version} is ready. Restart now to finish updating. {later}"))
        .title("Update ready")
        .buttons(MessageDialogButtons::OkCancelCustom("Restart Now".into(), "Later".into()))
        .show(move |restart| {
            if restart {
                // Off the main thread: on the Mac the install may need to ask
                // for an administrator's password, which it does on the main thread.
                let app = app.clone();
                std::thread::spawn(move || install_and_restart(&app));
            }
        });
}

fn install_and_restart(app: &AppHandle) {
    let Some((update, bytes)) = app.state::<Updates>().ready.lock().unwrap().take() else {
        return;
    };
    // On Windows this hands over to the installer, which closes the app (running
    // `before_exit` first) and opens the new version when it is done.
    if let Err(error) = update.install(&bytes) {
        eprintln!("[updates] install failed: {error}");
        app.dialog()
            .message(format!("The update couldn't be installed.\n\n{error}"))
            .title("Update failed")
            .kind(MessageDialogKind::Warning)
            .show(|_| {});
        return;
    }
    // On the Mac the new app is in place; quitting runs the usual cleanup.
    app.request_restart();
}

/// On the Mac, installs a downloaded build as the app quits, when that needs no password.
pub fn install_on_quit(app: &AppHandle) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let Some((update, bytes)) = app.state::<Updates>().ready.lock().unwrap().take() else {
        return;
    };
    if !can_replace_app() {
        // Installing here would ask for a password from a closing app; the next
        // launch downloads it again and asks to restart instead.
        return;
    }
    if let Err(error) = update.install(&bytes) {
        eprintln!("[updates] install on quit failed: {error}");
    }
}

/// Whether the folder holding the app can be written without a password.
fn can_replace_app() -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    // …/Orbit IDE.app/Contents/MacOS/orbit-ide → the folder holding Orbit IDE.app
    let Some(folder) = exe.ancestors().nth(4) else { return false };
    let probe = folder.join(format!(".orbit-update-{}", std::process::id()));
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(_) => std::fs::remove_file(&probe).is_ok(),
        Err(_) => false,
    }
}

/// The id of the *Check for Updates…* menu item.
#[allow(dead_code)] // each app uses the parts it needs
pub const MENU_ID: &str = "check-for-updates";

/// The Help menu, with *Check for Updates…* in it. On the Mac it is the menu
/// bar's own Help menu, with the search field.
#[allow(dead_code)]
pub fn help_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    let check = tauri::menu::MenuItem::with_id(app, MENU_ID, "Check for Updates…", updates_itself(), None::<&str>)?;
    let help = tauri::menu::Submenu::with_items(app, "Help", true, &[&check])?;
    #[cfg(target_os = "macos")]
    help.set_as_help_menu_for_nsapp()?;
    Ok(help)
}

/// Whether this copy updates itself, so Settings knows to offer *Check for Updates*.
#[allow(dead_code)]
pub fn available() -> bool {
    updates_itself()
}

/// *Check for Updates* from the page's Settings, where Windows and Linux have it
/// (the Mac has it in the Help menu). Says what it found, as the menu item does.
#[allow(dead_code)]
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) {
    check(&app, true).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_keeps_the_updater_placeholders() {
        let url = endpoint().unwrap().to_string();
        assert!(url.starts_with("https://control.orbit.com.ai/api/updates/orbit-ide/"), "{url}");
        let url = url.replace("%7B", "{").replace("%7D", "}");
        assert!(url.contains("/{{target}}/{{arch}}/{{current_version}}"), "{url}");
    }
}
