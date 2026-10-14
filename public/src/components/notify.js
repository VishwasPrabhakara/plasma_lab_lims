// Notification stack and confirm dialog. The notification stack is
// non-blocking; the confirm dialog is a <dialog> defined in index.html.
//
// confirmDialog returns a Promise that resolves to true/false. It uses
// state.pendingConfirm as the resolver slot so a global click handler can
// close any confirm dialog by returning the clicked button's data-confirm.

import { $ } from "../utils/dom.js";
import { h } from "../utils/dom.js";
import { state } from "../state.js";

const NOTIF_ICONS = { success: "✓", warn: "!", error: "!", info: "i" };

export function notify(opts) {
  const stack = $("#notificationStack");
  const type = opts.type || "info";
  const el = h("div", {
    class: "notification",
    "data-type": type,
    role: type === "error" || type === "warn" ? "alert" : "status"
  },
    h("div", { class: "notif-icon", "aria-hidden": "true" }, NOTIF_ICONS[type] || "·"),
    h("div", { class: "notif-body" },
      h("div", { class: "notif-title" }, opts.title || ""),
      opts.description ? h("div", { class: "notif-desc" }, opts.description) : null,
      opts.action ? h("button", {
        class: "notif-action", type: "button",
        onclick: () => { opts.action.fn(); dismiss(); }
      }, opts.action.label) : null
    ),
    h("button", {
      class: "notif-close", type: "button",
      "aria-label": "Dismiss",
      onclick: () => dismiss()
    }, "×")
  );

  function dismiss() {
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  // Cap stack at 3 — oldest falls off.
  while (stack.children.length >= 3) stack.removeChild(stack.firstChild);
  stack.appendChild(el);

  if (!opts.persist) {
    const ttl = type === "error" ? 8000 : type === "warn" ? 7000 : 5000;
    setTimeout(dismiss, ttl);
  }
  return { dismiss };
}

export function confirmDialog(opts) {
  return new Promise(resolve => {
    const dlg = $("#confirmDialog");
    $("#confirmTitle").textContent = opts.title || "Confirm";
    $("#confirmMessage").textContent = opts.message || "Are you sure?";
    const okBtn = $("#confirmOk");
    okBtn.textContent = opts.okLabel || "Confirm";
    okBtn.className = "btn " + (opts.danger ? "btn-danger" : "btn-primary");

    let settled = false;
    const settle = (val) => {
      if (settled) return;
      settled = true;
      state.pendingConfirm = null;
      try { dlg.removeEventListener("close", onClose); } catch {}
      resolve(val);
    };
    const onClose = () => settle(false);

    state.pendingConfirm = settle;
    dlg.addEventListener("close", onClose);
    dlg.showModal();
  });
}

// Wire the global click handler for buttons inside any confirm dialog that
// carry data-confirm="true"/"false". Called once at startup.
export function installConfirmClickHandler() {
  document.addEventListener("click", e => {
    const btn = e.target.closest("[data-confirm]");
    if (!btn) return;
    const dlg = btn.closest("dialog");
    if (dlg && state.pendingConfirm) {
      const value = btn.dataset.confirm === "true";
      const cb = state.pendingConfirm;
      state.pendingConfirm = null;
      dlg.close();
      cb(value);
    }
  });
}
