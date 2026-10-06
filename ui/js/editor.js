// The Monaco editor, its tabs and the diff view. One editor instance; a
// model per open file; tabs belong to the active project's view.
import { api } from "./api.js";
import { state, view, emit, on } from "./state.js";
import { $, el, basename, relPath, toast, formatError, confirmDialog } from "./ui.js";

let editor = null;
let diffEditor = null;
let monaco = null;
let tabsEl, editorHost, diffHost, welcome;
let nextTabId = 1;

export function loadMonaco() {
  return new Promise((resolve, reject) => {
    // Classic workers from the stable copies made by scripts/vendor.sh. The
    // build's default makes a module worker from a blob that imports the
    // script, which a custom-scheme page cannot do.
    const WORKERS = { json: "json", css: "css", scss: "css", less: "css", html: "html", handlebars: "html", razor: "html", typescript: "ts", javascript: "ts" };
    window.MonacoEnvironment = {
      getWorker: (_moduleId, label) => new Worker(`vendor/monaco/workers/${WORKERS[label] || "editor"}.worker.js`, { name: label }),
    };
    window.require.config({ paths: { vs: "vendor/monaco/vs" } });
    window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
  });
}

export async function initEditor() {
  tabsEl = $("#editor-tabs");
  editorHost = $("#editor");
  diffHost = $("#diff-editor");
  welcome = $("#welcome");
  monaco = await loadMonaco();
  state.monaco = monaco;
  defineThemes();
  const settings = state.settings;
  const options = editorOptions(settings);
  editor = monaco.editor.create(editorHost, { ...options, model: null });
  diffEditor = monaco.editor.createDiffEditor(diffHost, { ...options, readOnly: true, originalEditable: false, renderSideBySide: true, ignoreTrimWhitespace: false });
  editor.onDidChangeCursorPosition((event) => {
    $("#status-cursor").textContent = `Ln ${event.position.lineNumber}, Col ${event.position.column}`;
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActive());
  window.addEventListener("resize", layout);
  new ResizeObserver(layout).observe(editorHost.parentElement);
  on("settings", (s) => { editor.updateOptions(editorOptions(s)); diffEditor.updateOptions(editorOptions(s)); applyTheme(s.theme); });
  applyTheme(settings.theme);
  renderTabs();
  showView();
}

function editorOptions(settings) {
  return {
    fontSize: settings.font_size || 13,
    fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Monaco, monospace',
    tabSize: settings.tab_size || 4,
    wordWrap: settings.word_wrap ? "on" : "off",
    minimap: { enabled: true, renderCharacters: false },
    automaticLayout: false,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: "smooth",
    renderWhitespace: "selection",
    padding: { top: 8 },
    bracketPairColorization: { enabled: true },
    stickyScroll: { enabled: true },
  };
}

function defineThemes() {
  monaco.editor.defineTheme("orbit-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#121214",
      "editor.lineHighlightBackground": "#1a1a1e",
      "editorLineNumber.foreground": "#505058",
      "editorLineNumber.activeForeground": "#9a9aa3",
      "editorIndentGuide.background1": "#232328",
      "editor.selectionBackground": "#2d3a5c",
      "minimap.background": "#121214",
      "scrollbarSlider.background": "#2a2a2f80",
      "diffEditor.insertedTextBackground": "#7ccf8a22",
      "diffEditor.removedTextBackground": "#ef7b7b22",
    },
  });
  monaco.editor.defineTheme("orbit-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editor.lineHighlightBackground": "#f3f3f6",
      "editorLineNumber.foreground": "#b5b5bd",
    },
  });
}

export function applyTheme(theme) {
  const resolved = resolveTheme(theme);
  document.body.dataset.theme = resolved;
  if (monaco) monaco.editor.setTheme(resolved === "light" ? "orbit-light" : "orbit-dark");
  emit("theme", resolved);
}

export function resolveTheme(theme) {
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function layout() {
  if (editor && !editorHost.hidden) editor.layout();
  if (diffEditor && !diffHost.hidden) diffEditor.layout();
}

// ---- tabs ---------------------------------------------------------------------

function tabs() {
  const v = view();
  return v ? v.tabs : [];
}

function activeTab() {
  const v = view();
  if (!v) return null;
  return v.tabs.find((t) => t.id === v.activeTab) || null;
}

export function getActiveFile() {
  const tab = activeTab();
  return tab && tab.kind === "file" ? tab : null;
}

export function getActiveContent() {
  const tab = getActiveFile();
  return tab ? tab.model.getValue() : "";
}

export function getSelectionText() {
  const tab = getActiveFile();
  if (!tab) return "";
  const selection = editor.getSelection();
  return selection && !selection.isEmpty() ? tab.model.getValueInRange(selection) : "";
}

export function insertAtCursor(text) {
  const tab = getActiveFile();
  if (!tab) { toast("Open a file to insert into."); return; }
  const selection = editor.getSelection();
  editor.executeEdits("ai", [{ range: selection, text, forceMoveMarkers: true }]);
  editor.focus();
}

export async function openFile(path, { line, column, preview = false } = {}) {
  const v = view();
  if (!v) return null;
  let tab = v.tabs.find((t) => t.kind === "file" && t.path === path);
  if (!tab) {
    let file;
    try {
      file = await api.read(path);
    } catch (err) {
      toast(formatError(err), "error");
      return null;
    }
    if (file.binary) {
      toast(`${basename(path)} is a binary file.`);
      return null;
    }
    const uri = monaco.Uri.file(path);
    let model = monaco.editor.getModel(uri);
    if (!model) model = monaco.editor.createModel(file.content, undefined, uri);
    else model.setValue(file.content);
    tab = { id: nextTabId++, kind: "file", path, title: basename(path), model, viewState: null, savedVersion: model.getAlternativeVersionId(), dirty: false, external: false };
    model.onDidChangeContent(() => {
      const dirty = model.getAlternativeVersionId() !== tab.savedVersion;
      if (dirty !== tab.dirty) { tab.dirty = dirty; renderTabs(); emit("dirty", countDirty()); }
    });
    v.tabs.push(tab);
  }
  activateTab(tab.id);
  if (line) {
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: column || 1 });
  }
  editor.focus();
  return tab;
}

export function openDiff({ title, path, original, modified, language }) {
  const v = view();
  if (!v) return;
  const key = `diff:${path}:${title}`;
  let tab = v.tabs.find((t) => t.kind === "diff" && t.key === key);
  const lang = language || languageFor(path);
  if (!tab) {
    tab = {
      id: nextTabId++, kind: "diff", key, path, title,
      original: monaco.editor.createModel(original, lang),
      modified: monaco.editor.createModel(modified, lang),
    };
    v.tabs.push(tab);
  } else {
    tab.original.setValue(original);
    tab.modified.setValue(modified);
  }
  activateTab(tab.id);
}

export function languageFor(path) {
  const ext = basename(path).split(".").pop().toLowerCase();
  const name = basename(path).toLowerCase();
  const langs = monaco.languages.getLanguages();
  for (const lang of langs) {
    if ((lang.filenames || []).some((f) => f.toLowerCase() === name)) return lang.id;
    if ((lang.extensions || []).some((e) => e.toLowerCase() === "." + ext)) return lang.id;
  }
  return "plaintext";
}

export function activateTab(id) {
  const v = view();
  if (!v) return;
  const current = activeTab();
  if (current && current.kind === "file" && current.id !== id) current.viewState = editor.saveViewState();
  v.activeTab = id;
  showView();
  renderTabs();
}

function showView() {
  const tab = activeTab();
  if (!tab) {
    editor.setModel(null);
    editorHost.hidden = true;
    diffHost.hidden = true;
    welcome.hidden = false;
    $("#status-language").textContent = "";
    $("#status-cursor").textContent = "";
    return;
  }
  welcome.hidden = true;
  if (tab.kind === "file") {
    diffHost.hidden = true;
    editorHost.hidden = false;
    editor.setModel(tab.model);
    if (tab.viewState) editor.restoreViewState(tab.viewState);
    editor.layout();
    const lang = tab.model.getLanguageId();
    $("#status-language").textContent = lang === "plaintext" ? "Plain text" : lang;
  } else {
    editorHost.hidden = true;
    diffHost.hidden = false;
    diffEditor.setModel({ original: tab.original, modified: tab.modified });
    diffEditor.layout();
    requestAnimationFrame(() => diffEditor.layout());
    $("#status-language").textContent = "diff";
    $("#status-cursor").textContent = "";
  }
  emit("tab", tab);
}

export function renderTabs() {
  const v = view();
  tabsEl.innerHTML = "";
  if (!v) return;
  for (const tab of v.tabs) {
    const node = el("div", {
      class: `tab ${tab.id === v.activeTab ? "active" : ""} ${tab.dirty ? "dirty" : ""} ${tab.kind}`,
      title: tab.path,
      onclick: () => activateTab(tab.id),
      onauxclick: (event) => { if (event.button === 1) closeTab(tab.id); },
    }, [
      el("span", { class: "tab-name", text: tab.title + (tab.external ? " (changed on disk)" : "") }),
      el("button", { class: "tab-close", title: "Close", onclick: (event) => { event.stopPropagation(); closeTab(tab.id); } }, [el("span", { text: "×" })]),
    ]);
    tabsEl.append(node);
  }
  const active = tabsEl.querySelector(".tab.active");
  if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export async function closeTab(id, { force = false } = {}) {
  const v = view();
  if (!v) return false;
  const idx = v.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return true;
  const tab = v.tabs[idx];
  if (tab.kind === "file" && tab.dirty && !force) {
    const ok = await confirmDialog(`Close ${tab.title}?`, "The file has unsaved changes. Closing it throws them away.", { ok: "Close without saving", danger: true });
    if (!ok) return false;
  }
  v.tabs.splice(idx, 1);
  if (tab.kind === "file") {
    if (editor.getModel() === tab.model) editor.setModel(null);
    tab.model.dispose();
  } else {
    disposeDiffModels(tab);
  }
  if (v.activeTab === id) {
    const next = v.tabs[Math.min(idx, v.tabs.length - 1)];
    v.activeTab = next ? next.id : null;
  }
  showView();
  renderTabs();
  emit("dirty", countDirty());
  return true;
}

/// The diff editor must let go of a pair of models before they are disposed,
/// or Monaco throws "TextModel got disposed before DiffEditorWidget model got reset".
function disposeDiffModels(tab) {
  const current = diffEditor.getModel();
  if (current && (current.original === tab.original || current.modified === tab.modified)) diffEditor.setModel(null);
  tab.original.dispose();
  tab.modified.dispose();
}

export async function closeAllTabs(projectPath) {
  const v = view(projectPath);
  if (!v) return;
  for (const tab of [...v.tabs]) {
    if (tab.kind === "file") {
      if (editor.getModel() === tab.model) editor.setModel(null);
      tab.model.dispose();
    } else disposeDiffModels(tab);
  }
  v.tabs = [];
  v.activeTab = null;
  if (projectPath === state.project) { showView(); renderTabs(); }
}

export async function saveActive() {
  const tab = getActiveFile();
  if (!tab) return false;
  return saveTab(tab);
}

export async function saveTab(tab) {
  try {
    await api.write(tab.path, tab.model.getValue());
    tab.savedVersion = tab.model.getAlternativeVersionId();
    tab.dirty = false;
    tab.external = false;
    renderTabs();
    emit("dirty", countDirty());
    emit("saved", tab.path);
    return true;
  } catch (err) {
    toast(formatError(err), "error");
    return false;
  }
}

export async function saveAll() {
  for (const tab of tabs()) if (tab.kind === "file" && tab.dirty) await saveTab(tab);
}

export function countDirty() {
  return tabs().filter((t) => t.kind === "file" && t.dirty).length;
}

/// A file changed on disk (an agent or another app wrote it).
export async function fileChangedOnDisk(path) {
  for (const [, v] of state.views) {
    const tab = v.tabs.find((t) => t.kind === "file" && t.path === path);
    if (!tab) continue;
    let file;
    try { file = await api.read(path); } catch { continue; }
    if (file.binary) continue;
    if (file.content === tab.model.getValue()) { tab.external = false; continue; }
    if (!tab.dirty) {
      const isActive = v === view() && v.activeTab === tab.id;
      const viewState = isActive ? editor.saveViewState() : tab.viewState;
      tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: file.content }], () => null);
      tab.savedVersion = tab.model.getAlternativeVersionId();
      tab.dirty = false;
      if (isActive && viewState) editor.restoreViewState(viewState);
    } else {
      tab.external = true;
    }
  }
  renderTabs();
}

export function fileRemoved(path) {
  for (const [, v] of state.views) {
    for (const tab of [...v.tabs]) {
      if (tab.kind === "file" && (tab.path === path || tab.path.startsWith(path + "/")) && !tab.dirty) {
        if (v === view()) closeTab(tab.id, { force: true });
      }
    }
  }
}

export function switchProjectView() {
  showView();
  renderTabs();
}

export function focusEditor() {
  if (editor && !editorHost.hidden) editor.focus();
}

export function editorInstance() {
  return editor;
}
