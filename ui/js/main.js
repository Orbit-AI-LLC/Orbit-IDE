// Boot: settings, providers, editor, panels, projects, shortcuts.
import { api, listen, onDragDrop, onDragEnter, onDragLeave } from "./api.js";
import { state, view, loadSettings, saveSettings, refreshProviders, emit, on, projectName } from "./state.js";
import { $, $$, el, basename, dirname, relPath, toast, formatError, showModal, isModalOpen, confirmDialog, debounce } from "./ui.js";
import { initEditor, openFile, saveActive, saveAll, closeTab, switchProjectView, fileChangedOnDisk, fileRemoved, countDirty, layout, focusEditor, applyTheme, closeAllTabs } from "./editor.js";
import { initTerminals, toggleTerminalPanel, isTerminalPanelOpen, newShell, switchProjectTerminals } from "./terminal.js";
import { initExplorer, renderTree, refreshTree, invalidate, renderProjects, revealInTree } from "./explorer.js";
import { initGit, refreshGit, refreshGitSoon } from "./gitpanel.js";
import { initAiPanel, toggleAiDock, isAiDockOpen, renderAll as renderAi } from "./aipanel.js";
import { openSettings } from "./settings.js";

async function boot() {
  await loadSettings();
  state.info = await api.appInfo().catch(() => null);
  if (state.info) document.body.dataset.os = state.info.os;
  applyTheme(state.settings.theme);
  applySizes();
  await initEditor();
  initTerminals();
  initExplorer();
  initGit();
  initAiPanel();
  bindChrome();
  bindShortcuts();
  bindGutters();
  bindDragDrop();
  bindFsEvents();
  await refreshProviders().catch(() => {});
  renderProjectList();
  on("projects", renderProjectList);
  on("open-project", (path) => addProject(path));
  on("settings", () => { renderProjectList(); });
  const last = state.settings.active_project;
  if (last && state.settings.projects.some((p) => p.path === last)) await switchProject(last);
  else if (state.settings.projects.length) await switchProject(state.settings.projects[0].path);
  else { showPanel("projects"); }
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if (state.settings.theme === "system") applyTheme("system"); });
  api.log("info", `booted project=${state.project} providers=${state.providers.map((p) => `${p.id}:${p.available}`).join(",")}`);
  if (state.info && state.info.selftest) selfTest().catch((err) => api.log("selftest", `FAILED ${formatError(err)} ${err && err.stack || ""}`));
}

// ---- self-test (ORBIT_IDE_SELFTEST=1) -------------------------------------------

async function selfTest() {
  const log = (m) => api.log("selftest", m);
  const v = view();
  if (!v) { log("no project"); return; }
  const tree = $$("#file-tree .tree-row");
  log(`tree rows=${tree.length}`);
  const fileRow = tree.find((r) => r.dataset.dir === "0");
  if (fileRow) {
    const tab = await openFile(fileRow.dataset.path);
    log(`opened ${fileRow.dataset.path} lines=${tab ? tab.model.getLineCount() : "none"} lang=${tab ? tab.model.getLanguageId() : ""} editorVisible=${!$("#editor").hidden}`);
  }
  log(`git repo=${v.git && v.git.is_repo} branch=${v.git && v.git.branch} entries=${v.git ? v.git.entries.length : -1} staged=${v.git ? v.git.entries.filter((e) => e.staged).length : -1}`);
  const gitRows = $$("#git-panel .git-row");
  log(`git rows rendered=${gitRows.length}`);
  const nestedRow = $$("#git-panel .git-row").find((r) => r.querySelector(".nested-tag"));
  if (nestedRow) {
    nestedRow.click();
    await new Promise((r) => setTimeout(r, 800));
    const items = $$("#context-menu button");
    log(`nested menu items=${JSON.stringify(items.map((b) => b.textContent))}`);
    const file = items.find((b) => /\.txt$/.test(b.textContent));
    if (file) {
      file.click();
      await new Promise((r) => setTimeout(r, 2500));
      const de = state.monaco.editor.getDiffEditors()[0];
      const m = de && de.getModel();
      log(`nested diff lineChanges=${de && de.getLineChanges() ? de.getLineChanges().length : "null"} modifiedText=${JSON.stringify(m ? m.modified.getValue().slice(0, 40) : "")}`);
      const t = v.tabs.find((x) => x.kind === "diff"); if (t) await closeTab(t.id);
    }
  }
  if (v.git && v.git.entries) log(`git entries ${JSON.stringify(v.git.entries.map((e) => ({ p: e.path, sub: e.submodule, stageable: e.stageable, inner: e.sub_changes, add: e.add, del: e.del })))}`);
  if (gitRows[0]) {
    gitRows[0].click();
    await new Promise((r) => setTimeout(r, 2500));
    const de = state.monaco.editor.getDiffEditors()[0];
    const changes = de && de.getLineChanges();
    const visible = de ? de.getModifiedEditor().getVisibleRanges().length : -1;
    log(`diff tab open=${!$("#diff-editor").hidden} lineChanges=${changes ? changes.length : "null (not computed)"} visibleRanges=${visible} tabs=${v.tabs.length}`);
    const diffTab = v.tabs.find((t) => t.kind === "diff");
    if (diffTab) { try { await closeTab(diffTab.id); log(`diff tab closed cleanly tabs=${v.tabs.length}`); } catch (err) { log(`diff close threw ${formatError(err)}`); } }
  }
  // Terminal round trip.
  await newShell();
  const shell = v.activeShell;
  const seen = await new Promise((resolve) => {
    let buf = "";
    const orig = shell.term.write.bind(shell.term);
    shell.term.write = (bytes) => { buf += new TextDecoder().decode(bytes); orig(bytes); if (buf.includes("ORBIT_42")) resolve(buf.slice(-160)); };
    setTimeout(() => resolve(false), 8000);
    setTimeout(() => api.ptyWrite(shell.term.id, "echo ORBIT_$((40+2)) agentvars=$(env | grep -c '^CLAUDE')\n"), 1500);
  });
  log(`terminal echo=${JSON.stringify(seen)} cols=${shell.term.term.cols} rows=${shell.term.term.rows}`);
  // Quick open and search.
  const files = await api.walk(v.path);
  log(`walk files=${files.length}`);
  const hits = await api.search(v.path, "Orbit");
  log(`search hits=${hits.length}`);
  // A one-shot completion through the first available CLI provider.
  const p = state.providers.find((x) => x.available && x.kind === "cli");
  if (p) {
    const t0 = Date.now();
    try {
      const out = await api.aiComplete(p.id, "Reply with exactly the word PONG and nothing else.", v.path, null);
      log(`complete ${p.id} ms=${Date.now() - t0} out=${JSON.stringify(out.slice(0, 80))}`);
    } catch (err) { log(`complete ${p.id} error=${formatError(err)}`); }
  }
  // An agent's shell stays open after the agent exits.
  const agentResult = await new Promise(async (resolve) => {
    let buf = "", exited = false;
    const { listen } = await import("./api.js");
    const unData = await listen("pty:data", ({ id, data }) => { if (id === agentId) buf += atob(data); });
    const unExit = await listen("pty:exit", ({ id }) => { if (id === agentId) exited = true; });
    const agentId = await api.ptySpawn(v.path, "true", [], 80, 24);
    setTimeout(() => { unData(); unExit(); resolve(`sawExitNote=${buf.includes("exited with status 0")} shellStillOpen=${!exited}`); }, 4000);
    setTimeout(() => api.ptyKill(agentId), 4500);
  });
  log(`agent shell ${agentResult}`);
  log("DONE");
}

// ---- projects -----------------------------------------------------------------

function renderProjectList() {
  renderProjects(switchProject, removeProject);
}

export async function addProject(path) {
  if (!path) return;
  path = path.replace(/\/+$/, "");
  const projects = state.settings.projects;
  if (!projects.some((p) => p.path === path)) {
    projects.push({ path, name: basename(path) });
    saveSettings();
  }
  await switchProject(path);
}

async function pickProject() {
  try {
    const path = await api.pickFolder();
    if (path) await addProject(path);
  } catch (err) { toast(formatError(err), "error"); }
}

async function removeProject(path) {
  const ok = await confirmDialog(`Remove ${projectName(path)} from the list?`, "The folder stays on disk. Open terminals and agent sessions for it are stopped.", { ok: "Remove" });
  if (!ok) return;
  const v = state.views.get(path);
  if (v) {
    for (const shell of v.shells) shell.term.dispose();
    for (const term of Object.values(v.agents)) term.dispose();
    await closeAllTabs(path);
    state.views.delete(path);
  }
  state.settings.projects = state.settings.projects.filter((p) => p.path !== path);
  if (state.project === path) {
    state.project = null;
    const next = state.settings.projects[0];
    saveSettings({ active_project: next ? next.path : null });
    if (next) await switchProject(next.path); else { await afterSwitch(); }
  } else saveSettings();
  renderProjectList();
}

export async function switchProject(path) {
  if (state.project === path) { showPanel("files"); return; }
  state.project = path;
  view(path);
  saveSettings({ active_project: path });
  await afterSwitch();
  showPanel("files");
  api.watch(path).catch((err) => console.warn("watch", err));
}

async function afterSwitch() {
  const v = view();
  $("#title-project").textContent = v ? projectName(v.path) : "Orbit IDE";
  $("#quick-open-label").textContent = v ? `Search ${projectName(v.path)}` : "Search files";
  document.title = v ? `${projectName(v.path)} · Orbit IDE` : "Orbit IDE";
  renderProjectList();
  switchProjectView();
  switchProjectTerminals();
  await renderTree();
  await refreshGit();
  renderAi();
  emit("project", v ? v.path : null);
}

// ---- chrome --------------------------------------------------------------------

function showPanel(name) {
  for (const button of $$(".activity-btn")) button.classList.toggle("active", button.dataset.panel === name);
  for (const panel of $$("#sidebar .panel")) panel.classList.toggle("active", panel.dataset.panel === name);
  $("#sidebar").classList.remove("collapsed");
  $("#gutter-sidebar").hidden = false;
  if (name === "git") refreshGit();
  if (name === "search") setTimeout(() => $("#search-input").focus(), 0);
  window.dispatchEvent(new Event("resize"));
}

function toggleSidebar() {
  const sidebar = $("#sidebar");
  sidebar.classList.toggle("collapsed");
  $("#gutter-sidebar").hidden = sidebar.classList.contains("collapsed");
  window.dispatchEvent(new Event("resize"));
}

function bindChrome() {
  for (const button of $$(".activity-btn")) {
    button.addEventListener("click", () => {
      const already = button.classList.contains("active") && !$("#sidebar").classList.contains("collapsed");
      if (already) toggleSidebar(); else showPanel(button.dataset.panel);
    });
  }
  $("#btn-add-project").addEventListener("click", pickProject);
  $("#btn-settings").addEventListener("click", () => openSettings());
  $("#btn-toggle-terminal").addEventListener("click", () => toggleTerminalPanel());
  $("#btn-toggle-ai").addEventListener("click", () => toggleAiDock());
  $("#btn-quick-open").addEventListener("click", quickOpen);
  $("#btn-toggle-ai").classList.add("active");
  $("#gutter-terminal").hidden = true;
  const searchInput = $("#search-input");
  searchInput.addEventListener("input", debounce(() => runSearch(searchInput.value), 250));
  searchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") runSearch(searchInput.value); });
  $("#projects-empty").addEventListener("click", pickProject);
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href^='http']");
    if (link && !link.dataset.external) { event.preventDefault(); api.openExternal(link.href).catch(() => {}); }
  });
  on("dirty", (n) => { $("#status-message").textContent = n ? `${n} unsaved` : ""; });
}

function bindShortcuts() {
  window.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) {
      if (event.key === "Escape" && !isModalOpen()) { /* leave to focused widget */ }
      return;
    }
    const key = event.key.toLowerCase();
    const shift = event.shiftKey;
    const handled = (fn) => { event.preventDefault(); event.stopPropagation(); fn(); };
    if (key === "s" && !shift) return handled(saveActive);
    if (key === "s" && shift) return handled(saveAll);
    if (key === "p" && !shift) return handled(quickOpen);
    if (key === "f" && shift) return handled(() => showPanel("search"));
    if (key === "b" && !shift) return handled(toggleSidebar);
    if (key === "j" && !shift) return handled(() => toggleTerminalPanel());
    if (key === "`" ) return handled(() => toggleTerminalPanel());
    if (key === "a" && shift) return handled(() => toggleAiDock());
    if (key === "," ) return handled(() => openSettings());
    if (key === "o" && !shift) return handled(pickProject);
    if (key === "w" && !shift) return handled(() => { const v = view(); if (v && v.activeTab) closeTab(v.activeTab); });
    if (key === "1") return handled(() => showPanel("projects"));
    if (key === "2") return handled(() => showPanel("files"));
    if (key === "3") return handled(() => showPanel("git"));
    if (key === "n" && shift) return handled(() => newShell());
    if (key === "e" && shift) return handled(() => { const v = view(); const tab = v && v.tabs.find((t) => t.id === v.activeTab); if (tab && tab.kind === "file") { showPanel("files"); revealInTree(tab.path); } });
  }, true);
}

function bindGutters() {
  const drag = (gutter, onMove, onEnd) => {
    gutter.addEventListener("mousedown", (event) => {
      event.preventDefault();
      gutter.classList.add("dragging");
      document.body.style.cursor = gutter.classList.contains("gutter-h") ? "row-resize" : "col-resize";
      const move = (e) => onMove(e);
      const up = () => {
        gutter.classList.remove("dragging");
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        onEnd();
        window.dispatchEvent(new Event("resize"));
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  };
  const root = document.documentElement.style;
  drag($("#gutter-sidebar"), (e) => { const w = Math.max(180, Math.min(600, e.clientX - 48)); root.setProperty("--sidebar", w + "px"); state.settings.sidebar_width = w; layout(); }, () => saveSettings());
  drag($("#gutter-ai"), (e) => { const w = Math.max(300, Math.min(window.innerWidth - 500, window.innerWidth - e.clientX)); root.setProperty("--ai", w + "px"); state.settings.ai_panel_width = w; layout(); }, () => saveSettings());
  drag($("#gutter-terminal"), (e) => { const main = $(".main").getBoundingClientRect(); const h = Math.max(100, Math.min(main.height - 120, main.bottom - e.clientY)); root.setProperty("--terminal", h + "px"); state.settings.terminal_height = h; layout(); }, () => saveSettings());
}

function applySizes() {
  const s = state.settings;
  const root = document.documentElement.style;
  if (s.sidebar_width) root.setProperty("--sidebar", s.sidebar_width + "px");
  if (s.ai_panel_width) root.setProperty("--ai", s.ai_panel_width + "px");
  if (s.terminal_height) root.setProperty("--terminal", s.terminal_height + "px");
}

function bindDragDrop() {
  let hint = null;
  onDragEnter(() => { if (!hint) { hint = el("div", { class: "drop-hint", text: "Drop a folder to open it as a project" }); document.body.append(hint); } });
  onDragLeave(() => { if (hint) { hint.remove(); hint = null; } });
  onDragDrop(async (paths) => {
    if (hint) { hint.remove(); hint = null; }
    for (const path of paths) {
      const v = view();
      if (v && path.startsWith(v.path + "/")) { openFile(path); continue; }
      try {
        await api.list(path);
        await addProject(path);
      } catch {
        openFile(path);
      }
    }
  });
}

function bindFsEvents() {
  listen("fs:changed", async ({ root, paths }) => {
    const v = view();
    if (!v || root !== v.path) return;
    invalidate(paths);
    for (const path of paths) {
      try { await api.read(path).then(() => fileChangedOnDisk(path)); } catch { fileRemoved(path); }
    }
    await renderTree();
    refreshGitSoon();
  });
  listen("git:changed", ({ root }) => {
    const v = view();
    if (v && root === v.path) refreshGitSoon();
  });
  on("fs-discarded", (paths) => { invalidate(paths); for (const p of paths) fileChangedOnDisk(p); renderTree(); });
  on("fs-renamed", () => refreshGitSoon());
  window.addEventListener("focus", () => { refreshGitSoon(); });
}

// ---- quick open ------------------------------------------------------------------

async function quickOpen() {
  const v = view();
  if (!v) { toast("Open a project first."); return; }
  if (!v.fileList) {
    try { v.fileList = await api.walk(v.path); } catch (err) { toast(formatError(err), "error"); return; }
    setTimeout(() => { v.fileList = null; }, 30000);
  }
  const files = v.fileList;
  let selected = 0;
  let results = [];
  const input = el("input", { type: "text", placeholder: "Go to file", spellcheck: "false", autocomplete: "off" });
  const list = el("div", { class: "palette-list" });
  const palette = el("div", { class: "palette" }, [input, list]);
  let m;
  const update = () => {
    const q = input.value.trim().toLowerCase();
    results = (q ? fuzzy(files, q) : files.slice(0, 40)).slice(0, 60);
    selected = 0;
    draw();
  };
  const draw = () => {
    list.innerHTML = "";
    if (!results.length) { list.append(el("div", { class: "palette-empty", text: "No matching files" })); return; }
    results.forEach((rel, i) => {
      const item = el("div", { class: `palette-item ${i === selected ? "selected" : ""}` }, [el("span", { html: highlight(basename(rel), input.value.trim()) }), el("span", { class: "pi-dir", text: dirname(rel) === "/" ? "" : dirname(rel) })]);
      item.addEventListener("click", () => choose(i));
      list.append(item);
    });
    const sel = list.children[selected];
    if (sel) sel.scrollIntoView({ block: "nearest" });
  };
  const choose = (i) => { const rel = results[i]; m.close(null); if (rel) openFile(v.path + "/" + rel); };
  input.addEventListener("input", update);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); selected = Math.min(results.length - 1, selected + 1); draw(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); selected = Math.max(0, selected - 1); draw(); }
    else if (event.key === "Enter") { event.preventDefault(); choose(selected); }
  });
  m = showModal({ body: palette, className: "palette-modal" });
  m.modal.className = "";
  m.modal.innerHTML = "";
  m.modal.append(palette);
  update();
  setTimeout(() => input.focus(), 0);
}

function fuzzy(files, q) {
  const scored = [];
  for (const rel of files) {
    const lower = rel.toLowerCase();
    const name = basename(lower);
    let score = 0;
    if (name === q) score = 1000;
    else if (name.startsWith(q)) score = 500 - name.length;
    else if (name.includes(q)) score = 300 - name.length;
    else if (lower.includes(q)) score = 100 - lower.length / 10;
    else {
      let qi = 0;
      for (let i = 0; i < lower.length && qi < q.length; i++) if (lower[i] === q[qi]) qi++;
      if (qi === q.length) score = 10 - lower.length / 50; else continue;
    }
    scored.push([score, rel]);
  }
  return scored.sort((a, b) => b[0] - a[0]).map((x) => x[1]);
}

function highlight(name, q) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  if (!q) return esc(name);
  const idx = name.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return esc(name);
  return esc(name.slice(0, idx)) + "<mark>" + esc(name.slice(idx, idx + q.length)) + "</mark>" + esc(name.slice(idx + q.length));
}

// ---- search in project ------------------------------------------------------------

async function runSearch(query) {
  const v = view();
  const host = $("#search-results");
  host.innerHTML = "";
  if (!v || !query.trim()) return;
  let hits;
  try { hits = await api.search(v.path, query); } catch (err) { host.append(el("div", { class: "panel-hint", text: formatError(err) })); return; }
  if (!hits.length) { host.append(el("div", { class: "panel-hint", text: "No results" })); return; }
  let lastFile = null;
  for (const hit of hits) {
    if (hit.path !== lastFile) { host.append(el("div", { class: "search-file", text: hit.path, title: hit.path })); lastFile = hit.path; }
    const row = el("div", { class: "search-hit" }, [el("span", { class: "ln", text: hit.line }), el("span", { class: "tx", text: hit.text })]);
    row.addEventListener("click", () => openFile(v.path + "/" + hit.path, { line: hit.line }));
    host.append(row);
  }
}

window.addEventListener("error", (event) => { toast(`Error: ${event.message}`, "error"); api.log("error", `${event.message} @ ${event.filename}:${event.lineno}`); });
window.addEventListener("unhandledrejection", (event) => { if (event.reason && (event.reason.name === "Canceled" || event.reason.message === "Canceled")) { event.preventDefault(); return; } toast(`Error: ${formatError(event.reason)}`, "error"); api.log("error", `unhandled: ${formatError(event.reason)} ${event.reason && event.reason.stack || ""}`); });
const nativeError = console.error.bind(console);
console.error = (...args) => { nativeError(...args); api.log("console", args.map((a) => (a && a.stack) || formatError(a)).join(" ")); };
const nativeWarn = console.warn.bind(console);
console.warn = (...args) => { nativeWarn(...args); api.log("warn", args.map((a) => formatError(a)).join(" ")); };

boot().catch((err) => {
  console.error(err);
  document.body.append(el("pre", { style: "position:fixed;inset:40px;z-index:99;background:#300;color:#fff;padding:20px;overflow:auto", text: "Orbit IDE failed to start:\n" + (err && err.stack || err) }));
});
