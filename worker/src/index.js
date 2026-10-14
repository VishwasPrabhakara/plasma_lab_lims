// Plasma Lab LIMS — Cloudflare Worker entry.
//
// This file is intentionally tiny: it validates the one piece of config the
// Worker refuses to run without (JWT_SECRET), hands CORS preflights their
// response, and otherwise defers to the router. The scheduled handler fires
// once a month (see wrangler.jsonc `triggers.crons`) and writes a retention
// reminder into the `meta` table — it never auto-deletes.
//
// All route handlers live in `src/routes/*`; all pure helpers (crypto, DB
// adapters, ZIP, email) live in `src/lib/*`; auth middleware lives in
// `src/middleware/auth.js`.

import { json, corsHeaders } from "./lib/http.js";
import { handle } from "./router.js";

export default {
  // Monthly cron: counts samples older than the retention window and writes
  // a notification into the meta table. Admins see this on the dashboard; no
  // automatic deletion ever happens.
  async scheduled(event, env, ctx) {
    try {
      const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      const old = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM samples WHERE created_at < ? AND (archived_at IS NULL OR archived_at = '') AND status != 'Disposed'"
      ).bind(cutoff).first();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO meta (key,value,updated_at) VALUES ('archive_reminder', ?, ?)"
      ).bind(
        JSON.stringify({ olderThanDays: 365, count: old?.n ?? 0, ranAt: new Date().toISOString() }),
        new Date().toISOString()
      ).run();
    } catch (e) {
      console.error("[scheduled] archive reminder failed:", e.message);
    }
  },

  async fetch(request, env, context) {
    if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
      return new Response(
        JSON.stringify({ error: "Server misconfigured: JWT_SECRET missing or too short" }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }

    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const response = await handle(request, env, context);
      const headers = new Headers(response.headers);
      Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch (error) {
      return json(
        { error: error.message || "Worker error", errors: error.errors, approvalStatus: error.approvalStatus },
        { status: error.status || 500, headers: cors }
      );
    }
  }
};
