// Crypto helpers: JWT signing/verification + PBKDF2 password hashing + OTP
// generation + short-lived download URL signing. Uses the Web Crypto API
// available in Cloudflare Workers.

import { PASSWORD_ITERATIONS, PASSWORD_ITERATIONS_LEGACY, now } from "./http.js";

export function b64url(input) {
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new TextEncoder().encode(String(input));
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function fromB64url(v) {
  const padded = v.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(v.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

// Constant-time compare of two strings. Returns true only when identical;
// unequal-length inputs still read every byte so timing cannot leak the
// length either.
export function timingSafeEqual(a, b) {
  const aStr = String(a);
  const bStr = String(b);
  const len = Math.max(aStr.length, bStr.length);
  let diff = aStr.length ^ bStr.length;
  for (let i = 0; i < len; i++) {
    diff |= (aStr.charCodeAt(i) || 0) ^ (bStr.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function signJwt(payload, secret, exp = 12 * 60 * 60) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + exp }));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

export async function verifyJwt(token, secret) {
  const [h, b, s] = String(token || "").split(".");
  if (!h || !b || !s) throw new Error("Invalid session");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const expected = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${b}`)));
  if (!timingSafeEqual(expected, s)) throw new Error("Invalid session");
  const payload = JSON.parse(new TextDecoder().decode(fromB64url(b)));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Session expired");
  return payload;
}

// Stored hash format: "pbkdf2$<iterations>$<b64url-salt>$<b64url-hash>".
// hashPassword always writes PASSWORD_ITERATIONS (currently 600k).
// verifyPassword honors whatever is encoded, so older 100k rows keep
// working; routes/auth.js login opportunistically re-hashes those on
// successful auth.
export async function hashPassword(pwd, iterations = PASSWORD_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pwd), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key, 256
  );
  return `pbkdf2$${iterations}$${b64url(salt.buffer)}$${b64url(bits)}`;
}

export async function verifyPassword(pwd, stored) {
  if (!stored?.startsWith("pbkdf2$")) return false;
  const [, iter, saltText, hashText] = stored.split("$");
  const salt = fromB64url(saltText);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pwd), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: Number(iter), hash: "SHA-256" },
    key, 256
  );
  // Constant-time compare — plain === is a timing side-channel against
  // the stored hash's prefix.
  return timingSafeEqual(b64url(bits), hashText);
}

// Fixed sentinel hash for the "no user found" branch of /login. Runs a real
// PBKDF2 at the legacy iteration count so the response time matches a hit
// against an older-rehash row. The password it hashes is a random string
// nobody will ever submit.
const DUMMY_HASH = `pbkdf2$${PASSWORD_ITERATIONS_LEGACY}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
export async function dummyVerifyPassword(pwd) {
  // Catch any decode failure silently — this call is purely for timing.
  try { await verifyPassword(pwd, DUMMY_HASH); } catch { /* timing-only */ }
}

// Debiased 6-digit OTP via rejection sampling. The old `% 1000000` of a
// random uint32 was slightly biased (2^32 is not a multiple of 1e6).
export function otpCode() {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(6, "0");
  }
}

// OTP TTL. Default is 15 minutes; callers pass the lifetime they want.
export function otpExpiry(minutes = 15) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

// ---------- Short-lived signed download URLs ----------
//
// For <img> / <a href> cases that cannot send an Authorization header, the
// frontend asks the backend for a signed URL. Backend verifies the user's
// bearer token + ACL, then returns `?sig=&exp=`. Middleware honors the sig
// in place of a token, GET-only, for a tiny window (default 120s).
export async function signDownloadUrl(path, env, ttlSeconds = 120) {
  const exp = Math.floor(Date.now() / 1000) + Math.max(1, ttlSeconds);
  const sig = await hmacSha256B64(`${path}.${exp}`, env.JWT_SECRET);
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}sig=${sig}&exp=${exp}`;
}

export async function verifyDownloadSignature(path, sig, exp, env) {
  const now = Math.floor(Date.now() / 1000);
  if (!sig || !exp || Number(exp) < now) return false;
  const expected = await hmacSha256B64(`${path}.${Number(exp)}`, env.JWT_SECRET);
  return timingSafeEqual(expected, String(sig));
}

async function hmacSha256B64(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(sig);
}
