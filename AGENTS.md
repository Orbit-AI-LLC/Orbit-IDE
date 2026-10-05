# Orbit IDE: notes for AI assistants

Read README.md first; it describes what the app is and how it is laid out.

* The page in `ui/` has no build step. Keep it plain HTML, CSS and ES
  modules. Libraries are vendored by `scripts/vendor.sh`; never load anything
  from the network.
* Tauri embeds `ui/` at compile time. After changing the page, rebuild
  (`cargo build` in `src-tauri`) before testing; restarting the binary alone
  shows the old page.
* Load third-party scripts as ES modules. Monaco's AMD loader defines a global
  `define`, and UMD bundles register with it instead of setting globals.
* Everything that touches the disk, git, a process or the network lives on the
  Rust side in a `#[tauri::command]`. Long work goes through `blocking()` so
  the window stays responsive.
* Agents (`claude`, `codex`, `grok`) run through their own CLIs in a
  pseudo-terminal with the user's login PATH. Do not reimplement their tools
  or call their APIs directly; the point is that the user gets the real
  thing.
* Commit message generation lives in `ui/js/gitpanel.js` (`buildPrompt`,
  `cleanMessage`) and `src-tauri/src/ai.rs` (`complete`). The default
  instructions are in `src-tauri/src/settings.rs`.
* No em-dashes anywhere in copy. Short sentences.
* Test with `ORBIT_IDE_SELFTEST=1 cargo run` and read the `[ui:selftest]`
  lines; screen capture may not be available to an assistant.
