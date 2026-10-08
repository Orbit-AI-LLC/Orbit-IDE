# Orbit IDE

An offline code editor for the Mac, Windows and Linux with the AI agents you
already use built in. Claude Code, Codex and Grok run as their real command-line tools inside
the project, so every tool and model those agents have is available with no
limits added by the editor. OpenRouter gives a chat with any hosted model.

Nothing leaves your computer except what you send to the provider you choose.

## What is in it

* **Projects** (first sidebar tab): a list of folders. Switching a project
  swaps the explorer, git view, terminals and agent sessions in the same
  window. Open one with the `+` button, `Cmd+O`, or drop a folder on the
  window. Every project in the list is checked for git changes in the
  background, so a switch shows its changes at once, and the list shows how
  many files changed in each. A project is kept by its real path, with
  symlinks resolved (a folder opened as `/tmp/x` is `/private/tmp/x`), and
  shows by the name of the folder you picked. Removing a project with unsaved
  files asks first: save them, throw them away, or cancel.
* **Explorer** (second tab): the file tree with git status colours, create,
  rename, trash, reveal in Finder. `Cmd+P` jumps to any file. Move to Trash
  uses the system Trash, on another disk that disk's own Trash, so Put Back
  works. When an item can't go to the Trash, it stays where it is and you get
  an error; Orbit IDE never deletes it outright.
* **Search** (`Cmd+Shift+F`): text across the project, in any case unless
  *Match case* (Aa) is on, or as a regular expression (.*). `Cmd+Shift+H`
  goes to the Replace box: **Replace all** says how many matches in how many
  files first, and each file in the results has its own Replace. With a
  regular expression, `$1` or `${name}` puts in what a group matched. Files
  open with unsaved changes are searched and replaced as the editor has them,
  in one step Undo takes back, and stay unsaved; the rest are written, and
  open ones reload. Generated folders (`node_modules`, `target`, `dist`,
  `build` and the like), `.git`, binary files, files over 2 MB and symlinks
  are left out, and a file that isn't UTF-8 text is never rewritten.
* **Source control** (third tab): branch switch and create, fetch, pull and
  push, staged and unstaged lists with added and removed line counts, diffs
  side by side, discard, commit, commit and push, amend. The **Generate**
  button writes the commit message from the staged diff with the provider you
  pick (Claude, Codex, Grok or OpenRouter). Claude writes it with Haiku and no
  thinking, so it takes a few seconds. The instructions it follows are in
  Settings, under Commit messages.
* **Editor**: Monaco (the engine inside VS Code), bundled, with themes for
  dark and light.
* **Language servers**: the ones already installed on the computer, found on
  the login PATH: rust-analyzer, typescript-language-server, Pyright (or
  basedpyright, or pylsp), gopls and clangd. One starts per project when a file
  it reads opens, and gives errors and warnings as you type, hover, and Go to
  Definition (F12, or Cmd+click) into other files. The status bar names the
  server reading the file, or says why it didn't start (rustup's
  `rust-analyzer` needs `rustup component add rust-analyzer` first). With
  typescript-language-server, Monaco's own TypeScript checks step aside.
  Settings › General turns them off. Servers keep their own caches (clangd's
  is `.cache/clangd` in the project).
* **Terminal** (`Cmd+J`): login shells in the project folder.
* **AI dock** (`Cmd+Shift+A`), one tab per provider:
  * Claude, Codex and Grok each run in a terminal in the project folder,
    exactly as from Terminal.app. Start fresh or continue the last session.
    A model and extra command-line arguments can be set per provider.
  * With Claude Code installed, the dock opens on the Claude tab and its
    agents page (`claude agents`), which lists every background session.
    The session you open there is remembered for the project: next time the
    project opens, Orbit IDE goes straight back to it (`claude attach`), and
    ← returns to the agents page.
  * OpenRouter is a streaming chat. The open file or selection can be
    attached as context, and code blocks can be copied or inserted at the
    cursor.

Files edited by an agent reload in the editor as they change on disk, and
the git view refreshes itself. Changes inside build output and dependency
folders (`node_modules`, `target`, `dist`, `build`, `.next`, `__pycache__`,
`.venv`) don't count, so a build can't crowd out an edit. When more than 500
files change at once, every open file is checked again and the tree is read
again.

## Requirements

* macOS 13 or later, Windows 10 or 11, or a 64-bit Linux (see
  [Continuous builds and releases](#continuous-builds-and-releases)).
* `git` (comes with the Xcode command-line tools).
* The agents you want: `claude`, `codex` and `grok` on your PATH and signed
  in. Orbit IDE reads the PATH and environment from your login shell once,
  so anything that works in Terminal works here, with any shell (zsh, bash,
  fish and others). Agents start through `/bin/sh` with that environment,
  and the login shell takes over the tab when they exit. OpenRouter needs an
  API key, entered in Settings.

## Running from source

```sh
npm install            # fetches Monaco, xterm and the Tauri CLI
sh run.sh              # vendors the editor libraries if needed, then builds and launches
```

`run.sh` and `build_orbit_ide_dmg.sh` re-run `scripts/vendor.sh` whenever
`ui/vendor` is missing or was made from different inputs, so a `git pull`
never leaves a stale copy behind.

The page lives in `ui/` with no bundler: plain HTML, CSS and ES modules.
Tauri embeds `ui/` into the binary at compile time, so rebuild after editing
the page. With `ORBIT_IDE_SELFTEST=1` the app runs a smoke test after boot
and prints the results to the terminal that launched it. `cargo test` in
`src-tauri` runs the native side's tests, as the release workflow does before
every build.

## Building the Mac app

```sh
sh build_orbit_ide_dmg.sh
```

This produces `src-tauri/target/release/bundle/macos/Orbit IDE.app` and
`dist/OrbitIDE.dmg`. A local build is ad-hoc signed; the first launch may need a
right-click, Open. Release builds are signed with a Developer ID and notarized
(see Continuous builds and releases). Arguments after the script go to `tauri build`, which is
how the release workflow stamps the version.

## Updates

Orbit IDE keeps itself up to date through Orbit Mission Control. Half a
minute after launch and every four hours after that it asks
`https://control.orbit.com.ai/api/updates/orbit-ide/<target>/<arch>/<version>?build=<n>`,
and Mission Control answers from this repository's GitHub releases with the
newest build, or nothing. **Check for Updates…** in the Orbit IDE menu on the
Mac asks straight away.

A newer build is downloaded in the background and checked against the public
key in `src-tauri/tauri.conf.json` (`plugins > updater > pubkey`); the
signature must also name the version Mission Control announced. Then the app
asks to restart. On the Mac, **Later** installs it when Orbit IDE quits (unless
the app sits in a folder that needs a password, in which case it asks again at
the next launch). On Windows the installer closes the app, so it only runs when
you choose **Restart Now**, after the terminals are closed.

Builds are ordered by their build number, the release workflow's run number,
which CI compiles in as `ORBIT_BUILD`. A local build has none and is compared
by version, so it is only offered something with a higher version. Debug
builds don't check unless pointed at a Mission Control:

```sh
ORBIT_UPDATES_URL=http://127.0.0.1:8001 sh run.sh
```

Which builds are offered (every build from `main`, or tagged releases only)
and pausing updates after a bad build are set in Mission Control under
**Updates › Desktop apps**.

## Layout of the repository

```
ui/                 the page: index.html, app.css, js/*.js, vendor/ (generated)
src-tauri/src/      the native side
  main.rs           commands the page can call
  shell.rs          the login PATH every subprocess and terminal gets
  settings.rs       settings file (app data folder, owner-readable only)
  fsops.rs          files, search and replace, quick-open listing, change watcher
  lsp.rs            language servers: finding, starting, passing messages
  git.rs            git through the git command
  pty.rs            pseudo-terminals for shells and agents
  ai.rs             one-shot completions through the CLIs, OpenRouter chat
  updates.rs        updates from Orbit Mission Control
scripts/            vendor.sh, the icon renderer and builder
.github/            the build and release workflow, and the update manifest script
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
* for Linux, built on Ubuntu 22.04 by a job of its own that never holds the
  release back: `Orbit-IDE-Linux-amd64.deb` (Ubuntu, Debian, Mint, Pop!_OS),
  `Orbit-IDE-Linux-x86_64.rpm` (Fedora, RHEL, openSUSE) and
  `Orbit-IDE-Linux-x86_64.AppImage` (everything else). Only the AppImage
  updates itself; a package is updated by the Orbit Installer for Linux
  (`curl -fsSL https://orbit.com.ai/install.sh | bash`) or a newer package.
  Move to Trash uses `gio trash` there.
* `Orbit-IDE-macOS.app.tar.gz`, the Mac update bundle, and
  `orbit-update.json`, which names the version and build and carries the
  signature of each update bundle (the Windows installer doubles as its own).
  Mission Control offers a release to installed apps only once it has this
  file.

Pushing a tag such as `v0.2.0` publishes a full release under that tag. The
version stamped into each build is its tag without the `v`
(`0.1.0-build.13`, `0.2.0`), set with `tauri build --config`; raise
`version` in `tauri.conf.json` and `Cargo.toml` to move the base.

The update signatures need two repository secrets, the key whose public
half is in `tauri.conf.json`:

* `TAURI_SIGNING_PRIVATE_KEY`: the private key, as written by
  `npx tauri signer generate`
* `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password

Without them the apps still build and publish, with a warning, but installed
copies are not offered them. Replacing the key means changing `pubkey` too,
and copies built with the old key can't verify updates signed with the new
one: they need one manual install.

The Mac build is signed with a Developer ID, with the hardened runtime, and
notarized when these repository secrets are set, the same in every Orbit
repository with a Mac app. The Orbit Installer only installs a build signed
this way:

* `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD`: a "Developer ID
  Application" certificate with its private key, base64, and its password
* `APPLE_TEAM_ID`: the Apple Developer team ID
* `NOTARY_APPLE_ID`, `NOTARY_PASSWORD`: an Apple ID on the team and an
  app-specific password for `notarytool`

Without them the Mac build is ad-hoc signed and not notarized, with a
warning. The Windows build is unsigned.

On Windows the agents run through `cmd.exe` so the npm-installed `claude`,
`codex` and `grok` launchers resolve, and the terminal is PowerShell. The
native side hands the page every path with forward slashes, which Windows
accepts back, so the page's path handling is the same on both systems. Move
to Trash uses the Recycle Bin; where a drive has none, Windows asks before it
deletes anything.
