// The file explorer tree and the projects list.
import { api } from "./api.js";
import { state, view, saveSettings, emit, on, projectName } from "./state.js";
import { $, el, basename, dirname, joinPath, relPath, toast, formatError, contextMenu, confirmDialog, promptDialog } from "./ui.js";
import { openFile, fileRemoved } from "./editor.js";

let treeEl;
const cache = new Map(); // dir path -> entries
let gitMap = new Map(); // abs path -> status letter
let gitDirs = new Set(); // dirs with changes inside

export function initExplorer() {
  treeEl = $("#file-tree");
  $("#btn-refresh-files").addEventListener("click", () => refreshTree());
  $("#btn-new-file").addEventListener("click", () => createIn(selectedDir(), false));
  $("#btn-new-folder").addEventListener("click", () => createIn(selectedDir(), true));
  treeEl.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (!state.project) return;
    const row = event.target.closest(".tree-row");
    if (row) selectRow(row.dataset.path);
    showMenu(event.clientX, event.clientY, row ? row.dataset.path : state.project, row ? row.dataset.dir === "1" : true);
  });
  on("tab", (tab) => { if (tab && tab.kind === "file") highlightOpen(tab.path); });
}

function selectedDir() {
  const v = view();
  if (!v) return null;
  if (v.selected) {
    const row = treeEl.querySelector(`.tree-row[data-path="${CSS.escape(v.selected)}"]`);
    if (row) return row.dataset.dir === "1" ? v.selected : dirname(v.selected);
  }
  return v.path;
}

export async function refreshTree({ keepCache = false } = {}) {
  if (!keepCache) cache.clear();
  await renderTree();
}

export function invalidate(paths) {
  for (const p of paths) { cache.delete(p); cache.delete(dirname(p)); }
}

export async function renderTree() {
  const v = view();
  treeEl.innerHTML = "";
  $("#files-title").textContent = v ? projectName(v.path) : "Explorer";
  if (!v) { treeEl.append(el("div", { class: "panel-hint", text: "Open a project to browse its files." })); return; }
  const frag = document.createDocumentFragment();
  await renderDir(v.path, 0, frag, v);
  treeEl.append(frag);
  if (v.activeTab) { const tab = v.tabs.find((t) => t.id === v.activeTab); if (tab && tab.kind === "file") highlightOpen(tab.path); }
}

async function listDir(path) {
  if (cache.has(path)) return cache.get(path);
  try {
    const entries = await api.list(path);
    cache.set(path, entries);
    return entries;
  } catch (err) {
    toast(formatError(err), "error");
    return [];
  }
}

async function renderDir(dir, depth, parent, v) {
  const entries = await listDir(dir);
  for (const entry of entries) {
    const open = entry.is_dir && v.expanded.has(entry.path);
    const letter = gitMap.get(entry.path);
    const classes = ["tree-row"];
    if (open) classes.push("open");
    if (letter) classes.push("git-" + letter);
    if (v.selected === entry.path) classes.push("selected");
    const row = el("div", { class: classes.join(" "), dataset: { path: entry.path, dir: entry.is_dir ? "1" : "0" }, title: entry.path }, [
      el("span", { class: "tree-arrow", text: entry.is_dir ? "▶" : "" }),
      el("span", { class: "tree-icon", html: entry.is_dir ? folderIcon(open) : fileIcon(entry.name) }),
      el("span", { class: "tree-name", text: entry.name }),
      letter ? el("span", { class: `tree-status s-${letter}`, text: letter }) : (entry.is_dir && gitDirs.has(entry.path) ? el("span", { class: "tree-status", text: "•" }) : null),
    ]);
    row.style.paddingLeft = 6 + depth * 14 + "px";
    row.addEventListener("click", (event) => onRowClick(entry, row, event));
    row.addEventListener("dblclick", () => { if (!entry.is_dir) openFile(entry.path); });
    parent.append(row);
    if (open) {
      const holder = el("div", { class: "tree-children", dataset: { parent: entry.path } });
      parent.append(holder);
      await renderDir(entry.path, depth + 1, holder, v);
    }
  }
}

async function onRowClick(entry, row, event) {
  const v = view();
  selectRow(entry.path);
  if (entry.is_dir) {
    if (v.expanded.has(entry.path)) v.expanded.delete(entry.path); else v.expanded.add(entry.path);
    await renderTree();
  } else {
    openFile(entry.path);
  }
}

function selectRow(path) {
  const v = view();
  if (!v) return;
  v.selected = path;
  for (const row of treeEl.querySelectorAll(".tree-row.selected")) row.classList.remove("selected");
  const row = treeEl.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
  if (row) row.classList.add("selected");
}

function highlightOpen(path) {
  for (const row of treeEl.querySelectorAll(".tree-row.active")) row.classList.remove("active");
  const row = treeEl.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
  if (row) { row.classList.add("active"); row.scrollIntoView({ block: "nearest" }); }
}

export async function revealInTree(path) {
  const v = view();
  if (!v || !path.startsWith(v.path + "/")) return;
  let dir = dirname(path);
  while (dir.length > v.path.length) { v.expanded.add(dir); dir = dirname(dir); }
  v.selected = path;
  await renderTree();
  highlightOpen(path);
}

function showMenu(x, y, path, isDir) {
  const v = view();
  const dir = isDir ? path : dirname(path);
  const isRoot = path === v.path;
  contextMenu(x, y, [
    { label: "New file", action: () => createIn(dir, false) },
    { label: "New folder", action: () => createIn(dir, true) },
    { separator: true },
    !isRoot && { label: "Rename", action: () => renameItem(path) },
    !isRoot && { label: "Move to Trash", danger: true, action: () => deleteItem(path) },
    !isRoot && { separator: true },
    { label: "Reveal in Finder", action: () => api.reveal(path) },
    { label: "Copy path", action: () => navigator.clipboard.writeText(path) },
    { label: "Copy relative path", action: () => navigator.clipboard.writeText(relPath(v.path, path)) },
    { separator: true },
    { label: "Refresh", action: () => refreshTree() },
  ]);
}

async function createIn(dir, isDir) {
  const v = view();
  if (!v) return;
  dir = dir || v.path;
  const name = await promptDialog(isDir ? "New folder" : "New file", { label: `Inside ${relPath(v.path, dir) || basename(v.path)}`, placeholder: isDir ? "folder-name" : "file.ext", ok: "Create" });
  if (!name || !name.trim()) return;
  const path = joinPath(dir, name.trim());
  try {
    await api.create(path, isDir);
    v.expanded.add(dir);
    invalidate([path]);
    await renderTree();
    if (!isDir) openFile(path);
    selectRow(path);
  } catch (err) { toast(formatError(err), "error"); }
}

async function renameItem(path) {
  const name = await promptDialog("Rename", { value: basename(path), ok: "Rename" });
  if (!name || name === basename(path)) return;
  const to = joinPath(dirname(path), name);
  try {
    await api.rename(path, to);
    invalidate([path, to]);
    const v = view();
    for (const tab of v.tabs) if (tab.kind === "file" && tab.path === path) { tab.path = to; tab.title = basename(to); }
    await renderTree();
    emit("fs-renamed", { from: path, to });
  } catch (err) { toast(formatError(err), "error"); }
}

async function deleteItem(path) {
  const ok = await confirmDialog(`Move ${basename(path)} to the Trash?`, "You can put it back from the Trash in Finder.", { ok: "Move to Trash", danger: true });
  if (!ok) return;
  try {
    await api.remove(path);
    fileRemoved(path);
    invalidate([path]);
    await renderTree();
  } catch (err) { toast(formatError(err), "error"); }
}

export function setGitDecorations(status) {
  gitMap = new Map();
  gitDirs = new Set();
  if (status && status.is_repo) {
    for (const entry of status.entries) {
      const abs = joinPath(status.root, entry.path);
      let letter = entry.untracked ? "U" : entry.conflicted ? "C" : (entry.worktree !== " " ? entry.worktree : entry.index);
      if (letter === "?") letter = "U";
      gitMap.set(abs, letter);
      let dir = dirname(abs);
      while (dir.length >= status.root.length && dir !== "/") { gitDirs.add(dir); if (dir === status.root) break; dir = dirname(dir); }
    }
  }
  // Update decorations in place without a full re-render.
  for (const row of treeEl.querySelectorAll(".tree-row")) {
    const path = row.dataset.path;
    row.className = row.className.replace(/\bgit-\w\b/g, "").trim();
    const letter = gitMap.get(path);
    const statusEl = row.querySelector(".tree-status");
    if (letter) {
      row.classList.add("git-" + letter);
      if (statusEl) { statusEl.textContent = letter; statusEl.className = `tree-status s-${letter}`; }
      else row.append(el("span", { class: `tree-status s-${letter}`, text: letter }));
    } else if (row.dataset.dir === "1" && gitDirs.has(path)) {
      if (statusEl) { statusEl.textContent = "•"; statusEl.className = "tree-status"; }
      else row.append(el("span", { class: "tree-status", text: "•" }));
    } else if (statusEl) statusEl.remove();
  }
}

// ---- icons ----------------------------------------------------------------------

function folderIcon(open) {
  return open
    ? '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 4.5a1 1 0 011-1H6l1.5 1.5h5a1 1 0 011 1V7H3.2L1.5 12z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M1.5 12l1.7-5h11.3l-1.7 5z" fill="currentColor" opacity=".45"/></svg>'
    : '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 4.5a1 1 0 011-1H6l1.5 1.5h5a1 1 0 011 1v6a1 1 0 01-1 1h-10a1 1 0 01-1-1z" fill="currentColor" opacity=".55"/></svg>';
}

const EXT_COLORS = { js: "#e5c35a", mjs: "#e5c35a", ts: "#6ba6f0", tsx: "#6ba6f0", jsx: "#6ba6f0", py: "#7fb8e8", rs: "#e09a6a", go: "#6fc7e6", rb: "#e06a6a", swift: "#f08a5a", json: "#d8c270", md: "#9ab0c8", html: "#e8865a", css: "#8f7ff0", scss: "#d07ab8", sh: "#8fd38f", toml: "#c99a7a", yml: "#c99a7a", yaml: "#c99a7a", sql: "#d8a560", svg: "#f0a85a", png: "#a890f0", jpg: "#a890f0", lock: "#8a8a92" };

function fileIcon(name) {
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const color = EXT_COLORS[ext] || "currentColor";
  return `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.5 1.5v3h3" fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
}

// ---- projects list --------------------------------------------------------------

export function renderProjects(onSwitch, onRemove) {
  const host = $("#projects-list");
  host.innerHTML = "";
  const projects = state.settings.projects || [];
  $("#projects-empty").hidden = projects.length > 0;
  for (const project of projects) {
    const row = el("div", { class: `project-row ${project.path === state.project ? "active" : ""}`, title: project.path, onclick: () => onSwitch(project.path) }, [
      el("div", { class: "project-icon", text: initials(project.name || basename(project.path)) }),
      el("div", { class: "project-text" }, [el("div", { class: "project-name", text: project.name || basename(project.path) }), el("div", { class: "project-path", text: project.path })]),
      el("button", { class: "icon-btn sm", text: "×", title: "Remove from list", onclick: (event) => { event.stopPropagation(); onRemove(project.path); } }),
    ]);
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      contextMenu(event.clientX, event.clientY, [
        { label: "Open", action: () => onSwitch(project.path) },
        { label: "Rename", action: async () => {
          const name = await promptDialog("Project name", { value: project.name || basename(project.path), ok: "Save" });
          if (name && name.trim()) { project.name = name.trim(); saveSettings(); emit("projects"); }
        } },
        { label: "Reveal in Finder", action: () => api.reveal(project.path) },
        { label: "Copy path", action: () => navigator.clipboard.writeText(project.path) },
        { separator: true },
        { label: "Remove from list", danger: true, action: () => onRemove(project.path) },
      ]);
    });
    host.append(row);
  }
}

function initials(name) {
  const words = name.replace(/[-_.]+/g, " ").trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}
