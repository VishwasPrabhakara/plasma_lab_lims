// Admin routes to list and fetch the monthly audit archives.
//
// GET  /api/audit/archive                 — list every archive batch
// GET  /api/audit/archive/:yearMonth      — stream the NDJSON file back
// POST /api/audit/archive/run             — manually trigger the rotator
//                                           (useful for on-demand cleanup, demos)
//
// All admin-only. The actual rotation logic lives in lib/audit-archive.js so
// the cron can call it too.

import { json, httpError } from "../lib/http.js";
import { requireRole } from "../lib/perms.js";
import { addAudit } from "../lib/db.js";
import { rotateAuditLog } from "../lib/audit-archive.js";

export async function tryAuditArchive(request, env, ctx, { path, method, user }) {
  if (!(path[0] === "api" && path[1] === "audit" && path[2] === "archive")) return null;
  requireRole(user, "admin");

  /* ---------- List archive batches ---------- */
  if (method === "GET" && path.length === 3) {
    const rows = (await env.DB.prepare(
      "SELECT id, year_month, r2_key, sha256, row_count, from_at, to_at, byte_size, pruned_from_d1, created_at, created_by FROM audit_archive_batches ORDER BY year_month DESC"
    ).all()).results || [];
    return json({ batches: rows.map(r => ({
      id: r.id,
      yearMonth: r.year_month,
      r2Key: r.r2_key,
      sha256: r.sha256,
      rowCount: r.row_count,
      fromAt: r.from_at, toAt: r.to_at,
      byteSize: r.byte_size,
      prunedFromD1: Boolean(r.pruned_from_d1),
      createdAt: r.created_at,
      createdBy: r.created_by
    })) });
  }

  /* ---------- Fetch an archive file ----------
     Returns the raw NDJSON. The sha256 is in the response headers so a client
     can re-hash the body and compare without a round-trip. */
  if (method === "GET" && path.length === 4) {
    const yearMonth = path[3];
    if (!/^\d{4}-\d{2}$/.test(yearMonth)) throw httpError("yearMonth must be YYYY-MM", 400);
    const batch = await env.DB.prepare(
      "SELECT * FROM audit_archive_batches WHERE year_month = ? LIMIT 1"
    ).bind(yearMonth).first();
    if (!batch) throw httpError("Archive not found", 404);
    if (!env.MEDIA) throw httpError("Media bucket not bound", 500);
    const obj = await env.MEDIA.get(batch.r2_key);
    if (!obj) throw httpError("Archive object missing from R2 — manifest row exists but object does not", 404);
    return new Response(obj.body, {
      headers: {
        "content-type": "application/x-ndjson",
        "x-sha256": batch.sha256,
        "x-row-count": String(batch.row_count),
        "content-disposition": `attachment; filename="audit-${yearMonth}.ndjson"`
      }
    });
  }

  /* ---------- Trigger rotation manually ---------- */
  if (method === "POST" && path.length === 4 && path[3] === "run") {
    const summary = await rotateAuditLog(env, { actorName: user.name });
    await addAudit(env, user, "Ran audit-log rotation", "audit", null, JSON.stringify(summary));
    return json(summary);
  }

  return null;
}
