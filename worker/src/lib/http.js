// HTTP helpers used by every route module.
//
// `json` / `html` are response constructors. `corsHeaders` reads
// env.ALLOWED_ORIGINS so the caller doesn't have to. `parsePath` + `bodyJson`
// are the tiny utilities every handler reaches for.
//
// SECURITY_HEADERS are merged into every response the Worker emits (see
// index.js wrap). They cover transport (HSTS), framing/clickjacking, MIME
// sniffing, referrer leakage and a conservative Permissions-Policy.

export const APP_NAME = "Plasma Lab LIMS";
// Current PBKDF2 cost. Raised from 100000 → 600000 (OWASP 2023 guidance for
// PBKDF2-HMAC-SHA256). Old 100k hashes keep verifying; routes/auth.js re-
// hashes them on the next successful login (see rehashPasswordIfLegacy).
export const PASSWORD_ITERATIONS = 600000;
export const PASSWORD_ITERATIONS_LEGACY = 100000;
export const MIN_PASSWORD_LENGTH = 10;

// Common security headers for every response. HSTS and X-Frame-Options must
// come from the server (meta tags are ignored by browsers for these).
export const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(self), camera=(self), microphone=()"
};

export const json = (body, init = {}) => new Response(JSON.stringify(body), {
  ...init,
  headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...(init.headers || {}) }
});

export const html = (body, init = {}) => new Response(body, {
  ...init,
  headers: {
    "content-type": "text/html; charset=utf-8",
    ...SECURITY_HEADERS,
    // Report/label HTML gets the tightest CSP it can tolerate — no scripts,
    // no external anything. Inline styles only. Images may be self or
    // data: (QR codes ride in as data URLs).
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
    ...(init.headers || {})
  }
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

export function addMinutes(d, minutes) {
  return new Date(new Date(d).getTime() + minutes * 60 * 1000).toISOString();
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

// HTML-escape helper. Used by any route that interpolates DB-sourced strings
// into inline HTML templates. Replace &<>"' with named/numeric entities to
// stop stored-XSS via a client name, collection site, parameter row, etc.
export function esc(s) {
  return String(s == null ? "" : s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ---------- Rate limiter (D1-backed token bucket) ----------
//
// `rateLimit(env, key, {max, intervalS})` increments the bucket for `key`,
// returns { limited: boolean, remaining: number, retryAfterS?: number }.
// The bucket window advances on first hit after it elapses. Keys look like
// "login:ip:1.2.3.4" or "otpresend:email:alice@x". Keep intervals short
// (<= 1h); this is best-effort, not a persistent record.
export async function rateLimit(env, key, { max, intervalS }) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const row = await env.DB.prepare("SELECT * FROM rate_limits WHERE key = ?").bind(key).first();
  let count = 1;
  let windowStart = nowIso;
  if (row) {
    const windowAgeMs = nowMs - new Date(row.window_start).getTime();
    if (windowAgeMs < intervalS * 1000) {
      count = (row.count || 0) + 1;
      windowStart = row.window_start;
    }
  }
  await env.DB.prepare(
    "INSERT OR REPLACE INTO rate_limits (key,count,window_start,last_at) VALUES (?,?,?,?)"
  ).bind(key, count, windowStart, nowIso).run();
  if (count > max) {
    const retryAfterS = Math.max(1, Math.ceil(intervalS - (nowMs - new Date(windowStart).getTime()) / 1000));
    return { limited: true, remaining: 0, retryAfterS };
  }
  return { limited: false, remaining: Math.max(0, max - count) };
}

// Reset a counter after a successful operation (e.g. good login).
export async function rateLimitReset(env, key) {
  await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(key).run();
}

export function clientIp(request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}
