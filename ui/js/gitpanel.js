// The source control sidebar: branch, sync, a single changes list with
// checkboxes (checked means staged), diffs, commits, and the AI-written
// commit message.
import { api } from "./api.js";
import { state, view, saveSettings, emit, on, provider, projectName, commitInstructions } from "./state.js";
import { $, el, basename, dirname, joinPath, toast, formatError, contextMenu, confirmDialog, promptDialog, debounce } from "./ui.js";
import { openFile, openDiff, languageFor, saveAll } from "./editor.js";
import { setGitDecorations } from "./explorer.js";

let host;
let busy = false;
let generating = false;
let showLog = false;
const MAX_DIFF_CHARS = 90_000;

export function initGit() {
  host = $("#git-panel");
  $("#btn-git-refresh").addEventListener("click", () => refreshGit());
  $("#status-branch").addEventListener("click", () => branchMenu($("#status-branch")));
  on("saved", () => refreshGitSoon());
  on("providers", () => render());
}

export const refreshGitSoon = debounce(() => refreshGit(), 400);

export async function refreshGit() {
  const v = view();
  if (!v) { render(); updateStatusBar(null); setGitDecorations(null); return; }
  try {
    const status = await api.gitStatus(v.path);
    // Nested repositories (submodules, agent worktrees) are left out: their
    // work is committed from inside them, not from here.
    status.entries = status.entries.filter((e) => !e.submodule);
    v.git = status;
    if (status.is_repo) v.log = await api.gitLog(status.root, 30).catch(() => []);
  } catch (err) {
    v.git = { is_repo: false, root: v.path, entries: [], error: formatError(err) };
  }
  if (v === view()) {
    render();
    updateStatusBar(v.git);
    setGitDecorations(v.git);
  }
}

function updateStatusBar(status) {
  const branch = $("#status-branch");
  const sync = $("#status-sync");
  const badge = $("#git-badge");
  if (!status || !status.is_repo) {
    branch.textContent = status ? "No repository" : "";
    sync.textContent = "";
    badge.hidden = true;
    return;
  }
  branch.innerHTML = `<svg viewBox="0 0 16 16" width="11" height="11"><circle cx="5" cy="3.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5" cy="12.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11" cy="6" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 5v6M11 7.6c0 2.4-6 1.6-6 3.4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`;
  branch.append(document.createTextNode(status.branch));
  const parts = [];
  if (status.behind) parts.push(`↓${status.behind}`);
  if (status.ahead) parts.push(`↑${status.ahead}`);
  sync.textContent = parts.join(" ");
  const count = status.entries.length;
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? "99+" : String(count);
}

/// "+12 −3" in green and red.
function counter(add, del, cls = "") {
  return el("span", { class: `linecount ${cls}`, title: `${add} lines added, ${del} removed` }, [
    el("span", { class: "add", text: `+${add}` }),
    el("span", { class: "del", text: `−${del}` }),
  ]);
}

function stagedState(entry) {
  if (entry.conflicted) return "conflict";
  if (!entry.stageable) return "locked";
  if (entry.staged && !entry.unstaged) return "all";
  if (entry.staged && entry.unstaged) return "part";
  return "none";
}

// The panel's chrome (branch row, commit box) is built once per repository
// and updated in place: a rebuild on every refresh would replace the button
// under a click in progress (files change constantly while an agent works)
// and drop the click.
let ui = null;

function render() {
  const v = view();
  const status = v && v.git;
  if (!v || !status || !status.is_repo) {
    ui = null;
    host.innerHTML = "";
    if (!v) { host.append(el("div", { class: "git-empty", text: "Open a project to see its source control." })); return; }
    if (!status) { host.append(el("div", { class: "git-empty", text: "Loading…" })); return; }
    host.append(el("div", { class: "git-empty" }, [
      el("p", { text: status.error || "This folder is not a git repository." }),
      el("button", { class: "btn primary", text: "Initialize repository", onclick: async () => {
        try { await api.gitInit(v.path); toast("Repository initialized.", "success"); refreshGit(); } catch (err) { toast(formatError(err), "error"); }
      } }),
    ]));
    return;
  }
  if (!ui || ui.path !== v.path || !host.contains(ui.wrap)) buildUi(v);
  updateUi(v);
}

function currentStatus() {
  const v = view();
  return v && v.git && v.git.is_repo ? v.git : null;
}

function buildUi(v) {
  host.innerHTML = "";
  const u = { path: v.path, listKey: null };
  // Branch and sync.
  u.branchBtn = el("button", { class: "branch-btn", title: "Switch branch" }, [el("span", { text: "" }), el("span", { class: "caret", text: "▾" })]);
  u.branchBtn.addEventListener("click", () => branchMenu(u.branchBtn));
  u.fetchBtn = el("button", { class: "icon-btn", title: "Fetch", text: "↻", onclick: () => { const s = currentStatus(); if (s) sync_(() => api.gitFetch(s.root), "Fetched."); } });
  u.pullBtn = el("button", { class: "icon-btn", title: "Pull", onclick: () => { const s = currentStatus(); if (s) sync_(() => api.gitPull(s.root), "Pulled."); } });
  u.pushBtn = el("button", { class: "icon-btn", title: "Push", onclick: () => { const s = currentStatus(); if (s) sync_(() => api.gitPush(s.root), "Pushed."); } });
  // Commit box.
  u.textarea = el("textarea", { spellcheck: "true" });
  u.textarea.value = v.commitDraft || "";
  u.textarea.addEventListener("input", () => { v.commitDraft = u.textarea.value; });
  u.textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); doCommit(u.textarea, false); }
  });
  u.generateBtn = el("button", { class: "btn", text: "✦ Generate" });
  u.generateBtn.addEventListener("click", () => generateMessage(u.textarea, state.settings.commit_provider));
  u.providerLabel = el("span", { class: "ellipsis", text: "" });
  u.providerBtn = el("button", { class: "btn", title: "Provider that writes the message" }, [u.providerLabel, el("span", { class: "caret", text: "▾" })]);
  u.providerBtn.addEventListener("click", () => {
    const rect = u.providerBtn.getBoundingClientRect();
    contextMenu(rect.left, rect.bottom + 4, state.providers.map((p) => ({
      label: `${p.id === state.settings.commit_provider ? "✓ " : ""}${p.name}${p.available ? "" : "  (not set up)"}`,
      action: () => { saveSettings({ commit_provider: p.id }); render(); },
    })));
  });
  u.commitBtn = el("button", { class: "btn primary", text: "Commit", onclick: () => doCommit(u.textarea, false) });
  u.moreBtn = el("button", { class: "btn primary caret-btn", text: "▾", title: "More ways to commit" });
  u.moreBtn.addEventListener("click", () => {
    const rect = u.moreBtn.getBoundingClientRect();
    contextMenu(rect.right - 200, rect.bottom + 4, [
      { label: "Commit", action: () => doCommit(u.textarea, false) },
      { label: "Commit and push", action: () => doCommit(u.textarea, true) },
      { label: "Amend last commit", action: async () => {
        if (await confirmDialog("Amend the last commit?", "The selected changes and this message replace the previous commit. Avoid this on a pushed branch.", { ok: "Amend" })) commitWith(u.textarea, { amend: true });
      } },
      { separator: true },
      { label: "Select all and commit", action: async () => { const s = currentStatus(); if (!s) return; const paths = s.entries.filter((e) => e.stageable && !e.conflicted).map((e) => e.path); if (paths.length) await api.gitStage(s.root, paths).catch((err) => toast(formatError(err), "error")); if (ui) ui.listKey = null; await refreshGit(); doCommit(u.textarea, false); } },
    ]);
  });
  u.top = el("div", { class: "git-top" }, [
    el("div", { class: "git-branch-row" }, [u.branchBtn, el("div", { class: "git-sync" }, [u.fetchBtn, u.pullBtn, u.pushBtn])]),
    el("div", { class: "commit-box" }, [
      u.textarea,
      el("div", { class: "commit-row split" }, [u.generateBtn, u.providerBtn]),
      el("div", { class: "commit-row split" }, [u.commitBtn, u.moreBtn]),
    ]),
  ]);
  u.lists = el("div", { class: "panel-body git-lists" });
  u.wrap = el("div", { class: "git-panel" }, [u.top, u.lists]);
  host.append(u.wrap);
  ui = u;
}

function updateUi(v) {
  const u = ui;
  const status = v.git;
  const entries = status.entries;
  const stageable = entries.filter((e) => e.stageable);
  const selected = entries.filter((e) => e.staged);
  // Branch and sync.
  u.branchBtn.firstChild.textContent = status.branch;
  u.pullBtn.textContent = `↓${status.behind ? " " + status.behind : ""}`;
  u.pushBtn.textContent = `↑${status.ahead ? " " + status.ahead : ""}`;
  u.pushBtn.title = status.upstream ? "Push" : "Publish branch";
  for (const b of [u.fetchBtn, u.pullBtn, u.pushBtn]) b.disabled = busy;
  // Commit box.
  u.textarea.placeholder = selected.length ? `Message for ${selected.length} ${selected.length === 1 ? "file" : "files"} (⌘Enter to commit)` : "Select files below, then write or generate a message";
  if (document.activeElement !== u.textarea && u.textarea.value !== (v.commitDraft || "")) u.textarea.value = v.commitDraft || "";
  const current = provider(state.settings.commit_provider) || state.providers[0] || { id: "claude", name: "Claude" };
  u.providerLabel.textContent = current.name;
  u.generateBtn.textContent = generating ? "Writing…" : "✦ Generate";
  u.generateBtn.classList.toggle("busy", generating);
  u.generateBtn.title = `Write the message from the selected changes with ${current.name}`;
  u.generateBtn.disabled = generating;
  u.providerBtn.disabled = generating;
  u.commitBtn.textContent = busy ? "Working…" : selected.length ? `Commit ${selected.length} ${selected.length === 1 ? "file" : "files"}` : "Commit";
  u.commitBtn.disabled = busy || generating;
  u.moreBtn.disabled = busy;
  // The list, rebuilt only when its content changed.
  const log = v.log || [];
  const key = JSON.stringify([entries.map((e) => [e.path, e.index, e.worktree, e.staged, e.unstaged, e.add, e.del, e.sub_changes]), showLog, log.map((c) => c.short), v.gitSelected]);
  if (key === u.listKey) return;
  u.listKey = key;
  u.lists.innerHTML = "";
  if (!entries.length) u.lists.append(el("div", { class: "git-empty", text: "No changes." }));
  else {
    const totals = stageable.reduce((t, e) => { t.add += e.add; t.del += e.del; return t; }, { add: 0, del: 0 });
    const allState = stageable.length && stageable.every((e) => stagedState(e) === "all") ? "all" : stageable.some((e) => e.staged) ? "part" : "none";
    const master = el("input", { type: "checkbox", title: !stageable.length ? "Nothing here can be staged from this repository" : allState === "all" ? "Unselect all" : "Select all" });
    master.checked = allState === "all";
    master.indeterminate = allState === "part";
    master.disabled = !stageable.length;
    master.addEventListener("change", () => act(() => allState === "all" ? api.gitUnstage(status.root, []) : api.gitStage(status.root, stageable.map((e) => e.path))));
    u.lists.append(el("div", { class: "git-section-header" }, [
      master,
      el("span", { text: "Changes" }),
      el("span", { class: "count", text: `${selected.length}/${stageable.length}` }),
      counter(totals.add, totals.del),
      el("div", { class: "panel-actions" }, [
        el("button", { class: "icon-btn sm", title: "Discard all changes", text: "↶", onclick: () => discard(status, entries.filter((e) => !e.conflicted)) }),
      ]),
    ]));
    for (const entry of entries) u.lists.append(row(status, entry));
  }
  if (log.length) {
    const header = el("div", { class: "git-section-header clickable" }, [
      el("span", { class: "tree-arrow", text: "▶", style: showLog ? "transform:rotate(90deg)" : "" }),
      el("span", { text: "Commits" }), el("span", { class: "count", text: log.length }),
    ]);
    header.addEventListener("click", () => { showLog = !showLog; render(); });
    u.lists.append(header);
    if (showLog) for (const c of log) {
      u.lists.append(el("div", { class: "git-log-row", title: `${c.hash}\n${c.author}, ${c.when}` }, [el("span", { class: "hash", text: c.short }), el("span", { class: "subject", text: c.subject }), el("span", { class: "when", text: c.when })]));
    }
  }
}

function row(status, entry) {
  const v = view();
  const abs = joinPath(status.root, entry.path);
  const letter = entry.untracked ? "U" : entry.conflicted ? "C" : (entry.worktree !== " " ? entry.worktree : entry.index);
  const dir = dirname(entry.path);
  const sel = stagedState(entry);
  const nestedNote = entry.submodule && entry.sub_dirty
    ? `${entry.sub_changes || "Uncommitted"} ${entry.sub_changes === 1 ? "change" : "changes"} inside this nested repository. Commit them from inside it: open it as a project.`
    : "";
  const box = el("input", { type: "checkbox", title: sel === "conflict" ? "Resolve the conflict first" : sel === "locked" ? nestedNote : sel === "all" ? "Unselect (unstage)" : "Select for commit (stage)" });
  box.checked = sel === "all";
  box.indeterminate = sel === "part";
  box.disabled = sel === "conflict" || sel === "locked";
  box.addEventListener("click", (event) => event.stopPropagation());
  box.addEventListener("change", () => act(() => sel === "all" ? api.gitUnstage(status.root, [entry.path]) : api.gitStage(status.root, [entry.path])));
  const node = el("div", { class: `git-row ${v.gitSelected === entry.path ? "selected" : ""} ${sel === "all" ? "checked" : ""}`, title: entry.path }, [
    box,
    el("span", { class: "name", text: basename(entry.path) }),
    el("span", { class: "dir", text: dir === "/" || dir === "." ? "" : dir }),
    entry.submodule
      ? el("span", { class: "nested-tag", title: nestedNote || "Submodule", text: entry.sub_dirty ? `nested repo · ${entry.sub_changes || "?"}` : "submodule" })
      : (entry.add || entry.del ? counter(entry.add, entry.del) : null),
    el("span", { class: "row-actions" }, entry.submodule ? [
      el("button", { class: "icon-btn sm", title: "Open as project", text: "↗", onclick: (event) => { event.stopPropagation(); emit("open-project", abs); } }),
    ] : [
      el("button", { class: "icon-btn sm", title: "Open file", text: "↗", onclick: (event) => { event.stopPropagation(); openFile(abs); } }),
      !entry.conflicted ? el("button", { class: "icon-btn sm", title: "Discard changes", text: "↶", onclick: (event) => { event.stopPropagation(); discard(status, [entry]); } }) : null,
    ]),
    el("span", { class: `letter s-${letter}`, text: letter }),
  ]);
  node.addEventListener("click", async (event) => {
    if (entry.submodule) { nestedMenu(abs, event.clientX, event.clientY); return; }
    v.gitSelected = entry.path; showDiff(status, entry); render();
  });
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (entry.submodule) {
      contextMenu(event.clientX, event.clientY, [
        { label: "Open as project", action: () => emit("open-project", abs) },
        entry.stageable ? (sel === "all" ? { label: "Unselect", action: () => act(() => api.gitUnstage(status.root, [entry.path])) } : { label: "Select for commit", action: () => act(() => api.gitStage(status.root, [entry.path])) }) : null,
        { separator: true },
        { label: "Reveal in Finder", action: () => api.reveal(abs) },
        { label: "Copy path", action: () => navigator.clipboard.writeText(abs) },
      ]);
      return;
    }
    contextMenu(event.clientX, event.clientY, [
      { label: "Open file", action: () => openFile(abs) },
      { label: "Open changes", action: () => showDiff(status, entry) },
      { separator: true },
      sel === "all" ? { label: "Unselect", action: () => act(() => api.gitUnstage(status.root, [entry.path])) } : { label: "Select for commit", action: () => act(() => api.gitStage(status.root, [entry.path])) },
      { label: "Discard changes", danger: true, action: () => discard(status, [entry]) },
      { separator: true },
      { label: "Reveal in Finder", action: () => api.reveal(abs) },
      { label: "Copy path", action: () => navigator.clipboard.writeText(abs) },
    ]);
  });
  return node;
}

/// A nested repository's own changed files: pick one to see its diff
/// (against the nested repository's HEAD), or open it as a project.
async function nestedMenu(abs, x, y) {
  let inner;
  try { inner = await api.gitStatus(abs); } catch (err) { toast(formatError(err), "error"); return; }
  const items = [{ label: "Open as project", action: () => emit("open-project", abs) }];
  if (inner && inner.is_repo && inner.entries.length) {
    items.push({ separator: true });
    for (const e of inner.entries.slice(0, 40)) {
      const letter = e.untracked ? "U" : e.conflicted ? "C" : (e.worktree !== " " ? e.worktree : e.index);
      items.push({ label: `${letter}   ${e.path}`, action: () => (e.submodule ? nestedMenu(joinPath(inner.root, e.path), x, y) : showDiff(inner, e)) });
    }
    if (inner.entries.length > 40) items.push({ label: `${inner.entries.length - 40} more: open as project to see them`, disabled: true });
  } else {
    items.push({ label: "No changes inside", disabled: true });
  }
  contextMenu(x, y, items);
}

/// HEAD against the working tree: the whole change for the file.
async function showDiff(status, entry) {
  const abs = joinPath(status.root, entry.path);
  try {
    const original = entry.untracked || entry.index === "A" ? "" : await api.gitShow(status.root, `HEAD:${entry.orig_path || entry.path}`);
    let modified = "";
    if (entry.worktree !== "D") {
      const file = await api.read(abs).catch(() => ({ content: "", binary: false }));
      if (file.binary) { toast("Binary file; no text diff."); return; }
      modified = file.content;
    }
    openDiff({ title: `${basename(entry.path)} (changes)`, path: abs, original, modified, language: languageFor(abs) });
  } catch (err) { toast(formatError(err), "error"); }
}

async function act(fn) {
  try { await fn(); } catch (err) { toast(formatError(err), "error"); }
  // Redraw the list from git even if nothing changed: a checkbox click has
  // already toggled the box, and staging may have done nothing.
  if (ui) ui.listKey = null;
  await refreshGit();
}

async function discard(status, entries) {
  entries = entries.filter((e) => !e.submodule);
  if (!entries.length) return;
  const names = entries.length === 1 ? basename(entries[0].path) : `${entries.length} files`;
  const ok = await confirmDialog(`Discard changes to ${names}?`, "Working tree changes are thrown away. New files are deleted. This cannot be undone.", { ok: "Discard", danger: true });
  if (!ok) return;
  const tracked = entries.filter((e) => !e.untracked).map((e) => e.path);
  const untracked = entries.filter((e) => e.untracked).map((e) => e.path);
  await act(async () => {
    if (tracked.length) await api.gitUnstage(status.root, tracked);
    await api.gitDiscard(status.root, tracked, untracked);
  });
  emit("fs-discarded", entries.map((e) => joinPath(status.root, e.path)));
}

async function sync_(fn, okMessage) {
  if (busy) return;
  busy = true;
  render();
  try {
    const out = await fn();
    toast(out && out.trim() ? out.trim().split("\n").slice(-3).join("\n") : okMessage, "success");
  } catch (err) { toast(formatError(err), "error"); }
  busy = false;
  await refreshGit();
}

/// Returns true once something is staged, staging everything stageable
/// (after asking) when nothing is. Explains when nothing can be staged.
async function ensureStaged(verb) {
  const status = view().git;
  if (status.entries.some((e) => e.staged)) return true;
  const stageable = status.entries.filter((e) => e.stageable && !e.conflicted);
  const nested = status.entries.filter((e) => e.submodule && !e.stageable);
  if (!stageable.length) {
    if (nested.length) {
      toast(`Nothing here can be staged. The only ${nested.length === 1 ? "change is" : "changes are"} inside ${nested.length === 1 ? "a nested repository" : "nested repositories"} (${nested.map((e) => e.path).join(", ")}). Open ${nested.length === 1 ? "it" : "them"} as a project to commit there.`, "error");
    } else {
      toast(`There are no changes to ${verb}.`);
    }
    return false;
  }
  const ok = await confirmDialog("No files are selected", `Select all ${stageable.length} ${stageable.length === 1 ? "change" : "changes"} and ${verb} ${stageable.length === 1 ? "it" : "them"}?`, { ok: "Select all" });
  if (!ok) return false;
  try { await api.gitStage(status.root, stageable.map((e) => e.path)); } catch (err) { toast(formatError(err), "error"); return false; }
  if (ui) ui.listKey = null;
  await refreshGit();
  if (!view().git.entries.some((e) => e.staged)) { toast("Git staged nothing. Check the changes list."); return false; }
  return true;
}

async function doCommit(textarea, push) {
  if (!(await ensureStaged("commit"))) return;
  await commitWith(textarea, { push });
}

async function commitWith(textarea, { push = false, amend = false } = {}) {
  const v = view();
  const message = textarea.value.trim();
  if (!message) { toast("Write a commit message first, or generate one."); textarea.focus(); return; }
  busy = true;
  render();
  try {
    await saveAll();
    const summary = await api.gitCommit(v.git.root, message, amend);
    v.commitDraft = "";
    if (ui && ui.textarea) ui.textarea.value = "";
    toast(`Committed ${summary}`, "success");
    if (push) {
      const out = await api.gitPush(v.git.root);
      toast(out && out.trim() ? out.trim().split("\n").slice(-2).join("\n") : "Pushed.", "success");
    }
  } catch (err) { toast(formatError(err), "error"); }
  busy = false;
  await refreshGit();
}

// ---- AI commit message -----------------------------------------------------------

export async function generateMessage(textarea, providerId) {
  const v = view();
  const status = v.git;
  if (!status || !status.is_repo || generating) return;
  const p = provider(providerId);
  if (p && !p.available) { toast(`${p.name}: ${p.detail}`, "error"); return; }
  if (!(await ensureStaged("describe"))) return;
  const current = view().git;
  const selected = current.entries.filter((e) => e.staged);
  const left = current.entries.filter((e) => !e.staged);
  generating = true;
  render();
  try {
    let diff = await api.gitDiffAll(current.root, true);
    if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated: the change is larger than shown]";
    const prompt = buildPrompt({ status: current, selected, left, diff, log: v.log || [] });
    const raw = await api.aiComplete(providerId, prompt, current.root, null);
    const message = cleanMessage(raw);
    if (!message) throw new Error("The provider returned an empty message.");
    v.commitDraft = message;
    if (ui && ui.textarea) ui.textarea.value = message;
  } catch (err) { toast(formatError(err), "error"); }
  generating = false;
  render();
  if (ui && ui.textarea) ui.textarea.focus();
}

function buildPrompt({ status, selected, left, diff, log }) {
  const files = selected.map((e) => `${e.index === "?" ? "A" : e.index} ${e.path}${e.orig_path ? ` (was ${e.orig_path})` : ""}  +${e.staged_add} -${e.staged_del}`).join("\n");
  const history = log.slice(0, 12).map((c) => `- ${c.subject}`).join("\n") || "- (no commits yet)";
  const excluded = left.length ? `\n\nChanged files NOT in this commit (do not describe them):\n${left.map((e) => `- ${e.path}`).join("\n")}` : "";
  return `${commitInstructions()}

Repository: ${projectName(status.root)}
Branch: ${status.branch}

Recent commit subjects, newest first (match their style):
${history}

Files in this commit (status letter, path, lines added and removed):
${files}${excluded}

Staged diff:
\`\`\`diff
${diff}
\`\`\``;
}

export function cleanMessage(raw) {
  let text = String(raw || "").replace(/\r/g, "").trim();
  // Fences, labels and quotes some models add despite the instructions.
  text = text.replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, "$1").trim();
  text = text.replace(/^(commit message|message)\s*:\s*/i, "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1).trim();
  // Trailers that attribute the commit to a tool, whatever the instructions said.
  const trailer = /^\s*(co-authored-by|signed-off-by|generated-by|generated-with|authored-by|assisted-by)\s*:/i;
  const lines = text.split("\n").filter((line) => !trailer.test(line) && !/generated with \[?claude|🤖 generated/i.test(line));
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length > 1 && lines[1].trim() !== "") lines.splice(1, 0, "");
  return lines.join("\n").trim();
}

// ---- branches ------------------------------------------------------------------

async function branchMenu(anchor) {
  const v = view();
  if (!v || !v.git || !v.git.is_repo) return;
  let branches;
  try { branches = await api.gitBranches(v.git.root); } catch (err) { toast(formatError(err), "error"); return; }
  const rect = anchor.getBoundingClientRect();
  const items = [
    { label: "New branch…", action: async () => {
      const name = await promptDialog("New branch", { placeholder: "feature/name", ok: "Create" });
      if (name && name.trim()) act(() => api.gitCheckout(v.git.root, name.trim(), true));
    } },
    { separator: true },
  ];
  for (const b of branches.local) items.push({ label: (b === branches.current ? "✓ " : "") + b, action: () => { if (b !== branches.current) act(() => api.gitCheckout(v.git.root, b, false)); } });
  if (branches.remote.length) {
    items.push({ separator: true });
    for (const b of branches.remote.slice(0, 30)) items.push({ label: b, action: () => act(() => api.gitCheckout(v.git.root, b.replace(/^[^/]+\//, ""), false)) });
  }
  const y = anchor.id === "status-branch" ? Math.max(8, rect.top - Math.min(items.length, 14) * 27 - 8) : rect.bottom + 4;
  contextMenu(rect.left, y, items);
}
