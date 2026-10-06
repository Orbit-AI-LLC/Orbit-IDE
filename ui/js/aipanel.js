// The AI dock. Claude Code, Codex and Grok run as their real CLIs in a
// terminal inside the project, so every tool they have is available.
// OpenRouter is a streaming chat with the open file as optional context.
import { api, listen } from "./api.js";
import { state, view, saveSettings, on, provider, refreshProviders, projectName } from "./state.js";
import { $, el, basename, relPath, toast, formatError, renderMarkdown, confirmDialog } from "./ui.js";
import { Term } from "./terminal.js";
import { getActiveFile, getActiveContent, getSelectionText, insertAtCursor } from "./editor.js";
import { openSettings } from "./settings.js";

const PROVIDERS = [
  { id: "claude", name: "Claude", cli: "claude", blurb: "Claude Code with all of its tools, running in this project.", continueArgs: ["--continue"], modelFlag: "--model", settingsKey: "claude" },
  { id: "codex", name: "Codex", cli: "codex", blurb: "OpenAI Codex with all of its tools, running in this project.", continueArgs: ["resume", "--last"], modelFlag: "-m", settingsKey: "codex" },
  { id: "grok", name: "Grok", cli: "grok", blurb: "Grok Build with all of its tools, running in this project.", continueArgs: ["--continue"], modelFlag: "-m", settingsKey: "grok" },
  { id: "openrouter", name: "OpenRouter", blurb: "Any model on OpenRouter, in a chat with your open file as context." },
];

let dock, tabsEl, bodyEl, actionsEl;

export function initAiPanel() {
  dock = $("#ai-dock");
  tabsEl = $("#ai-tabs");
  bodyEl = $("#ai-body");
  actionsEl = $("#ai-actions");
  listen("ai:delta", ({ id, text }) => onDelta(id, text));
  listen("ai:done", ({ id, error }) => onDone(id, error));
  on("providers", () => renderTabs());
  on("project", () => renderAll());
  renderAll();
}

export function toggleAiDock(force) {
  const open = force === undefined ? dock.classList.contains("collapsed") : force;
  dock.classList.toggle("collapsed", !open);
  $("#gutter-ai").hidden = !open;
  $("#btn-toggle-ai").classList.toggle("active", open);
  window.dispatchEvent(new Event("resize"));
  if (open) renderAll();
}

export function isAiDockOpen() {
  return !dock.classList.contains("collapsed");
}

function currentTab() {
  const v = view();
  return (v && v.aiTab) || state.settings.commit_provider || "claude";
}

export function renderAll() {
  renderTabs();
  renderBody();
}

function renderTabs() {
  tabsEl.innerHTML = "";
  const v = view();
  const active = currentTab();
  for (const p of PROVIDERS) {
    const info = provider(p.id);
    const running = v && v.agents[p.id] && !v.agents[p.id].exited;
    const tab = el("button", { class: `ai-tab ${p.id === active ? "active" : ""} ${running ? "running" : ""} ${info && !info.available ? "missing" : ""}`, title: info ? info.detail : "" }, [
      el("span", { class: "dot" }), el("span", { text: p.name }),
    ]);
    tab.addEventListener("click", () => { if (v) v.aiTab = p.id; renderAll(); });
    tabsEl.append(tab);
  }
}

function renderBody() {
  const v = view();
  const id = currentTab();
  actionsEl.innerHTML = "";
  // Keep every terminal alive; show the one for the active project and tab.
  for (const [, pv] of state.views) for (const [pid, term] of Object.entries(pv.agents)) term.el.hidden = !(pv === v && pid === id);
  for (const node of bodyEl.querySelectorAll(".ai-view")) node.remove();
  if (!v) {
    bodyEl.append(el("div", { class: "ai-view" }, [el("div", { class: "ai-start" }, [el("h3", { text: "AI" }), el("p", { text: "Open a project to work with Claude, Codex, Grok or OpenRouter." })])]));
    return;
  }
  const p = PROVIDERS.find((x) => x.id === id);
  if (id === "openrouter") { renderChat(v); return; }
  const term = v.agents[id];
  if (term) {
    actionsEl.append(
      el("button", { class: "icon-btn", title: "Restart", text: "↻", onclick: async () => {
        if (term.exited || await confirmDialog(`Restart ${p.name}?`, "The running session is stopped.", { ok: "Restart" })) startAgent(p, []);
      } }),
      el("button", { class: "icon-btn", title: term.exited ? "Close" : "Stop", text: "×", onclick: () => { if (term.exited) closeAgent(v, id); else term.kill(); } }),
    );
    if (term.exitBar) { term.exitBar.remove(); term.exitBar = null; }
    if (term.exited) {
      term.exitBar = el("div", { class: "term-exit" }, [
        el("span", { text: `${p.name} session ended${term.exitCode !== undefined && term.exitCode !== null ? ` (exit ${term.exitCode})` : ""}. The output stays until you close it.` }),
        el("button", { class: "btn", text: "Restart", onclick: () => startAgent(p, []) }),
        el("button", { class: "btn", text: "Close", onclick: () => closeAgent(v, id) }),
      ]);
      term.el.append(term.exitBar);
    } else {
      requestAnimationFrame(() => term.focus());
    }
    return;
  }
  const info = provider(id) || { available: false, detail: "" };
  const cfg = state.settings;
  const model = cfg[`${p.settingsKey}_model`];
  const extra = cfg[`${p.settingsKey}_args`];
  const start = el("div", { class: "ai-view" }, [el("div", { class: "ai-start" }, [
    el("h3", { text: p.name }),
    el("p", { text: p.blurb }),
    info.available
      ? el("p", {}, [el("code", { text: `cd ${basename(v.path)} && ${p.cli}${model ? ` ${p.modelFlag} ${model}` : ""}${extra ? " " + extra : ""}` })])
      : el("p", { class: "warn", text: info.detail }),
    term && term.exited ? el("p", { text: `The last session ended${term.exitCode !== undefined && term.exitCode !== null ? ` (exit ${term.exitCode})` : ""}.` }) : null,
    el("div", { class: "btn-row" }, [
      el("button", { class: "btn primary", text: `Start ${p.name}`, disabled: !info.available, onclick: () => startAgent(p, []) }),
      el("button", { class: "btn", text: "Continue last session", disabled: !info.available, onclick: () => startAgent(p, p.continueArgs) }),
      el("button", { class: "btn", text: "Settings", onclick: () => openSettings("providers") }),
    ]),
    !info.available ? el("button", { class: "btn", text: "Check again", onclick: () => refreshProviders() }) : null,
  ])]);
  bodyEl.append(start);
}

function closeAgent(v, id) {
  const term = v.agents[id];
  if (!term) return;
  term.dispose();
  delete v.agents[id];
  renderAll();
}

async function startAgent(p, leadArgs) {
  const v = view();
  if (!v) return;
  const old = v.agents[p.id];
  if (old) { old.dispose(); delete v.agents[p.id]; }
  const cfg = state.settings;
  const model = (cfg[`${p.settingsKey}_model`] || "").trim();
  const extra = (cfg[`${p.settingsKey}_args`] || "").trim();
  const args = [...leadArgs];
  if (model) args.push(p.modelFlag, model);
  if (extra) args.push(...extra.split(/\s+/));
  const term = new Term({ cwd: v.path, program: p.cli, args, host: bodyEl, onExit: (code) => {
    term.exitCode = code;
    if (view() === v && currentTab() === p.id) renderAll(); else renderTabs();
  } });
  v.agents[p.id] = term;
  renderAll();
  try { await term.start(); term.focus(); } catch { /* shown in the terminal */ }
}

// ---- OpenRouter chat ----------------------------------------------------------

const streams = new Map(); // request id -> { v, message, node }

function renderChat(v) {
  const chat = v.chat;
  const info = provider("openrouter");
  actionsEl.append(el("button", { class: "icon-btn", title: "Clear conversation", text: "⌫", onclick: () => { chat.messages = []; renderBody(); } }));
  const messages = el("div", { class: "chat-messages" });
  if (!chat.messages.length) messages.append(el("div", { class: "chat-empty", text: info && info.available ? `Ask ${state.settings.openrouter_model} about ${projectName(v.path)}. Attach the open file or a selection for context.` : "Add an OpenRouter API key in Settings to chat." }));
  for (const m of chat.messages) messages.append(messageNode(m));
  messages.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-act]");
    if (button) {
      const code = button.closest("pre").querySelector("code").textContent;
      if (button.dataset.act === "copy") { navigator.clipboard.writeText(code); toast("Copied."); } else insertAtCursor(code);
      return;
    }
    const link = event.target.closest("a[data-external]");
    if (link) { event.preventDefault(); api.openExternal(link.getAttribute("href")).catch(() => {}); }
  });
  const model = el("input", { type: "text", value: state.settings.openrouter_model, placeholder: "provider/model", title: "OpenRouter model id", list: "openrouter-models", spellcheck: "false" });
  model.addEventListener("change", () => saveSettings({ openrouter_model: model.value.trim() }));
  const toolbar = el("div", { class: "chat-toolbar" }, [model, el("button", { class: "btn", text: "Models", title: "Browse models", onclick: () => openSettings("providers") })]);
  const input = el("textarea", { placeholder: "Ask about your code. Enter to send, Shift+Enter for a new line.", rows: 3 });
  input.value = chat.draft || "";
  input.addEventListener("input", () => { chat.draft = input.value; });
  const attachFile = el("input", { type: "checkbox", checked: chat.attachFile !== false });
  const attachSel = el("input", { type: "checkbox", checked: chat.attachSelection === true });
  attachFile.addEventListener("change", () => { chat.attachFile = attachFile.checked; });
  attachSel.addEventListener("change", () => { chat.attachSelection = attachSel.checked; });
  const sendBtn = el("button", { class: "btn primary", text: chat.streamingId ? "Stop" : "Send", onclick: () => chat.streamingId ? api.aiCancel(chat.streamingId) : send(v, input) });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!chat.streamingId) send(v, input); }
  });
  const file = getActiveFile();
  const compose = el("div", { class: "chat-compose" }, [
    input,
    el("div", { class: "chat-compose-row" }, [
      el("label", { title: file ? file.path : "No file open" }, [attachFile, `Open file${file ? ` (${file.title})` : ""}`]),
      el("label", {}, [attachSel, "Selection"]),
      sendBtn,
    ]),
  ]);
  bodyEl.append(el("div", { class: "ai-view" }, [el("div", { class: "chat" }, [toolbar, messages, compose])]));
  messages.scrollTop = messages.scrollHeight;
}

function messageNode(m) {
  if (m.role === "user") return el("div", { class: "msg user", text: m.display || m.content });
  if (m.role === "error") return el("div", { class: "msg error", text: m.content });
  const node = el("div", { class: "msg assistant" }, [el("div", { class: "md", html: renderMarkdown(m.content) })]);
  if (m.streaming) node.classList.add("cursor");
  return node;
}

async function send(v, input) {
  const chat = v.chat;
  const text = input.value.trim();
  if (!text) return;
  const info = provider("openrouter");
  if (!info || !info.available) { toast("Add an OpenRouter API key in Settings.", "error"); openSettings("providers"); return; }
  let context = "";
  const file = getActiveFile();
  if (chat.attachSelection && getSelectionText()) context += `\n\nSelected text in ${file ? relPath(v.path, file.path) : "the editor"}:\n\`\`\`\n${getSelectionText()}\n\`\`\``;
  else if (chat.attachFile !== false && file) context += `\n\nOpen file ${relPath(v.path, file.path)}:\n\`\`\`\n${getActiveContent().slice(0, 60000)}\n\`\`\``;
  chat.messages.push({ role: "user", content: text + context, display: text });
  const reply = { role: "assistant", content: "", streaming: true };
  chat.messages.push(reply);
  chat.draft = "";
  input.value = "";
  const id = `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  chat.streamingId = id;
  renderBody();
  const node = bodyEl.querySelector(".chat-messages").lastElementChild;
  streams.set(id, { v, message: reply, node });
  const system = { role: "system", content: `You are a senior software engineer helping inside Orbit IDE, an editor. The project is "${projectName(v.path)}" at ${v.path}. Answer precisely, show code in fenced blocks with the language, and keep prose short. When you change code, show only the parts that change unless asked for the whole file.` };
  const history = chat.messages.filter((m) => m.role === "user" || (m.role === "assistant" && !m.streaming)).slice(-20).map((m) => ({ role: m.role, content: m.content }));
  try {
    await api.aiChat(id, state.settings.openrouter_model, [system, ...history]);
  } catch (err) { onDone(id, formatError(err)); }
}

function onDelta(id, text) {
  const s = streams.get(id);
  if (!s) return;
  s.message.content += text;
  const md = s.node.querySelector(".md");
  if (md) md.innerHTML = renderMarkdown(s.message.content);
  const list = s.node.parentElement;
  if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 80) list.scrollTop = list.scrollHeight;
}

function onDone(id, error) {
  const s = streams.get(id);
  if (!s) return;
  streams.delete(id);
  s.message.streaming = false;
  if (error) {
    if (!s.message.content) s.v.chat.messages.pop();
    s.v.chat.messages.push({ role: "error", content: error });
  }
  s.v.chat.streamingId = null;
  if (view() === s.v && currentTab() === "openrouter") renderBody();
}
