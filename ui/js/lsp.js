// Language servers: the ones installed on this computer (src-tauri/src/lsp.rs
// finds them on the login PATH and passes messages through). One runs per
// project and server, started when a file it reads is opened. It checks the
// code as you type (errors and warnings in the editor), and answers hover and
// Go to Definition (F12, or Cmd+click) across files. Monaco's own TypeScript
// and JavaScript checks step aside when typescript-language-server is there,
// so nothing shows twice. Settings › General turns them off.
import { api, listen } from "./api.js";
import { state, on } from "./state.js";
import { $, basename, toast } from "./ui.js";
import { looseModel, openFile } from "./editor.js";

let monaco = null;
let servers = new Map(); // editor language -> server program
const clients = new Map(); // `${project}\n${program}` -> Client
const byId = new Map(); // server process id -> Client
const docs = new Map(); // model -> Doc
const registered = new Set(); // editor languages with hover and definition providers
// Servers that couldn't start, or kept stopping, by client key, and why: not
// tried again until language servers are turned off and on.
const failed = new Map();
const crashes = new Map();
let enabled = true;

const SEVERITY = () => ({ 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint });

const fileUri = (path) => monaco.Uri.file(path).toString();
// Servers and Monaco write the same address differently (C: or c%3A).
const canonical = (uri) => monaco.Uri.parse(uri).toString();
// An address as the page writes paths: /Users/me/x, or C:/Users/me/x on Windows.
const pagePath = (uri) => (/^\/[a-zA-Z]:/.test(uri.path) ? uri.path[1].toUpperCase() + uri.path.slice(2) : uri.path);
const toPosition = (position) => ({ line: position.lineNumber - 1, character: position.column - 1 });
const toRange = (range) => new monaco.Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);

// The protocol names React files apart; the editor doesn't.
function languageId(language, path) {
  const ext = path.split(".").pop().toLowerCase();
  if (ext === "tsx") return "typescriptreact";
  if (ext === "jsx") return "javascriptreact";
  return language;
}

class Client {
  constructor(project, program) {
    this.project = project;
    this.program = program;
    this.key = `${project}\n${program}`;
    this.id = null;
    this.next = 1;
    this.pending = new Map();
    this.docs = new Map(); // canonical uri -> Doc
    this.diagnostics = new Map(); // canonical uri -> the last ones published, for files opened later
    this.capabilities = {};
    this.dead = false;
    // Messages leave in order: each waits for the one before.
    this.queue = Promise.resolve();
    this.ready = this.start();
  }

  async start() {
    this.id = await api.lspStart(this.project, this.program);
    byId.set(this.id, this);
    const folder = { uri: fileUri(this.project), name: basename(this.project) };
    const result = await this.request("initialize", {
      processId: null,
      clientInfo: { name: "Orbit IDE" },
      rootUri: folder.uri,
      rootPath: this.project,
      workspaceFolders: [folder],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
        },
        workspace: { workspaceFolders: true, configuration: true },
      },
    }, 60000);
    this.capabilities = (result && result.capabilities) || {};
    this.started = true;
    this.notify("initialized", {});
    return this;
  }

  send(message) {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.queue = this.queue.then(() => api.lspSend(this.id, body)).catch(() => {});
    return this.queue;
  }

  request(method, params, timeout = 15000) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.program} didn't answer ${method}`)); }, timeout);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.send({ id, method, params });
    });
  }

  notify(method, params) {
    if (!this.dead) this.send({ method, params });
  }

  receive(message) {
    if (message.id != null && !message.method) {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message || "failed"));
      else waiting.resolve(message.result);
    } else if (message.id != null) {
      this.answer(message);
    } else if (message.method === "textDocument/publishDiagnostics") {
      const uri = canonical(message.params.uri);
      this.diagnostics.set(uri, message.params.diagnostics || []);
      const doc = this.docs.get(uri);
      if (doc) doc.showDiagnostics(message.params.diagnostics || []);
    }
  }

  // What servers ask of the editor: settings (theirs by default), the
  // folders, and permission for things it doesn't show.
  answer(message) {
    const replies = {
      "workspace/configuration": () => ((message.params && message.params.items) || []).map(() => null),
      "workspace/workspaceFolders": () => [{ uri: fileUri(this.project), name: basename(this.project) }],
      "window/workDoneProgress/create": () => null,
      "client/registerCapability": () => null,
      "client/unregisterCapability": () => null,
      "window/showMessageRequest": () => null,
    };
    const reply = replies[message.method];
    if (reply) this.send({ id: message.id, result: reply() });
    else this.send({ id: message.id, error: { code: -32601, message: `${message.method} isn't supported` } });
  }

  /// The server stopped; `log` is the last of its stderr.
  exited(log = "") {
    if (this.dead) return;
    this.dead = true;
    const why = log.split("\n").map((line) => line.trim()).filter(Boolean).pop() || "it stopped";
    if (!this.stopping) {
      const times = (crashes.get(this.key) || 0) + 1;
      crashes.set(this.key, times);
      if (!this.started) failed.set(this.key, why);
      else if (times >= 3) failed.set(this.key, `it stopped ${times} times: ${why}`);
    }
    for (const waiting of this.pending.values()) waiting.reject(new Error(why));
    this.pending.clear();
    for (const doc of this.docs.values()) doc.detach();
    clients.delete(this.key);
    byId.delete(this.id);
    showStatus();
  }

  async stop() {
    if (this.dead) return;
    this.stopping = true;
    try {
      await this.request("shutdown", null, 3000);
      this.notify("exit");
    } catch { /* stopping anyway */ }
    await api.lspStop(this.id).catch(() => {});
    this.exited();
  }
}

/// A file open in a tab, as one server sees it.
class Doc {
  constructor(client, tab) {
    this.client = client;
    this.tab = tab;
    this.model = tab.model;
    this.uri = fileUri(tab.path);
    this.version = 1;
    this.timer = null;
    client.docs.set(canonical(this.uri), this);
    docs.set(this.model, this);
    client.notify("textDocument/didOpen", { textDocument: { uri: this.uri, languageId: languageId(this.model.getLanguageId(), tab.path), version: 1, text: this.model.getValue() } });
    this.listeners = [
      this.model.onDidChangeContent(() => { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 300); }),
      this.model.onWillDispose(() => this.close()),
    ];
    const known = client.diagnostics.get(canonical(this.uri));
    if (known) this.showDiagnostics(known);
  }

  /// Send the edits typed since the last time: the whole text, which every
  /// server takes whatever kind of sync it asked for.
  flush() {
    if (this.timer == null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.version += 1;
    this.client.notify("textDocument/didChange", { textDocument: { uri: this.uri, version: this.version }, contentChanges: [{ text: this.model.getValue() }] });
  }

  saved() {
    this.flush();
    const sync = this.client.capabilities.textDocumentSync;
    const withText = sync && typeof sync === "object" && sync.save && sync.save.includeText;
    this.client.notify("textDocument/didSave", { textDocument: { uri: this.uri }, ...(withText ? { text: this.model.getValue() } : {}) });
  }

  showDiagnostics(diagnostics) {
    if (this.model.isDisposed()) return;
    const severity = SEVERITY();
    monaco.editor.setModelMarkers(this.model, "lsp", diagnostics.map((d) => ({
      severity: severity[d.severity || 1],
      message: d.message,
      source: d.source,
      code: d.code == null ? undefined : String(typeof d.code === "object" ? d.code.value : d.code),
      ...toRange(d.range),
    })));
  }

  /// The tab closed: the server forgets the file.
  close() {
    if (!this.client.dead) this.client.notify("textDocument/didClose", { textDocument: { uri: this.uri } });
    this.detach();
  }

  /// Stop following the file (the server stopped, or the tab closed).
  detach() {
    clearTimeout(this.timer);
    for (const listener of this.listeners) listener.dispose();
    this.client.docs.delete(canonical(this.uri));
    docs.delete(this.model);
    if (!this.model.isDisposed()) monaco.editor.setModelMarkers(this.model, "lsp", []);
  }
}

function clientFor(project, program) {
  const key = `${project}\n${program}`;
  let client = clients.get(key);
  if (!client) {
    client = new Client(project, program);
    clients.set(key, client);
    client.ready.catch((err) => {
      if (client.stopping) return;
      // Stopped by itself (its stderr says why), or never answered.
      const why = (client.dead && failed.get(key)) || (err && err.message) || String(err);
      if (client.id != null) api.lspStop(client.id).catch(() => {});
      client.exited();
      failed.set(key, why);
      toast(`${program} didn't start: ${why}`, "error", 9000);
      showStatus();
    });
  }
  return client;
}

async function attach(project, tab) {
  if (!state.settings.language_servers || tab.kind !== "file" || docs.has(tab.model) || tab.model.isDisposed()) return;
  const program = servers.get(tab.model.getLanguageId());
  if (!program || failed.has(`${project}\n${program}`)) return;
  const client = clientFor(project, program);
  showStatus();
  try { await client.ready; } catch { return; }
  if (client.dead || tab.model.isDisposed() || docs.has(tab.model)) return;
  new Doc(client, tab);
  provide(tab.model.getLanguageId());
  showStatus();
}

function attachAll() {
  for (const [project, v] of state.views) for (const tab of v.tabs) attach(project, tab);
}

function stopAll() {
  for (const client of [...clients.values()]) client.stop();
}

// ---- hover and Go to Definition ------------------------------------------------

function hoverText(contents) {
  const list = Array.isArray(contents) ? contents : [contents];
  return list.filter(Boolean).map((part) => {
    if (typeof part === "string") return { value: part };
    if (part.kind === "plaintext") return { value: "```\n" + part.value + "\n```" };
    if (part.kind === "markdown") return { value: part.value };
    return { value: "```" + (part.language || "") + "\n" + part.value + "\n```" };
  }).filter((part) => part.value.trim());
}

async function hover(model, position) {
  const doc = docs.get(model);
  if (!doc || !doc.client.capabilities.hoverProvider) return null;
  doc.flush();
  const result = await doc.client.request("textDocument/hover", { textDocument: { uri: doc.uri }, position: toPosition(position) }).catch(() => null);
  const contents = result && result.contents ? hoverText(result.contents) : [];
  return contents.length ? { contents, range: result.range ? toRange(result.range) : undefined } : null;
}

async function definition(model, position) {
  const doc = docs.get(model);
  if (!doc || !doc.client.capabilities.definitionProvider) return null;
  doc.flush();
  const result = await doc.client.request("textDocument/definition", { textDocument: { uri: doc.uri }, position: toPosition(position) }).catch(() => null);
  if (!result) return null;
  const here = canonical(doc.uri);
  const found = (Array.isArray(result) ? result : [result])
    .map((place) => ({ uri: place.targetUri || place.uri, range: place.targetSelectionRange || place.range }))
    .filter((place) => place.uri && place.range);
  const places = [];
  for (const place of found) {
    if (canonical(place.uri) === here) {
      places.push({ uri: model.uri, range: toRange(place.range) });
      continue;
    }
    // Monaco previews the target (Cmd+hover) from a model: load the file
    // if no tab has it. Files that won't load (gone, binary) are left out.
    const target = monaco.Uri.parse(place.uri);
    if (target.scheme !== "file") continue;
    const loaded = await looseModel(pagePath(target));
    if (loaded) places.push({ uri: loaded.uri, range: toRange(place.range) });
  }
  return places;
}

function provide(language) {
  if (registered.has(language)) return;
  registered.add(language);
  monaco.languages.registerHoverProvider(language, { provideHover: hover });
  monaco.languages.registerDefinitionProvider(language, { provideDefinition: definition });
}

/// Go to Definition into another file: open it in a tab, at the place.
function openAt(_source, resource, selection) {
  if (resource.scheme !== "file") return false;
  let place = {};
  if (selection && "startLineNumber" in selection) place = { line: selection.startLineNumber, column: selection.startColumn };
  else if (selection && "lineNumber" in selection) place = { line: selection.lineNumber, column: selection.column };
  openFile(pagePath(resource), place);
  return true;
}

/// With typescript-language-server, Monaco's own TypeScript and JavaScript
/// checks, hover and definitions would say everything twice.
function stepAside() {
  const ts = monaco.typescript || (monaco.languages && monaco.languages.typescript);
  if (!ts) return;
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    if (defaults && defaults.setModeConfiguration) defaults.setModeConfiguration({ ...defaults.modeConfiguration, diagnostics: false, hovers: false, definitions: false });
  }
}

/// The status bar's language says which server is reading the file.
function showStatus() {
  const v = state.project && state.views.get(state.project);
  const tab = v && v.tabs.find((t) => t.id === v.activeTab);
  const item = $("#status-language");
  if (!tab || tab.kind !== "file" || tab.model.isDisposed()) return;
  const language = tab.model.getLanguageId();
  const base = language === "plaintext" ? "Plain text" : language;
  const doc = docs.get(tab.model);
  const program = servers.get(language);
  const client = program && clients.get(`${state.project}\n${program}`);
  const why = program && failed.get(`${state.project}\n${program}`);
  if (doc) { item.textContent = `${base} · ${doc.client.program}`; item.title = `${doc.client.program} checks this file`; }
  else if (why && state.settings.language_servers) { item.textContent = `${base} · ${program} didn't start`; item.title = why; }
  else if (client && !client.dead && state.settings.language_servers) { item.textContent = `${base} · starting ${program}…`; item.title = ""; }
  else { item.textContent = base; item.title = ""; }
}

/// The languages this computer has a server for, and which: for Settings.
export function installedServers() {
  return [...new Set(servers.values())];
}

export async function initLanguageServers() {
  monaco = state.monaco;
  monaco.editor.registerEditorOpener({ openCodeEditor: openAt });
  listen("lsp-message", ({ id, body }) => {
    const client = byId.get(id);
    if (!client) return;
    let message;
    try { message = JSON.parse(body); } catch { return; }
    client.receive(message);
  });
  listen("lsp-exit", ({ id, log }) => { const client = byId.get(id); if (client) client.exited(log); });
  on("file-opened", ({ project, tab }) => attach(project, tab));
  on("saved", (path) => { for (const doc of docs.values()) if (doc.tab.path === path) doc.saved(); });
  on("tab", () => showStatus());
  on("settings", (s) => {
    if (s.language_servers === enabled) return;
    enabled = s.language_servers;
    if (enabled) {
      failed.clear();
      crashes.clear();
      attachAll();
    } else {
      stopAll();
    }
    showStatus();
  });
  const found = await api.lspServers().catch(() => []);
  servers = new Map(found.map((server) => [server.language, server.program]));
  enabled = state.settings.language_servers;
  if (servers.has("typescript")) stepAside();
  // Files opened while the list was being made.
  attachAll();
}
