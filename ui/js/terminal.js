// xterm.js terminals backed by pseudo-terminals on the Rust side. Used for
// the bottom shell panel and for the agent CLIs in the AI dock.
import { api, listen } from "./api.js";
import { state, on, view } from "./state.js";
import { $, el, toast, formatError, basename } from "./ui.js";
import { Terminal } from "../vendor/xterm/xterm.mjs";
import { FitAddon } from "../vendor/xterm/addon-fit.mjs";
import { WebLinksAddon } from "../vendor/xterm/addon-web-links.mjs";

const sessions = new Map(); // pty id -> Term
const decoder = new TextDecoder();

function themeFor(theme) {
  return theme === "light"
    ? { background: "#ffffff", foreground: "#1b1b20", cursor: "#1b1b20", selectionBackground: "#c9d6f5", black: "#1b1b20", brightBlack: "#6b6b75" }
    : { background: "#18181b", foreground: "#e4e4e7", cursor: "#e4e4e7", selectionBackground: "#2d3a5c", black: "#18181b", brightBlack: "#7a7a85" };
}

export class Term {
  constructor({ cwd, program = null, args = [], host, onExit, onTitle = null }) {
    this.cwd = cwd;
    this.program = program;
    this.args = args;
    this.onExit = onExit;
    this.title = "";
    this.id = null;
    this.exited = false;
    this.host = host;
    this.el = el("div", { class: "term-host" });
    host.append(this.el);
    this.term = new Terminal({
      fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Monaco, monospace',
      fontSize: Math.max(11, (state.settings.font_size || 13) - 1),
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 8000,
      theme: themeFor(document.body.dataset.theme),
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((event, uri) => api.openExternal(uri).catch(() => {})));
    this.term.open(this.el);
    // Keyboard protocols. Claude Code asks whether the terminal speaks the
    // kitty keyboard protocol (CSI ? u) and turns it on (CSI > flags u) to
    // tell Shift+Enter from Enter everywhere, lists included. Answer that,
    // keep the flag stack, and accept xterm's modifyOtherKeys too.
    this.kittyStack = [];
    this.modifyOtherKeys = 0;
    const kittyFlags = () => (this.kittyStack.length ? this.kittyStack[this.kittyStack.length - 1] : 0);
    const reply = (text) => { if (this.id !== null && !this.exited) api.ptyWrite(this.id, text).catch(() => {}); };
    const parser = this.term.parser;
    parser.registerCsiHandler({ prefix: "?", final: "u" }, () => { reply(`\x1b[?${kittyFlags()}u`); return true; });
    parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
      if (this.kittyStack.length >= 32) this.kittyStack.shift();
      this.kittyStack.push(Number(params[0]) || 0);
      return true;
    });
    parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => {
      const n = Math.max(1, Number(params[0]) || 1);
      this.kittyStack.splice(Math.max(0, this.kittyStack.length - n));
      return true;
    });
    parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
      const flags = Number(params[0]) || 0;
      const mode = Number(params[1]) || 1;
      const current = kittyFlags();
      const next = mode === 2 ? current | flags : mode === 3 ? current & ~flags : flags;
      if (this.kittyStack.length) this.kittyStack[this.kittyStack.length - 1] = next; else this.kittyStack.push(next);
      return true;
    });
    parser.registerCsiHandler({ prefix: ">", final: "m" }, (params) => {
      if ((Number(params[0]) || 0) === 4) this.modifyOtherKeys = params.length > 1 ? Number(params[1]) || 0 : 0;
      return true;
    });
    this.term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.key !== "Enter" || event.metaKey) return true;
      if (!event.shiftKey && !event.ctrlKey && !event.altKey) return true;
      const mod = 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0);
      if (kittyFlags() & 1) reply(`\x1b[13;${mod}u`);
      else if (this.modifyOtherKeys === 2) reply(`\x1b[27;${mod};13~`);
      // Without a protocol, ESC CR is what Claude Code's terminal setup
      // installs for Shift+Enter in editors that lack one.
      else if (event.shiftKey && !event.ctrlKey) reply("\x1b\r");
      else return true;
      return false;
    });
    this.term.onTitleChange((title) => { this.title = title; if (onTitle) onTitle(title); });
    this.term.onData((data) => { if (this.id !== null && !this.exited) api.ptyWrite(this.id, data).catch(() => {}); });
    this.term.onResize(({ cols, rows }) => { if (this.id !== null && !this.exited) api.ptyResize(this.id, cols, rows).catch(() => {}); });
    this.observer = new ResizeObserver(() => this.fitNow());
    this.observer.observe(this.el);
    this.unsubTheme = on("theme", (theme) => { this.term.options.theme = themeFor(theme); });
  }

  async start() {
    this.fitNow();
    const { cols, rows } = this.term;
    try {
      this.id = await api.ptySpawn(this.cwd, this.program, this.args, cols, rows);
    } catch (err) {
      this.term.writeln(`\x1b[31m${formatError(err)}\x1b[0m`);
      this.exited = true;
      api.log("error", `pty spawn failed: ${formatError(err)}`);
      throw err;
    }
    sessions.set(this.id, this);
    api.log("info", `pty ${this.id} started cols=${cols} rows=${rows}`);
    return this;
  }

  fitNow() {
    if (!this.el.isConnected || this.el.offsetWidth === 0 || this.el.offsetHeight === 0) return;
    try { this.fit.fit(); } catch { /* not laid out yet */ }
  }

  write(bytes) {
    this.term.write(bytes);
  }

  focus() {
    this.fitNow();
    this.term.focus();
  }

  async kill() {
    if (this.id !== null && !this.exited) await api.ptyKill(this.id).catch(() => {});
  }

  dispose() {
    this.kill();
    if (this.unsubTheme) this.unsubTheme();
    this.observer.disconnect();
    this.term.dispose();
    this.el.remove();
    if (this.id !== null) sessions.delete(this.id);
  }
}

export function initTerminals() {
  listen("pty:data", ({ id, data }) => {
    const term = sessions.get(id);
    if (!term) return;
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    term.write(bytes);
  });
  listen("pty:exit", ({ id, code }) => {
    const term = sessions.get(id);
    if (!term) return;
    term.exited = true;
    sessions.delete(id);
    if (term.onExit) term.onExit(code);
  });
  initShellPanel();
}

// ---- bottom shell panel ---------------------------------------------------------

let panel, body, tabsEl;

function initShellPanel() {
  panel = $("#terminal-panel");
  body = $("#terminal-body");
  tabsEl = $("#terminal-tabs");
  $("#btn-new-terminal").addEventListener("click", () => newShell());
  $("#btn-close-terminal-panel").addEventListener("click", () => toggleTerminalPanel(false));
}

export function isTerminalPanelOpen() {
  return !panel.hidden;
}

export function toggleTerminalPanel(force) {
  const open = force === undefined ? panel.hidden : force;
  panel.hidden = !open;
  $("#gutter-terminal").hidden = !open;
  $("#btn-toggle-terminal").classList.toggle("active", open);
  if (open) {
    const v = view();
    if (v && v.shells.length === 0) newShell();
    else showActiveShell();
  }
  window.dispatchEvent(new Event("resize"));
}

export async function newShell() {
  const v = view();
  if (!v) { toast("Open a project first."); return; }
  const shellName = state.info && state.info.shell ? basename(state.info.shell).replace(/\.exe$/i, "") : "shell";
  const shell = { id: null, title: `${shellName} ${v.shells.length + 1}`, term: null };
  shell.term = new Term({ cwd: v.path, host: body, onExit: () => closeShell(v, shell) });
  v.shells.push(shell);
  v.activeShell = shell;
  if (panel.hidden) toggleTerminalPanel(true);
  renderShellTabs();
  showActiveShell();
  try { await shell.term.start(); shell.term.focus(); } catch { /* shown in the terminal */ }
}

function closeShell(v, shell) {
  const idx = v.shells.indexOf(shell);
  if (idx >= 0) v.shells.splice(idx, 1);
  shell.term.dispose();
  if (v.activeShell === shell) v.activeShell = v.shells[Math.min(idx, v.shells.length - 1)] || null;
  if (v === view()) { renderShellTabs(); showActiveShell(); }
}

export function renderShellTabs() {
  const v = view();
  tabsEl.innerHTML = "";
  if (!v) return;
  for (const shell of v.shells) {
    tabsEl.append(el("button", { class: `terminal-tab ${shell === v.activeShell ? "active" : ""}`, onclick: () => { v.activeShell = shell; renderShellTabs(); showActiveShell(); } }, [
      el("span", { text: shell.title }),
      el("span", { class: "icon-btn sm", text: "×", title: "Close", onclick: (event) => { event.stopPropagation(); closeShell(v, shell); } }),
    ]));
  }
}

export function showActiveShell() {
  const v = view();
  for (const [, pv] of state.views) for (const shell of pv.shells) shell.term.el.hidden = !(pv === v && shell === v.activeShell);
  if (v && v.activeShell && !panel.hidden) requestAnimationFrame(() => v.activeShell.term.focus());
}

export function switchProjectTerminals() {
  renderShellTabs();
  showActiveShell();
}
