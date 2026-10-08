// The bridge to the Rust side. Every call goes through here so the rest of
// the page never touches window.__TAURI__ directly.
const T = window.__TAURI__;

export function invoke(cmd, args) {
  return T.core.invoke(cmd, args || {});
}

export function listen(name, handler) {
  return T.event.listen(name, (event) => handler(event.payload));
}

export const api = {
  appInfo: () => invoke("app_info"),
  // Windows and Linux: the app checks, then says what it found in a dialog of its own.
  checkForUpdates: () => invoke("check_for_updates"),
  log: (level, message) => invoke("ui_log", { level, message: String(message) }).catch(() => {}),
  settingsLoad: () => invoke("settings_load"),
  settingsSave: (settings) => invoke("settings_save", { settings }),
  defaultCommitInstructions: () => invoke("default_commit_instructions"),
  pickFolder: () => invoke("pick_folder"),

  resolve: (path) => invoke("fs_resolve", { path }),
  list: (path) => invoke("fs_list", { path }),
  read: (path) => invoke("fs_read", { path }),
  write: (path, content) => invoke("fs_write", { path, content }),
  create: (path, isDir) => invoke("fs_create", { path, isDir }),
  rename: (from, to) => invoke("fs_rename", { from, to }),
  remove: (path) => invoke("fs_delete", { path }),
  reveal: (path) => invoke("fs_reveal", { path }),
  openExternal: (target) => invoke("open_external", { target }),
  walk: (root) => invoke("fs_walk", { root }),
  search: (root, query) => invoke("fs_search", { root, query }),
  watch: (root) => invoke("fs_watch", { root }),

  gitStatus: (repo) => invoke("git_status", { repo }),
  gitStage: (repo, paths) => invoke("git_stage", { repo, paths }),
  gitUnstage: (repo, paths) => invoke("git_unstage", { repo, paths }),
  gitDiscard: (repo, tracked, untracked) => invoke("git_discard", { repo, tracked, untracked }),
  gitDiff: (repo, path, staged, untracked) => invoke("git_diff", { repo, path, staged, untracked }),
  gitDiffAll: (repo, staged) => invoke("git_diff_all", { repo, staged }),
  gitShow: (repo, spec) => invoke("git_show", { repo, spec }),
  gitCommit: (repo, message, amend) => invoke("git_commit", { repo, message, amend: !!amend }),
  gitLog: (repo, count) => invoke("git_log", { repo, count }),
  gitBranches: (repo) => invoke("git_branches", { repo }),
  gitCheckout: (repo, name, create) => invoke("git_checkout", { repo, name, create: !!create }),
  gitPush: (repo) => invoke("git_push", { repo }),
  gitPull: (repo) => invoke("git_pull", { repo }),
  gitFetch: (repo) => invoke("git_fetch", { repo }),
  gitInit: (path) => invoke("git_init", { path }),

  ptySpawn: (cwd, program, args, cols, rows) => invoke("pty_spawn", { cwd, program, args, cols, rows }),
  ptyWrite: (id, data) => invoke("pty_write", { id, data }),
  ptyResize: (id, cols, rows) => invoke("pty_resize", { id, cols, rows }),
  ptyKill: (id) => invoke("pty_kill", { id }),

  aiProviders: () => invoke("ai_providers"),
  aiComplete: (provider, prompt, cwd, model) => invoke("ai_complete", { provider, prompt, cwd, model: model || null }),
  aiClaudeSessions: () => invoke("ai_claude_sessions"),
  aiModels: () => invoke("ai_openrouter_models"),
  aiChat: (id, model, messages) => invoke("ai_openrouter_chat", { id, model, messages }),
  aiCancel: (id) => invoke("ai_cancel", { id }),
};

export function onDragDrop(handler) {
  return T.event.listen("tauri://drag-drop", (event) => handler(event.payload && event.payload.paths ? event.payload.paths : []));
}
export function onDragEnter(handler) {
  return T.event.listen("tauri://drag-enter", () => handler());
}
export function onDragLeave(handler) {
  return T.event.listen("tauri://drag-leave", () => handler());
}
