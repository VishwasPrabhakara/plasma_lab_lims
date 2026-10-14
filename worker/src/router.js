// Request router. Walks the request through the public auth routes first;
// if none claimed it, authenticates and tries the private route groups in
// order. The first module that returns a non-null Response wins.

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

// Public routes that need no auth. Order matters for readability only; each
// matcher is specific enough that overlap is impossible.
const PUBLIC_ROUTES = [tryAuth];

// Private routes. Order: fast-path (sign-out, bootstrap) → heavy routes.
const PRIVATE_ROUTES = [
  trySignOut, tryBootstrap, tryUsers, tryMaster,
  trySamples, tryResults, tryFiles, tryArchive
];

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

  // Private routes — authenticate once
  const { user } = await auth(request, env);
  const dispatchWithUser = { ...dispatch, user };

  for (const route of PRIVATE_ROUTES) {
    const res = await route(request, env, ctx, dispatchWithUser);
    if (res) return res;
  }

  throw httpError("API route not found", 404);
}
