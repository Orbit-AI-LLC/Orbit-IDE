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
  if (entry.staged && !entry.unstaged) return "all";
  if (entry.staged && entry.unstaged) return "part";
  return "none";
}

function render() {
  const v = view();
  host.innerHTML = "";
  if (!v) { host.append(el("div", { class: "git-empty", text: "Open a project to see its source control." })); return; }
  const status = v.git;
  if (!status) { host.append(el("div", { class: "git-empty", text: "Loading…" })); return; }
  if (!status.is_repo) {
    host.append(el("div", { class: "git-empty" }, [
      el("p", { text: status.error || "This folder is not a git repository." }),
      el("button", { class: "btn primary", text: "Initialize repository", onclick: async () => {
        try { await api.gitInit(v.path); toast("Repository initialized.", "success"); refreshGit(); } catch (err) { toast(formatError(err), "error"); }
      } }),
    ]));
    return;
  }
  const entries = status.entries;
  const selected = entries.filter((e) => e.staged);
  const totals = entries.reduce((t, e) => { t.add += e.add; t.del += e.del; return t; }, { add: 0, del: 0 });
  const wrap = el("div", { class: "git-panel" });

  // Branch and sync.
  const branchBtn = el("button", { class: "branch-btn", title: "Switch branch" }, [el("span", { text: status.branch }), el("span", { class: "caret", text: "▾" })]);
  branchBtn.addEventListener("click", () => branchMenu(branchBtn));
  const sync = el("div", { class: "git-sync" }, [
    el("button", { class: "icon-btn", title: "Fetch", text: "↻", onclick: () => sync_(() => api.gitFetch(status.root), "Fetched.") }),
    el("button", { class: "icon-btn", title: "Pull", onclick: () => sync_(() => api.gitPull(status.root), "Pulled.") }, [`↓${status.behind ? " " + status.behind : ""}`]),
    el("button", { class: "icon-btn", title: status.upstream ? "Push" : "Publish branch", onclick: () => sync_(() => api.gitPush(status.root), "Pushed.") }, [`↑${status.ahead ? " " + status.ahead : ""}`]),
  ]);
  const top = el("div", { class: "git-top" }, [el("div", { class: "git-branch-row" }, [branchBtn, sync])]);

  // Commit box.
  const textarea = el("textarea", { placeholder: selected.length ? `Message for ${selected.length} ${selected.length === 1 ? "file" : "files"} (⌘Enter to commit)` : "Select files below, then write or generate a message", spellcheck: "true" });
  textarea.value = v.commitDraft || "";
  textarea.addEventListener("input", () => { v.commitDraft = textarea.value; });
  textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); doCommit(textarea, false); }
  });
  const currentProvider = provider(state.settings.commit_provider) || state.providers[0] || { id: "claude", name: "Claude" };
  const generateBtn = el("button", { class: `btn ${generating ? "busy" : ""}`, title: `Write the message from the selected changes with ${currentProvider.name}`, disabled: generating }, [generating ? "Writing…" : "✦ Generate"]);
  generateBtn.addEventListener("click", () => generateMessage(textarea, currentProvider.id));
  const providerBtn = el("button", { class: "btn", title: "Provider that writes the message", disabled: generating }, [el("span", { class: "ellipsis", text: currentProvider.name }), el("span", { class: "caret", text: "▾" })]);
  providerBtn.addEventListener("click", () => {
    const rect = providerBtn.getBoundingClientRect();
    contextMenu(rect.left, rect.bottom + 4, state.providers.map((p) => ({
      label: `${p.id === currentProvider.id ? "✓ " : ""}${p.name}${p.available ? "" : "  (not set up)"}`,
      action: () => { saveSettings({ commit_provider: p.id }); render(); },
    })));
  });
  const commitBtn = el("button", { class: "btn primary", disabled: busy || generating, onclick: () => doCommit(textarea, false) }, [busy ? "Working…" : selected.length ? `Commit ${selected.length} ${selected.length === 1 ? "file" : "files"}` : "Commit"]);
  const moreBtn = el("button", { class: "btn primary caret-btn", text: "▾", title: "More ways to commit", disabled: busy, onclick: () => {
    const rect = moreBtn.getBoundingClientRect();
    contextMenu(rect.right - 200, rect.bottom + 4, [
      { label: "Commit", action: () => doCommit(textarea, false) },
      { label: "Commit and push", action: () => doCommit(textarea, true) },
      { label: "Amend last commit", action: async () => {
        if (await confirmDialog("Amend the last commit?", "The selected changes and this message replace the previous commit. Avoid this on a pushed branch.", { ok: "Amend" })) commitWith(textarea, { amend: true });
      } },
      { separator: true },
      { label: "Select all and commit", action: async () => { await api.gitStage(status.root, []); await refreshGit(); doCommit(host.querySelector("textarea") || textarea, false); } },
    ]);
  } });
  top.append(el("div", { class: "commit-box" }, [
    textarea,
    el("div", { class: "commit-row split" }, [generateBtn, providerBtn]),
    el("div", { class: "commit-row split" }, [commitBtn, moreBtn]),
  ]));
  wrap.append(top);

  // The changes list.
  const lists = el("div", { class: "panel-body git-lists" });
  if (!entries.length) lists.append(el("div", { class: "git-empty", text: "No changes." }));
  else {
    const allState = entries.every((e) => stagedState(e) === "all") ? "all" : entries.some((e) => e.staged) ? "part" : "none";
    const master = el("input", { type: "checkbox", title: allState === "all" ? "Unselect all" : "Select all" });
    master.checked = allState === "all";
    master.indeterminate = allState === "part";
    master.addEventListener("change", () => act(() => allState === "all" ? api.gitUnstage(status.root, []) : api.gitStage(status.root, [])));
    lists.append(el("div", { class: "git-section-header" }, [
      master,
      el("span", { text: "Changes" }),
      el("span", { class: "count", text: `${selected.length}/${entries.length}` }),
      counter(totals.add, totals.del),
      el("div", { class: "panel-actions" }, [
        el("button", { class: "icon-btn sm", title: "Discard all changes", text: "↶", onclick: () => discard(status, entries.filter((e) => !e.conflicted)) }),
      ]),
    ]));
    for (const entry of entries) lists.append(row(status, entry));
  }
  // Recent commits.
  const log = v.log || [];
  if (log.length) {
    const header = el("div", { class: "git-section-header clickable" }, [
      el("span", { class: "tree-arrow", text: "▶", style: showLog ? "transform:rotate(90deg)" : "" }),
      el("span", { text: "Commits" }), el("span", { class: "count", text: log.length }),
    ]);
    header.addEventListener("click", () => { showLog = !showLog; render(); });
    lists.append(header);
    if (showLog) for (const c of log) {
      lists.append(el("div", { class: "git-log-row", title: `${c.hash}\n${c.author}, ${c.when}` }, [el("span", { class: "hash", text: c.short }), el("span", { class: "subject", text: c.subject }), el("span", { class: "when", text: c.when })]));
    }
  }
  wrap.append(lists);
  host.append(wrap);
}

function row(status, entry) {
  const v = view();
  const abs = joinPath(status.root, entry.path);
  const letter = entry.untracked ? "U" : entry.conflicted ? "C" : (entry.worktree !== " " ? entry.worktree : entry.index);
  const dir = dirname(entry.path);
  const sel = stagedState(entry);
  const box = el("input", { type: "checkbox", title: sel === "conflict" ? "Resolve the conflict first" : sel === "all" ? "Unselect (unstage)" : "Select for commit (stage)" });
  box.checked = sel === "all";
  box.indeterminate = sel === "part";
  box.disabled = sel === "conflict";
  box.addEventListener("click", (event) => event.stopPropagation());
  box.addEventListener("change", () => act(() => sel === "all" ? api.gitUnstage(status.root, [entry.path]) : api.gitStage(status.root, [entry.path])));
  const node = el("div", { class: `git-row ${v.gitSelected === entry.path ? "selected" : ""} ${sel === "all" ? "checked" : ""}`, title: entry.path }, [
    box,
    el("span", { class: "name", text: basename(entry.path) }),
    el("span", { class: "dir", text: dir === "/" || dir === "." ? "" : dir }),
    entry.add || entry.del ? counter(entry.add, entry.del) : null,
    el("span", { class: "row-actions" }, [
      el("button", { class: "icon-btn sm", title: "Open file", text: "↗", onclick: (event) => { event.stopPropagation(); openFile(abs); } }),
      !entry.conflicted ? el("button", { class: "icon-btn sm", title: "Discard changes", text: "↶", onclick: (event) => { event.stopPropagation(); discard(status, [entry]); } }) : null,
    ]),
    el("span", { class: `letter s-${letter}`, text: letter }),
  ]);
  node.addEventListener("click", () => { v.gitSelected = entry.path; showDiff(status, entry); render(); });
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
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
  refreshGit();
}

async function discard(status, entries) {
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

async function doCommit(textarea, push) {
  const v = view();
  const status = v.git;
  if (!status.entries.some((e) => e.staged)) {
    if (!status.entries.length) { toast("There are no changes to commit."); return; }
    const ok = await confirmDialog("No files are selected", "Select all changes and commit them?", { ok: "Select all and commit" });
    if (!ok) return;
    await api.gitStage(status.root, []).catch((err) => toast(formatError(err), "error"));
  }
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
  if (!status.entries.some((e) => e.staged)) {
    if (!status.entries.length) { toast("There are no changes to describe."); return; }
    const ok = await confirmDialog("No files are selected", "Select all changes and write a message for them?", { ok: "Select all" });
    if (!ok) return;
    try { await api.gitStage(status.root, []); } catch (err) { toast(formatError(err), "error"); return; }
    await refreshGit();
  }
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
  } catch (err) { toast(formatError(err), "error"); }
  generating = false;
  render();
  const box = host.querySelector("textarea");
  if (box) box.focus();
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
