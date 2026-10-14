// Authentication middleware. Routes call this at the top of their handler
// (or the router does it in bulk for "private" routes).
//
// Returns { user } — the full user row — on success, throws a 401 Error on
// anything that's not a valid, non-deactivated session.

import { verifyJwt } from "../lib/crypto.js";
import { httpError } from "../lib/http.js";

export async function auth(request, env) {
  const token = (request.headers.get("authorization") || "").replace("Bearer ", "")
    || new URL(request.url).searchParams.get("token");
  if (!token) throw httpError("Login required", 401);

  const payload = await verifyJwt(token, env.JWT_SECRET);
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND active = 1").bind(payload.id).first();
  if (!user) throw httpError("Invalid user", 401);

  // Multi-device allowed: no sessionVersion enforcement here. The same account
  // can hold multiple active tokens at once (phone + desktop + a second phone).
  // Sign-out bumps session_version so a future enforcement toggle is one-line.
  return { user };
}
