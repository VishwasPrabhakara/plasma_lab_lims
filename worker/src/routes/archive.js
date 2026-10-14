// Archive endpoints: preview (count-only) and export (ZIP bundle). Export can
// optionally soft-archive (set archived_at, retention_status) — never deletes.

import { json, now, httpError } from "../lib/http.js";
import { addAudit } from "../lib/db.js";
import { requireRole } from "../lib/perms.js";
import { buildZip } from "../lib/zip.js";

export async function tryArchive(request, env, ctx, { url, path, method, user }) {
  /* ---------- Archive: preview ---------- */
  if (method === "GET" && path[0] === "api" && path[1] === "archive" && path[2] === "preview") {
    requireRole(user, "admin");
    const u = new URL(request.url);
    const from = u.searchParams.get("from");
    const to = u.searchParams.get("to");
    if (!from || !to) throw httpError("Pass from and to as YYYY-MM-DD", 400);
    const where = "created_at >= ? AND created_at <= ? AND (archived_at IS NULL OR archived_at = '')";
    const bind = [from + "T00:00:00Z", to + "T23:59:59Z"];
    const samples = await env.DB.prepare(`SELECT COUNT(*) AS n FROM samples WHERE ${where}`).bind(...bind).first();
    const photos = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sample_files WHERE sample_id IN (SELECT id FROM samples WHERE ${where})`
    ).bind(...bind).first();
    return json({ count: samples.n, photoCount: photos.n });
  }

  /* ---------- Archive: export ZIP bundle ---------- */
  if (method === "GET" && path[0] === "api" && path[1] === "archive" && path[2] === "export") {
    requireRole(user, "admin");
    const u = new URL(request.url);
    const from = u.searchParams.get("from");
    const to = u.searchParams.get("to");
    const soft = u.searchParams.get("soft") === "1";
    if (!from || !to) throw httpError("Pass from and to as YYYY-MM-DD", 400);

    const where = "created_at >= ? AND created_at <= ? AND (archived_at IS NULL OR archived_at = '')";
    const bind = [from + "T00:00:00Z", to + "T23:59:59Z"];
    const samples = (await env.DB.prepare(`SELECT * FROM samples WHERE ${where} ORDER BY created_at`).bind(...bind).all()).results;
    if (!samples.length) throw httpError("No samples in that range", 404);

    const sampleIds = samples.map(x => x.id);
    const placeholders = sampleIds.map(() => "?").join(",");
    const [resultsAll, filesAll, custodyAll] = await Promise.all([
      env.DB.prepare(`SELECT * FROM sample_results WHERE sample_id IN (${placeholders})`).bind(...sampleIds).all(),
      env.DB.prepare(`SELECT * FROM sample_files WHERE sample_id IN (${placeholders})`).bind(...sampleIds).all(),
      env.DB.prepare(`SELECT * FROM chain_of_custody WHERE sample_id IN (${placeholders})`).bind(...sampleIds).all()
    ]);

    const bundle = {
      meta: {
        generatedAt: now(),
        generatedBy: user.name,
        from, to,
        sampleCount: samples.length,
        softArchived: soft
      },
      samples: samples.map(sm => ({
        ...sm,
        results: resultsAll.results.filter(r => r.sample_id === sm.id),
        files: filesAll.results.filter(f => f.sample_id === sm.id),
        chainOfCustody: custodyAll.results.filter(c => c.sample_id === sm.id)
      }))
    };

    const zip = await buildZip([
      { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(bundle, null, 2)) },
      ...(await Promise.all(filesAll.results.map(async f => {
        if (!f.r2_key || !env.MEDIA) return null;
        const obj = await env.MEDIA.get(f.r2_key);
        if (!obj) return null;
        const bytes = new Uint8Array(await obj.arrayBuffer());
        const safeName = (f.original_name || f.id).replace(/[^a-zA-Z0-9._-]/g, "_");
        return { name: `photos/${f.sample_id}/${f.id}-${safeName}`, data: bytes };
      }))).then(a => a.filter(Boolean))
    ]);

    const batchId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO archive_batches (id, created_at, created_by, cutoff_date, sample_count, file_count, notes) VALUES (?,?,?,?,?,?,?)"
    ).bind(batchId, now(), user.name, to, samples.length, filesAll.results.length,
      JSON.stringify({ from, to, soft, type: "export" })
    ).run();
    if (soft) {
      for (const sm of samples) {
        await env.DB.prepare("UPDATE samples SET archived_at = ?, retention_status = 'Archived', updated_at = ? WHERE id = ?")
          .bind(now(), now(), sm.id).run();
      }
      await addAudit(env, user, "Archived samples", "archive", batchId, `${samples.length} samples ${from} → ${to}`);
    } else {
      await addAudit(env, user, "Exported archive bundle", "archive", batchId, `${samples.length} samples ${from} → ${to} (no state change)`);
    }

    return new Response(zip, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="plasma-lab-archive-${from}_to_${to}.zip"`
      }
    });
  }

  return null;
}
