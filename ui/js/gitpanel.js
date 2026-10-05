// The source control sidebar: branch, sync, staging, diffs, commits, and the
// AI-written commit message.
import { api } from "./api.js";
import { state, view, saveSettings, emit, on, provider, projectName } from "./state.js";
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
  const staged = status.entries.filter((e) => e.staged);
  const changes = status.entries.filter((e) => e.unstaged);
  const wrap = el("div", { class: "git-panel" });

  // Branch and sync.
  const branchBtn = el("button", { class: "branch-btn", title: "Switch branch" }, [el("span", { text: status.branch }), el("span", { text: "▾", style: "font-size:10px;color:var(--text-faint)" })]);
  branchBtn.addEventListener("click", () => branchMenu(branchBtn));
  const sync = el("div", { class: "git-sync" }, [
    el("button", { class: "icon-btn", title: "Fetch", text: "↻", onclick: () => sync_(() => api.gitFetch(status.root), "Fetched.") }),
    el("button", { class: "icon-btn", title: "Pull", onclick: () => sync_(() => api.gitPull(status.root), "Pulled.") }, [`↓${status.behind ? " " + status.behind : ""}`]),
    el("button", { class: "icon-btn", title: status.upstream ? "Push" : "Publish branch", onclick: () => sync_(() => api.gitPush(status.root), "Pushed.") }, [`↑${status.ahead ? " " + status.ahead : ""}`]),
  ]);
  const totals = (list, staged) => list.reduce((t, e) => { t.add += staged ? e.staged_add : e.work_add; t.del += staged ? e.staged_del : e.work_del; return t; }, { add: 0, del: 0 });
  const all = { add: totals(staged, true).add + totals(changes, false).add, del: totals(staged, true).del + totals(changes, false).del };
  const top = el("div", { class: "git-top" }, [
    el("div", { class: "git-branch-row" }, [branchBtn, sync]),
    status.entries.length ? el("div", { class: "git-summary" }, [
      el("span", { text: `${status.entries.length} ${status.entries.length === 1 ? "file" : "files"} changed` }),
      counter(all.add, all.del),
    ]) : null,
  ]);

  // Commit box.
  const textarea = el("textarea", { placeholder: `Message (⌘Enter to commit on ${status.branch})`, spellcheck: "true" });
  textarea.value = v.commitDraft || "";
  textarea.addEventListener("input", () => { v.commitDraft = textarea.value; });
  textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); doCommit(textarea, false); }
  });
  const providerSelect = el("select", { title: "Provider that writes the message" });
  for (const p of state.providers) providerSelect.append(el("option", { value: p.id, text: p.name + (p.available ? "" : " (not set up)") }));
  providerSelect.value = state.settings.commit_provider || "claude";
  if (!state.providers.some((p) => p.id === providerSelect.value) && state.providers.length) providerSelect.value = state.providers[0].id;
  providerSelect.addEventListener("change", () => saveSettings({ commit_provider: providerSelect.value }));
  const generateBtn = el("button", { class: `btn ${generating ? "busy" : ""}`, title: "Write the commit message from the staged changes", disabled: generating }, [generating ? "Writing…" : "✦ Generate"]);
  generateBtn.addEventListener("click", () => generateMessage(textarea, providerSelect.value, generateBtn));
  const commitBtn = el("button", { class: "btn primary", text: "Commit", disabled: busy, onclick: () => doCommit(textarea, false) });
  const moreBtn = el("button", { class: "btn primary", text: "▾", title: "More", onclick: (event) => {
    const rect = moreBtn.getBoundingClientRect();
    contextMenu(rect.left, rect.bottom + 4, [
      { label: "Commit", action: () => doCommit(textarea, false) },
      { label: "Commit and push", action: () => doCommit(textarea, true) },
      { label: "Amend last commit", action: async () => {
        if (await confirmDialog("Amend the last commit?", "The staged changes and this message replace the previous commit. Avoid this on a pushed branch.", { ok: "Amend" })) commitWith(textarea, { amend: true });
      } },
      { separator: true },
      { label: "Stage all and commit", action: async () => { await api.gitStage(status.root, []); await refreshGit(); doCommit(textarea, false); } },
    ]);
  } });
  top.append(el("div", { class: "commit-box" }, [
    textarea,
    el("div", { class: "commit-row" }, [providerSelect, generateBtn, el("div", { class: "split-btn" }, [commitBtn, moreBtn])]),
  ]));
  wrap.append(top);

  // Lists.
  const lists = el("div", { class: "panel-body", style: "padding-bottom:12px" });
  if (status.entries.length === 0) lists.append(el("div", { class: "git-empty", text: "No changes." }));
  if (staged.length) {
    lists.append(sectionHeader("Staged changes", staged.length, totals(staged, true), [
      el("button", { class: "icon-btn sm", title: "Unstage all", text: "−", onclick: () => act(() => api.gitUnstage(status.root, [])) }),
    ]));
    for (const entry of staged) lists.append(row(status, entry, true));
  }
  if (changes.length) {
    lists.append(sectionHeader("Changes", changes.length, totals(changes, false), [
      el("button", { class: "icon-btn sm", title: "Discard all changes", text: "↶", onclick: () => discard(status, changes) }),
      el("button", { class: "icon-btn sm", title: "Stage all", text: "+", onclick: () => act(() => api.gitStage(status.root, [])) }),
    ]));
    for (const entry of changes) lists.append(row(status, entry, false));
  }
  // Recent commits.
  const log = v.log || [];
  if (log.length) {
    const header = sectionHeader(`Commits`, log.length, null, []);
    header.style.cursor = "default";
    header.insertBefore(el("span", { class: "tree-arrow", text: "▶", style: showLog ? "transform:rotate(90deg);margin-left:-10px" : "margin-left:-10px" }), header.firstChild);
    header.addEventListener("click", () => { showLog = !showLog; render(); });
    lists.append(header);
    if (showLog) for (const c of log) {
      lists.append(el("div", { class: "git-log-row", title: `${c.hash}\n${c.author}, ${c.when}` }, [el("span", { class: "hash", text: c.short }), el("span", { class: "subject", text: c.subject }), el("span", { class: "when", text: c.when })]));
    }
  }
  wrap.append(lists);
  host.append(wrap);
}

function sectionHeader(title, count, stats, actions) {
  return el("div", { class: "git-section-header" }, [el("span", { text: title }), el("span", { class: "count", text: count }), stats ? counter(stats.add, stats.del) : null, el("div", { class: "panel-actions" }, actions)]);
}

/// "+12 −3" in green and red.
function counter(add, del) {
  return el("span", { class: "linecount", title: `${add} lines added, ${del} removed` }, [
    el("span", { class: "add", text: `+${add}` }),
    el("span", { class: "del", text: `−${del}` }),
  ]);
}

function row(status, entry, staged) {
  const v = view();
  const abs = joinPath(status.root, entry.path);
  const letter = entry.untracked ? "U" : entry.conflicted ? "C" : (staged ? entry.index : entry.worktree);
  const dir = dirname(entry.path);
  const add = staged ? entry.staged_add : entry.work_add;
  const del = staged ? entry.staged_del : entry.work_del;
  const node = el("div", { class: `git-row ${v.gitSelected === staged + entry.path ? "selected" : ""}`, title: entry.path }, [
    el("span", { class: "name", text: basename(entry.path) }),
    el("span", { class: "dir", text: dir === "/" || dir === "." ? "" : dir }),
    add || del ? counter(add, del) : null,
    el("span", { class: "row-actions" }, [
      el("button", { class: "icon-btn sm", title: "Open file", text: "↗", onclick: (event) => { event.stopPropagation(); openFile(abs); } }),
      !staged && !entry.conflicted ? el("button", { class: "icon-btn sm", title: "Discard changes", text: "↶", onclick: (event) => { event.stopPropagation(); discard(status, [entry]); } }) : null,
      staged
        ? el("button", { class: "icon-btn sm", title: "Unstage", text: "−", onclick: (event) => { event.stopPropagation(); act(() => api.gitUnstage(status.root, [entry.path])); } })
        : el("button", { class: "icon-btn sm", title: "Stage", text: "+", onclick: (event) => { event.stopPropagation(); act(() => api.gitStage(status.root, [entry.path])); } }),
    ]),
    el("span", { class: `letter s-${letter}`, text: letter }),
  ]);
  node.addEventListener("click", () => { v.gitSelected = staged + entry.path; showDiff(status, entry, staged); render(); });
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    contextMenu(event.clientX, event.clientY, [
      { label: "Open file", action: () => openFile(abs) },
      { label: "Open changes", action: () => showDiff(status, entry, staged) },
      { separator: true },
      staged ? { label: "Unstage", action: () => act(() => api.gitUnstage(status.root, [entry.path])) } : { label: "Stage", action: () => act(() => api.gitStage(status.root, [entry.path])) },
      !staged ? { label: "Discard changes", danger: true, action: () => discard(status, [entry]) } : null,
      { separator: true },
      { label: "Reveal in Finder", action: () => api.reveal(abs) },
      { label: "Copy path", action: () => navigator.clipboard.writeText(abs) },
    ]);
  });
  return node;
}

async function showDiff(status, entry, staged) {
  const abs = joinPath(status.root, entry.path);
  try {
    let original = "", modified = "";
    if (staged) {
      original = entry.index === "A" ? "" : await api.gitShow(status.root, `HEAD:${entry.orig_path || entry.path}`);
      modified = entry.index === "D" ? "" : await api.gitShow(status.root, `:${entry.path}`);
    } else {
      original = entry.untracked ? "" : await api.gitShow(status.root, `:${entry.path}`);
      if (entry.worktree !== "D") {
        const file = await api.read(abs).catch(() => ({ content: "", binary: false }));
        if (file.binary) { toast("Binary file; no text diff."); return; }
        modified = file.content;
      }
    }
    openDiff({ title: `${basename(entry.path)} (${staged ? "staged" : "working tree"})`, path: abs, original, modified, language: languageFor(abs) });
  } catch (err) { toast(formatError(err), "error"); }
}

async function act(fn) {
  try { await fn(); } catch (err) { toast(formatError(err), "error"); }
  refreshGit();
}

async function discard(status, entries) {
  const names = entries.length === 1 ? basename(entries[0].path) : `${entries.length} files`;
  const ok = await confirmDialog(`Discard changes to ${names}?`, "Working tree changes are thrown away. Untracked files are deleted. This cannot be undone.", { ok: "Discard", danger: true });
  if (!ok) return;
  const tracked = entries.filter((e) => !e.untracked).map((e) => e.path);
  const untracked = entries.filter((e) => e.untracked).map((e) => e.path);
  await act(() => api.gitDiscard(status.root, tracked, untracked));
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
    const ok = await confirmDialog("Nothing is staged", "Stage all changes and commit them?", { ok: "Stage all and commit" });
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

export async function generateMessage(textarea, providerId, button) {
  const v = view();
  const status = v.git;
  if (!status || !status.is_repo || generating) return;
  const p = provider(providerId);
  if (p && !p.available) { toast(`${p.name}: ${p.detail}`, "error"); return; }
  let staged = status.entries.filter((e) => e.staged);
  if (!staged.length) {
    if (!status.entries.length) { toast("There are no changes to describe."); return; }
    const ok = await confirmDialog("Nothing is staged", "Stage all changes and write a message for them?", { ok: "Stage all" });
    if (!ok) return;
    try { await api.gitStage(status.root, []); } catch (err) { toast(formatError(err), "error"); return; }
    await refreshGit();
    staged = view().git.entries.filter((e) => e.staged);
    textarea = host.querySelector("textarea") || textarea;
  }
  generating = true;
  render();
  textarea = host.querySelector("textarea") || textarea;
  try {
    let diff = await api.gitDiffAll(status.root, true);
    if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated: the change is larger than shown]";
    const prompt = buildPrompt({ status, staged, diff, log: v.log || [] });
    const raw = await api.aiComplete(providerId, prompt, status.root, null);
    const message = cleanMessage(raw);
    if (!message) throw new Error("The provider returned an empty message.");
    v.commitDraft = message;
    const current = host.querySelector("textarea");
    if (current) { current.value = message; current.focus(); }
  } catch (err) { toast(formatError(err), "error"); }
  generating = false;
  render();
}

function buildPrompt({ status, staged, diff, log }) {
  const instructions = (state.settings.commit_instructions || "").trim();
  const files = staged.map((e) => `${e.index === "?" ? "A" : e.index} ${e.path}${e.orig_path ? ` (was ${e.orig_path})` : ""}`).join("\n");
  const history = log.slice(0, 12).map((c) => `- ${c.subject}`).join("\n") || "- (no commits yet)";
  return `${instructions}

Repository: ${projectName(status.root)}
Branch: ${status.branch}

Recent commit subjects, newest first (match their style):
${history}

Files in this change (status letter, path):
${files}

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
  const lines = text.split("\n");
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
