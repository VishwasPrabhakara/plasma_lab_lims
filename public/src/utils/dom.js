// DOM helpers used by every view. `h` is the hyperscript element builder;
// strings become text nodes (no innerHTML by default), 'html' attr opts into
// trusted markup, 'on*' attrs attach listeners.

export const $ = sel => document.querySelector(sel);
export const $$ = sel => Array.from(document.querySelectorAll(sel));

export const esc = str => String(str ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (typeof c === "string" || typeof c === "number") el.appendChild(document.createTextNode(c));
    else el.appendChild(c);
  }
  return el;
}

export const statusClass = s => "status-" + String(s || "").replaceAll(" ", "-");

export const roleLabel = r => r === "admin" ? "Admin / Manager" : "Analyst";

export const initials = name => String(name || "?")
  .trim()
  .split(/\s+/)
  .map(p => p[0])
  .slice(0, 2)
  .join("")
  .toUpperCase();

export const fmtDate = d => d ? new Date(d).toLocaleString() : "—";
