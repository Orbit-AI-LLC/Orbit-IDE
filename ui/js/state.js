// Shared state and a tiny event bus.
import { api } from "./api.js";
import { basename } from "./ui.js";

export const state = {
  settings: null,
  info: null,
  providers: [],
  project: null, // path of the active project
  views: new Map(), // project path -> per-project view state
  monaco: null,
};

const bus = new EventTarget();
export const on = (name, handler) => {
  const wrapped = (event) => handler(event.detail);
  bus.addEventListener(name, wrapped);
  return () => bus.removeEventListener(name, wrapped);
};
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

export async function loadSettings() {
  state.settings = await api.settingsLoad();
  state.defaultCommitInstructions = await api.defaultCommitInstructions().catch(() => "");
  return state.settings;
}

export function commitInstructions() {
  return (state.settings.commit_instructions || "").trim() || state.defaultCommitInstructions || "";
}

let saveTimer = null;
export function saveSettings(patch = {}) {
  Object.assign(state.settings, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.settingsSave(state.settings).catch((err) => console.error("settings", err)), 150);
  emit("settings", state.settings);
}

export function projectName(path) {
  const project = (state.settings.projects || []).find((p) => p.path === path);
  return (project && project.name) || basename(path);
}

export function view(path = state.project) {
  if (!path) return null;
  let v = state.views.get(path);
  if (!v) {
    v = {
      path,
      tabs: [],
      activeTab: null,
      expanded: new Set(),
      selected: null,
      shells: [],
      activeShell: null,
      agents: {}, // provider id -> terminal
      chat: { messages: [], draft: "", streamingId: null },
      aiTab: null,
      git: null,
      gitSelected: null,
      fileList: null,
    };
    state.views.set(path, v);
  }
  return v;
}

export async function refreshProviders() {
  state.providers = await api.aiProviders();
  emit("providers", state.providers);
  return state.providers;
}

export function provider(id) {
  return state.providers.find((p) => p.id === id) || null;
}
