// Request router. Public routes first; if none claim the request, we check
// whether any private route *could* claim it (by path shape alone, before
// auth). If none could, respond 404 without challenging for a token — so an
// API consumer hitting a wrong URL gets a correct 404 instead of a 401.
//
// If a private route could match, auth() runs and the full private pipeline
// gets a shot at it.
//
// Download-URL bypass: a GET to a signed path (?sig=&exp=) with a valid
// signature over its pathname skips Bearer auth. The signed path binds the
// user's ACL check into the signature-issue step, so a stolen signed URL
// still only gives the holder the one resource until exp. The signed-URL
// grant endpoint lives in routes/files.js (POST /api/download-url).

import { parsePath, httpError, json } from "./lib/http.js";
import { verifyDownloadSignature } from "./lib/crypto.js";
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

// Path-shape prefixes a private route *might* claim.
const PRIVATE_PATH_PREFIXES = [
  "api/sign-out", "api/bootstrap", "api/alerts",
  "api/users", "api/people", "api/storage-locations", "api/tests",
  "api/samples", "api/search-sample",
  "api/media", "api/archive", "api/audit", "api/download-url", "api/exports"
];

// GET paths that accept short-lived `?sig=&exp=` in place of Bearer auth.
// Patterns match path arrays. Keep the whitelist tight.
function signatureBypassAllowed(path, method) {
  if (method !== "GET") return false;
  if (path[0] !== "api") return false;
  // /api/samples/:id/{qr.svg,tube-label,report,report.pdf,pdf}
  if (path[1] === "samples" && path[2] && path[3] &&
      ["qr.svg", "tube-label", "report", "report.pdf", "pdf"].includes(path[3])) return true;
  // /api/media/<key...>
  if (path[1] === "media") return true;
  // /api/files/:id
  if (path[1] === "files" && path[2]) return true;
  return false;
}

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

  // Signed-URL bypass: only on whitelisted GET paths, and only when `sig`+
  // `exp` verify against the signer's HMAC of the pathname. The signer
  // (POST /api/download-url) is the one who checks ACLs.
  const sig = url.searchParams.get("sig");
  const exp = url.searchParams.get("exp");
  let user = null;
  let usedQueryToken = false;
  if (sig && exp && signatureBypassAllowed(path, method)) {
    const ok = await verifyDownloadSignature(url.pathname, sig, exp, env);
    if (!ok) throw httpError("Signed URL invalid or expired", 401);
    // The signer bound the resource into the signature; no `user` is loaded
    // here, so route handlers must tolerate a null user when invoked via
    // a signed URL (see tryFiles / samples qr/report handlers).
  } else {
    const authed = await auth(request, env);
    user = authed.user;
    usedQueryToken = authed.usedQueryToken;
  }
  const dispatchWithUser = { ...dispatch, user, signed: !user };

  for (const route of PRIVATE_ROUTES) {
    const res = await route(request, env, ctx, dispatchWithUser);
    if (res) {
      // Stamp a deprecation warning when the client used ?token= rather than
      // a Bearer header. The planned removal date is a project decision; the
      // header is enough signal for now.
      if (usedQueryToken) {
        const h = new Headers(res.headers);
        h.set("x-token-query-deprecated", "Use Authorization header or POST /api/download-url for signed media URLs; ?token= will be removed.");
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
      }
      return res;
    }
  }

  throw httpError("API route not found", 404);
}
