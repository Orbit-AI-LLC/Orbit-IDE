# Orbit IDE

An offline code editor for the Mac with the AI agents you already use built
in. Claude Code, Codex and Grok run as their real command-line tools inside
the project, so every tool and model those agents have is available with no
limits added by the editor. OpenRouter gives a chat with any hosted model.

Nothing leaves the Mac except what you send to the provider you choose.

## What is in it

* **Projects** (first sidebar tab): a list of folders. Switching a project
  swaps the explorer, git view, terminals and agent sessions in the same
  window. Open one with the `+` button, `Cmd+O`, or drop a folder on the
  window.
* **Explorer** (second tab): the file tree with git status colours, create,
  rename, trash, reveal in Finder. `Cmd+P` jumps to any file; `Cmd+Shift+F`
  searches text across the project.
* **Source control** (third tab): branch switch and create, fetch, pull and
  push, staged and unstaged lists with added and removed line counts, diffs
  side by side, discard, commit, commit and push, amend. The **Generate**
  button writes the commit message from the staged diff with the provider you
  pick (Claude, Codex, Grok or OpenRouter). The instructions it follows are in
  Settings, under Commit messages.
* **Editor**: Monaco (the engine inside VS Code), bundled, with themes for
  dark and light.
* **Terminal** (`Cmd+J`): login shells in the project folder.
* **AI dock** (`Cmd+Shift+A`), one tab per provider:
  * Claude, Codex and Grok each run in a terminal in the project folder,
    exactly as from Terminal.app. Start fresh or continue the last session.
    A model and extra command-line arguments can be set per provider.
  * OpenRouter is a streaming chat. The open file or selection can be
    attached as context, and code blocks can be copied or inserted at the
    cursor.

Files edited by an agent reload in the editor as they change on disk, and
the git view refreshes itself.

## Requirements

* macOS 13 or later.
* `git` (comes with the Xcode command-line tools).
* The agents you want: `claude`, `codex` and `grok` on your PATH and signed
  in. Orbit IDE reads the PATH from your login shell, so anything that works
  in Terminal works here. OpenRouter needs an API key, entered in Settings.

## Running from source

```sh
npm install            # once: fetches Monaco and xterm
sh scripts/vendor.sh   # copies them into ui/vendor (run.sh does this if missing)
sh run.sh              # debug build and launch
```

The page lives in `ui/` with no bundler: plain HTML, CSS and ES modules.
Tauri embeds `ui/` into the binary at compile time, so rebuild after editing
the page. With `ORBIT_IDE_SELFTEST=1` the app runs a smoke test after boot
and prints the results to the terminal that launched it.

## Building the Mac app

```sh
sh build_orbit_ide_dmg.sh
```

This produces `src-tauri/target/release/bundle/macos/Orbit IDE.app` and
`dist/OrbitIDE.dmg`. The app is ad-hoc signed; the first launch may need a
right-click, Open.

## Layout of the repository

```
ui/                 the page: index.html, app.css, js/*.js, vendor/ (generated)
src-tauri/src/      the native side
  main.rs           commands the page can call
  shell.rs          the login PATH every subprocess and terminal gets
  settings.rs       settings file (app data folder, owner-readable only)
  fsops.rs          files, search, quick-open listing, change watcher
  git.rs            git through the git command
  pty.rs            pseudo-terminals for shells and agents
  ai.rs             one-shot completions through the CLIs, OpenRouter chat
scripts/            vendor.sh, the icon renderer and builder
```

## Icon

The mark is the Orbit family's comet orbit with a pair of code chevrons in
the centre. `python3 scripts/build_icon.py` regenerates every size from
`scripts/orbitmark.swift`; never edit the generated files by hand.

## Continuous builds and releases

Every push to `main` runs `.github/workflows/build.yml`, which builds the
app on a macOS runner and a Windows runner and publishes a GitHub release
tagged `v<version>-build.<run number>` (marked as a pre-release) with:

* `OrbitIDE.dmg` and `Orbit-IDE-macOS.app.zip` for the Mac
* `Orbit-IDE-Windows-Setup.exe` (installer) and
  `Orbit-IDE-Windows-portable.exe` for Windows

Pushing a tag such as `v0.2.0` publishes a full release under that tag.
The Mac build is ad-hoc signed and not notarized; the Windows build is
unsigned. Add signing secrets to the workflow for signed builds.

On Windows the agents run through `cmd.exe` so the npm-installed `claude`,
`codex` and `grok` launchers resolve, and the terminal is PowerShell.
