// Request router. Public routes first; if none claim the request, we check
// whether any private route *could* claim it (by path shape alone, before
// auth). If none could, respond 404 without challenging for a token — so an
// API consumer hitting a wrong URL gets a correct 404 instead of a 401.
//
// If a private route could match, auth() runs and the full private pipeline
// gets a shot at it.

import { parsePath, httpError } from "./lib/http.js";
import { auth } from "./middleware/auth.js";

import { tryAuth, trySignOut } from "./routes/auth.js";
import { tryBootstrap } from "./routes/bootstrap.js";
import { tryUsers } from "./routes/users.js";
import { tryMaster } from "./routes/master.js";
import { trySamples } from "./routes/samples.js";
import { tryResults } from "./routes/results.js";
import { tryFiles } from "./routes/files.js";
import { tryArchive } from "./routes/archive.js";
import { tryAuditArchive } from "./routes/audit-archive.js";

// Public routes that need no auth.
const PUBLIC_ROUTES = [tryAuth];

// Private routes. Order: fast-path first, heavy routes later.
const PRIVATE_ROUTES = [
  trySignOut, tryBootstrap, tryUsers, tryMaster,
  trySamples, tryResults, tryFiles, tryArchive, tryAuditArchive
];

// Path-shape prefixes a private route *might* claim. Used only to decide
// whether to challenge for auth on an unknown-path request. Over-inclusive is
// safe (we still 404 after auth); under-inclusive would hide a real route.
const PRIVATE_PATH_PREFIXES = [
  "api/sign-out", "api/bootstrap", "api/alerts",
  "api/users", "api/people", "api/storage-locations", "api/tests",
  "api/samples", "api/search-sample",
  "api/media", "api/archive", "api/audit"
];

function pathMatchesPrivateShape(path) {
  const joined = path.join("/");
  return PRIVATE_PATH_PREFIXES.some(p => joined === p || joined.startsWith(p + "/"));
}

export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = parsePath(url);
  const method = request.method;
  const dispatch = { url, path, method };

  // Public routes
  for (const route of PUBLIC_ROUTES) {
    const res = await route(request, env, ctx, dispatch);
    if (res) return res;
  }

  // If no private route could possibly match this path, 404 without asking
  // for a token. Prevents the misleading "Login required" on bad URLs.
  if (!pathMatchesPrivateShape(path)) {
    throw httpError("API route not found", 404);
  }

  // Private routes — authenticate once
  const { user } = await auth(request, env);
  const dispatchWithUser = { ...dispatch, user };

  for (const route of PRIVATE_ROUTES) {
    const res = await route(request, env, ctx, dispatchWithUser);
    if (res) return res;
  }

  throw httpError("API route not found", 404);
}
