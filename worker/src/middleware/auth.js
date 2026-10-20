// Authentication middleware. Routes call this at the top of their handler
// (or the router does it in bulk for "private" routes).
//
// Returns { user } — the full user row — on success, throws a 401 Error on
// anything that's not a valid, non-deactivated session.
//
// Session revocation: every JWT carries a `sv` claim equal to the user's
// session_version at issue time. Sign-out bumps session_version, which
// invalidates every token issued before the bump. Tokens with no `sv`
// (issued before the field existed) are treated as sv=0 — backward-compat
// for in-flight sessions during the rollout window.
//
// Download signatures: a GET to a media/report endpoint may carry
// `?sig=&exp=` instead of a Bearer header; the dedicated route verifies the
// signature itself (we can't do it generically here — the signed path is
// what gets covered). The middleware stays out of the way by letting
// those routes short-circuit auth via `?sig=` presence (see router.js).
//
// Legacy `?token=` fallback: still accepted on GETs only (for inline <img>
// / <a href> that cannot send a header), with a deprecation warning on the
// response. POST/PATCH/DELETE must send Authorization.

import { verifyJwt } from "../lib/crypto.js";
import { httpError } from "../lib/http.js";

export async function auth(request, env) {
  const url = new URL(request.url);
  const isGet = request.method === "GET";
  const authHeader = (request.headers.get("authorization") || "").replace("Bearer ", "");
  // Restrict ?token= to GET only. Defense in depth: a POST that leaks a
  // ?token= into a referrer chain is a credential leak.
  const queryToken = isGet ? url.searchParams.get("token") : null;
  const token = authHeader || queryToken;
  if (!token) throw httpError("Login required", 401);

  const payload = await verifyJwt(token, env.JWT_SECRET);
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND active = 1").bind(payload.id).first();
  if (!user) throw httpError("Invalid user", 401);

  // Session revocation enforcement: tokens with sv < current session_version
  // are refused. Tokens with no sv claim (pre-rollout) are treated as sv=0.
  const tokenSv = typeof payload.sv === "number" ? payload.sv : 0;
  const userSv = Number(user.session_version || 0);
  if (tokenSv !== userSv) throw httpError("Session revoked", 401);

  return { user, usedQueryToken: Boolean(queryToken) };
}
