// Small DOM helpers, dialogs, menus and toasts.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const basename = (path) => path.replace(/\/+$/, "").split("/").pop() || path;
export const dirname = (path) => {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
};
export const joinPath = (dir, name) => (dir.endsWith("/") ? dir + name : dir + "/" + name);
export const relPath = (root, path) => (path.startsWith(root + "/") ? path.slice(root.length + 1) : path);
export const extname = (path) => {
  const name = basename(path);
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : "";
};

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function formatError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

// ---- toasts -----------------------------------------------------------------

export function toast(message, kind = "info", ms = 4200) {
  const host = $("#toasts");
  const node = el("div", { class: `toast ${kind}`, text: message });
  host.append(node);
  const remove = () => node.remove();
  node.addEventListener("click", remove);
  setTimeout(remove, kind === "error" ? Math.max(ms, 7000) : ms);
}

// ---- modals -----------------------------------------------------------------

let modalStack = 0;
export function showModal({ title, body, footer, wide, onClose, className = "" }) {
  const overlay = $("#overlay");
  overlay.hidden = false;
  overlay.innerHTML = "";
  modalStack++;
  const modal = el("div", { class: `modal ${wide ? "wide" : ""} ${className}` });
  if (title !== undefined) {
    modal.append(el("div", { class: "modal-header" }, [el("span", { text: title }), el("button", { class: "icon-btn", text: "×", onclick: () => close(null) })]));
  }
  const bodyEl = el("div", { class: "modal-body" });
  modal.append(bodyEl);
  if (typeof body === "function") body(bodyEl); else if (body) bodyEl.append(body);
  let footerEl = null;
  if (footer) {
    footerEl = el("div", { class: "modal-footer" });
    for (const button of footer) footerEl.append(button);
    modal.append(footerEl);
  }
  overlay.append(modal);
  let closed = false;
  const result = {};
  function close(value) {
    if (closed) return;
    closed = true;
    modalStack = Math.max(0, modalStack - 1);
    overlay.hidden = true;
    overlay.innerHTML = "";
    document.removeEventListener("keydown", onKey, true);
    overlay.removeEventListener("mousedown", onBackdrop);
    if (onClose) onClose(value);
    if (result.resolve) result.resolve(value);
  }
  function onKey(event) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(null); }
  }
  function onBackdrop(event) {
    if (event.target === overlay) close(null);
  }
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", onBackdrop);
  result.close = close;
  result.modal = modal;
  result.body = bodyEl;
  result.promise = new Promise((resolve) => { result.resolve = resolve; });
  return result;
}

export function isModalOpen() {
  return modalStack > 0;
}

export function confirmDialog(title, text, { ok = "OK", danger = false, cancel = "Cancel" } = {}) {
  let m;
  const okBtn = el("button", { class: `btn ${danger ? "danger" : "primary"}`, text: ok, onclick: () => m.close(true) });
  const cancelBtn = el("button", { class: "btn", text: cancel, onclick: () => m.close(false) });
  m = showModal({ title, body: el("p", { text }), footer: [cancelBtn, okBtn] });
  setTimeout(() => okBtn.focus(), 0);
  return m.promise.then((v) => v === true);
}

export function promptDialog(title, { label = "", value = "", placeholder = "", ok = "OK", hint = "" } = {}) {
  let m;
  const input = el("input", { type: "text", value, placeholder, spellcheck: "false", autocomplete: "off" });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); m.close(input.value); }
  });
  const field = el("div", { class: "field" }, [label ? el("label", { text: label }) : null, input, hint ? el("div", { class: "hint", text: hint }) : null]);
  m = showModal({
    title,
    body: field,
    footer: [el("button", { class: "btn", text: "Cancel", onclick: () => m.close(null) }), el("button", { class: "btn primary", text: ok, onclick: () => m.close(input.value) })],
  });
  setTimeout(() => { input.focus(); const dot = value.lastIndexOf("."); input.setSelectionRange(0, dot > 0 ? dot : value.length); }, 0);
  return m.promise;
}

// ---- context menu -------------------------------------------------------------

export function contextMenu(x, y, items) {
  const menu = $("#context-menu");
  menu.innerHTML = "";
  for (const item of items) {
    if (!item) continue;
    if (item.separator) { menu.append(el("hr")); continue; }
    const button = el("button", { class: item.danger ? "danger" : "", disabled: item.disabled }, [el("span", { text: item.label }), item.key ? el("kbd", { text: item.key }) : null]);
    button.addEventListener("click", () => { hide(); item.action && item.action(); });
    menu.append(button);
  }
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + "px";
  function hide() {
    menu.hidden = true;
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", hide);
  }
  function onDown(event) { if (!menu.contains(event.target)) hide(); }
  function onKey(event) { if (event.key === "Escape") hide(); }
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", hide);
  }, 0);
}

// ---- markdown (small, safe) -----------------------------------------------------

export function renderMarkdown(text) {
  const out = [];
  const lines = String(text).split("\n");
  let i = 0;
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join("\n"))}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) { out.push(`<${list.tag}>${list.items.map((it) => `<li>${inline(it)}</li>`).join("")}</${list.tag}>`); list = null; }
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      flushPara(); flushList();
      const lang = fence[1] || "";
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      out.push(`<pre data-lang="${escapeHtml(lang)}"><code>${escapeHtml(code.join("\n"))}</code><span class="code-actions"><button data-act="copy">Copy</button><button data-act="insert">Insert</button></span></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    if (heading) { flushPara(); flushList(); const level = Math.min(3, heading[1].length); out.push(`<h${level}>${inline(heading[2])}</h${level}>`); i++; continue; }
    const bullet = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)/);
    if (bullet) {
      flushPara();
      const tag = /\d/.test(bullet[1]) ? "ol" : "ul";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(bullet[2]);
      i++;
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); i++; continue; }
    if (list && /^\s{2,}/.test(line)) { list.items[list.items.length - 1] += " " + line.trim(); i++; continue; }
    flushList();
    para.push(line);
    i++;
  }
  flushPara(); flushList();
  return out.join("");

  function inline(s) {
    let html = escapeHtml(s);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<em>$2</em>");
    html = html.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1<em>$2</em>");
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-external>$1</a>');
    return html.replace(/\n/g, "<br>");
  }
}
