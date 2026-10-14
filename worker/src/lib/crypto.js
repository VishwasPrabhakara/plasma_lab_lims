// Crypto helpers: JWT signing/verification + PBKDF2 password hashing + OTP
// generation. Uses the Web Crypto API available in Cloudflare Workers.

import { PASSWORD_ITERATIONS, addDays, now } from "./http.js";

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
  if (expected !== s) throw new Error("Invalid session");
  const payload = JSON.parse(new TextDecoder().decode(fromB64url(b)));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Session expired");
  return payload;
}

export async function hashPassword(pwd) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pwd), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PASSWORD_ITERATIONS, hash: "SHA-256" },
    key, 256
  );
  return `pbkdf2$${PASSWORD_ITERATIONS}$${b64url(salt.buffer)}$${b64url(bits)}`;
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
  return b64url(bits) === hashText;
}

export function otpCode() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
}

export function otpExpiry() {
  return addDays(now(), 1);
}
