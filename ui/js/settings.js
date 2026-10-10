// The settings dialog.
import { api } from "./api.js";
import { state, saveSettings, refreshProviders, commitInstructions } from "./state.js";
import { $, el, showModal, toast, formatError } from "./ui.js";
import { installedServers } from "./lsp.js";

let modal = null;

export function openSettings(page = "general") {
  if (modal) { modal.close(); modal = null; }
  const s = state.settings;
  const pages = {};
  const tabs = el("div", { class: "settings-tabs" });
  const body = el("div");
  const select = (name) => {
    for (const [key, node] of Object.entries(pages)) node.classList.toggle("active", key === name);
    for (const t of tabs.children) t.classList.toggle("active", t.dataset.page === name);
  };
  for (const [key, label] of [["general", "General"], ["providers", "Providers"], ["commit", "Commit messages"], ["about", "About"]]) {
    tabs.append(el("button", { class: "settings-tab", dataset: { page: key }, text: label, onclick: () => select(key) }));
  }

  const bind = (key, input, { number = false, bool = false } = {}) => {
    if (bool) { input.checked = !!s[key]; input.addEventListener("change", () => saveSettings({ [key]: input.checked })); }
    // Whole numbers only: a 12.5 or -1 would fail this save and every later one.
    else { input.value = s[key] ?? ""; input.addEventListener("change", () => saveSettings({ [key]: number ? Math.max(0, Math.round(Number(input.value) || 0)) : input.value })); }
    return input;
  };
  const field = (label, input, hint) => el("div", { class: "field" }, [el("label", { text: label }), input, hint ? el("div", { class: "hint", text: hint }) : null]);

  // General
  const theme = el("select", {}, [el("option", { value: "dark", text: "Dark" }), el("option", { value: "light", text: "Light" }), el("option", { value: "system", text: "Match system" })]);
  pages.general = el("div", { class: "settings-page" }, [
    field("Theme", bind("theme", theme)),
    el("div", { class: "field-row" }, [
      field("Font size", bind("font_size", el("input", { type: "number", min: "9", max: "28" }), { number: true })),
      field("Tab size", bind("tab_size", el("input", { type: "number", min: "1", max: "8" }), { number: true })),
    ]),
    el("div", { class: "field" }, [el("label", {}, [bind("word_wrap", el("input", { type: "checkbox" }), { bool: true }), " Wrap long lines"])]),
    el("div", { class: "field" }, [
      el("label", {}, [bind("language_servers", el("input", { type: "checkbox" }), { bool: true }), " Language servers"]),
      el("div", { class: "hint", text: `Errors and warnings as you type, hover, and Go to Definition (F12, or Cmd+click), from the language servers installed on this computer: rust-analyzer, typescript-language-server, Pyright or pylsp, gopls and clangd. ${installedServers().length ? `Found: ${installedServers().join(", ")}.` : "None found on the PATH."}` }),
    ]),
  ]);

  // Providers
  const providerBlock = (title, key, hint) => el("div", { class: "field" }, [
    el("label", { text: title }),
    el("div", { class: "field-row" }, [
      field("Model (optional)", bind(`${key}_model`, el("input", { type: "text", placeholder: "default", spellcheck: "false" }))),
      field("Extra arguments", bind(`${key}_args`, el("input", { type: "text", placeholder: "e.g. --permission-mode acceptEdits", spellcheck: "false" }))),
    ]),
    el("div", { class: "hint", text: hint }),
  ]);
  const keyInput = bind("openrouter_api_key", el("input", { type: "password", placeholder: "sk-or-…", spellcheck: "false", autocomplete: "off" }));
  keyInput.addEventListener("change", () => setTimeout(refreshProviders, 300));
  const modelInput = bind("openrouter_model", el("input", { type: "text", list: "openrouter-models", spellcheck: "false" }));
  const loadModels = el("button", { class: "btn", text: "Load model list", onclick: async () => {
    loadModels.disabled = true;
    try {
      const models = await api.aiModels();
      fillDatalist(models);
      toast(`${models.length} models available.`, "success");
    } catch (err) { toast(formatError(err), "error"); }
    loadModels.disabled = false;
  } });
  const status = el("div", { class: "hint" });
  const refreshStatus = () => { status.textContent = state.providers.map((p) => `${p.name}: ${p.available ? "ready" : "not set up"}`).join("  ·  "); };
  refreshStatus();
  pages.providers = el("div", { class: "settings-page" }, [
    el("p", { text: "Orbit AI, Claude, Codex and Grok run through their command-line tools, with whatever account and tools those have. Sign in to each from a terminal once; Orbit AI can be installed from its tab in the dock." }),
    status,
    el("button", { class: "btn", text: "Check tools again", onclick: async () => { await refreshProviders(); refreshStatus(); } }),
    providerBlock("Orbit AI", "orbit", "Started as: orbit [--model …] [extra arguments]. Signs in with your Orbit account; run `orbit login` once, or install it from the Orbit AI tab."),
    providerBlock("Claude Code", "claude", "Started as: claude [--model …] [extra arguments]. Use --continue from the dock to resume."),
    providerBlock("Codex", "codex", "Started as: codex [-m …] [extra arguments]."),
    providerBlock("Grok", "grok", "Started as: grok [-m …] [extra arguments]."),
    el("div", { class: "field" }, [
      el("label", { text: "OpenRouter" }),
      field("API key", keyInput, "Stored in this app's settings file, readable only by your user."),
      el("div", { class: "field-row" }, [field("Model", modelInput), el("div", { class: "field", style: "flex:0" }, [el("label", { text: " " }), loadModels])]),
    ]),
  ]);

  // Commit
  const providerSelect = el("select");
  for (const p of state.providers) providerSelect.append(el("option", { value: p.id, text: p.name }));
  const instructions = el("textarea", { rows: 14, spellcheck: "true", style: "font-family:var(--mono);font-size:12px" });
  instructions.value = commitInstructions();
  instructions.addEventListener("change", () => saveSettings({ commit_instructions: instructions.value.trim() === (state.defaultCommitInstructions || "").trim() ? "" : instructions.value }));
  pages.commit = el("div", { class: "settings-page" }, [
    field("Default provider", bind("commit_provider", providerSelect), "Claude Code writes messages with Haiku, which is quick. Its model setting under Providers is for the Claude tab."),
    field("Instructions", instructions, "Sent before the branch name, recent commit subjects, the file list and the staged diff."),
    el("div", {}, [el("button", { class: "btn", text: "Reset to default", onclick: () => { instructions.value = state.defaultCommitInstructions || ""; saveSettings({ commit_instructions: "" }); } })]),
  ]);

  // About
  const info = state.info || {};
  // The Mac app has Check for Updates in its Help menu; Windows and Linux have it here.
  const checkForUpdates = el("button", { class: "btn", text: "Check for Updates", onclick: async () => {
    checkForUpdates.disabled = true;
    checkForUpdates.textContent = "Checking…";
    // The app says what it found (up to date, ready to restart, or failed) in a dialog of its own.
    await api.checkForUpdates().catch((err) => toast(formatError(err), "error"));
    checkForUpdates.disabled = false;
    checkForUpdates.textContent = "Check for Updates";
  } });
  pages.about = el("div", { class: "settings-page" }, [
    el("p", { text: `Orbit IDE ${info.version || ""}` }),
    info.updates && info.os !== "macos" ? el("div", { class: "field" }, [checkForUpdates, el("div", { class: "hint", text: "Orbit IDE checks for updates on its own every few hours. Check now to get a new version straight away." })]) : null,
    el("p", { text: `An offline editor. Nothing leaves this ${info.os === "macos" ? "Mac" : "computer"} except what you send to the providers you choose.` }),
    el("div", { class: "field" }, [el("label", { text: "Shell" }), el("div", { class: "hint", text: info.shell || "" })]),
    el("div", { class: "field" }, [el("label", { text: "PATH seen by terminals and agents" }), el("div", { class: "hint", style: "word-break:break-all;-webkit-user-select:text;user-select:text", text: info.path || "" })]),
  ]);

  for (const node of Object.values(pages)) body.append(node);
  modal = showModal({ title: "Settings", wide: true, body: (host) => { host.style.paddingTop = "0"; host.append(tabs, body); }, onClose: () => { modal = null; } });
  select(page);
}

export function fillDatalist(models) {
  let list = $("#openrouter-models");
  if (!list) { list = el("datalist", { id: "openrouter-models" }); document.body.append(list); }
  list.innerHTML = "";
  for (const m of models) list.append(el("option", { value: m.id, text: m.name }));
}
