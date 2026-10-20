// Typed fetch wrapper for the Worker API. Attaches the bearer token from
// state.token, parses JSON responses, and surfaces server errors with the
// server's error message rather than "fetch failed".
//
// On 401 to any route except /api/login the session is wiped and
// `onSessionExpired()` is called — the caller re-renders the auth view.

import { API_BASE } from "../config.js";
import { state, clearSessionState } from "../state.js";

let onSessionExpired = () => {};

export function registerSessionExpiredHandler(fn) {
  onSessionExpired = typeof fn === "function" ? fn : (() => {});
}

export function apiUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith("/api") || path.startsWith("/uploads")) return API_BASE + path;
  return path;
}

// Resolve a file.url for use as an <img src> or <a href>. Data URLs pass
// through unchanged. For an API path, callers that can `await` should use
// fetchSignedMediaUrl() — it exchanges the bearer token for a 120-second
// signed URL via POST /api/download-url (H1). mediaUrl() stays synchronous
// for the few remaining call sites that cannot be made async; it still
// returns a ?token= URL and the Worker stamps a deprecation header.
export function mediaUrl(path) {
  if (!path) return "";
  if (path.startsWith("data:")) return path;
  const resolved = apiUrl(path);
  if (!state.token) return resolved;
  const joiner = resolved.includes("?") ? "&" : "?";
  return `${resolved}${joiner}token=${encodeURIComponent(state.token)}`;
}

// H1: exchange our bearer for a short-lived signed URL for `path`. The
// backend ACL-checks the path before signing. 120s TTL. Prefer this over
// mediaUrl() for new code; it does not leak the token into referrer or
// browser history.
export async function fetchSignedMediaUrl(path) {
  if (!path) return "";
  if (path.startsWith("data:")) return path;
  // Only API paths need signing; outside paths pass through.
  if (!path.startsWith("/api/")) return apiUrl(path);
  const data = await api("/api/download-url", {
    method: "POST",
    body: JSON.stringify({ path })
  });
  return data?.url ? apiUrl(data.url) : apiUrl(path);
}

// Helper for the <a href>/<img src> pattern: fetch the signed URL and
// assign it to the given element's attribute when it resolves.
export function signedHref(path, el, attr = "href") {
  fetchSignedMediaUrl(path).then(url => { if (url) el[attr] = url; }).catch(() => {});
}

export function api(path, options = {}) {
  const headers = options.body instanceof FormData
    ? {}
    : { "Content-Type": "application/json" };
  if (state.token) headers.Authorization = "Bearer " + state.token;

  return fetch(apiUrl(path), {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  }).then(async res => {
    const ct = res.headers.get("content-type") || "";
    const text = await res.text();
    let data = null;
    if (ct.includes("application/json")) {
      data = text ? JSON.parse(text) : null;
    } else if (!res.ok) {
      throw new Error("Server returned " + res.status);
    } else {
      return text;
    }

    if (res.status === 401 && path !== "/api/login") {
      clearSessionState();
      onSessionExpired();
      throw new Error("Session expired — please sign in again.");
    }
    if (!res.ok) throw new Error(data?.error || "Request failed");
    return data;
  });
}
