// HTTP helpers used by every route module.
//
// `json` / `html` are response constructors. `corsHeaders` reads
// env.ALLOWED_ORIGINS so the caller doesn't have to. `parsePath` + `bodyJson`
// are the tiny utilities every handler reaches for.

export const APP_NAME = "Plasma Lab LIMS";
export const PASSWORD_ITERATIONS = 100000;

export const json = (body, init = {}) => new Response(JSON.stringify(body), {
  ...init,
  headers: { "content-type": "application/json", ...(init.headers || {}) }
});

export const html = (body, init = {}) => new Response(body, {
  ...init,
  headers: { "content-type": "text/html; charset=utf-8", ...(init.headers || {}) }
});

export function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const allowed = String(env.ALLOWED_ORIGINS || env.FRONTEND_PUBLIC_URL || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (!origin || (allowed.length && !allowed.includes(origin))) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "vary": "Origin"
  };
}

export function now() { return new Date().toISOString(); }

export function addDays(d, days) {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r.toISOString();
}

export function parsePath(url) {
  return url.pathname.split("/").filter(Boolean);
}

export async function bodyJson(request) {
  if (!request.headers.get("content-type")?.includes("application/json")) return {};
  return request.json();
}

// Attach an HTTP status to an Error so the top-level fetch handler maps it.
export function httpError(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}
