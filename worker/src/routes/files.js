// Sample file management: upload (multipart), serve from R2, delete.
// Small files ride base64 inline in D1 (Phase 2 compatibility); larger files
// go to R2 and D1 just holds the key.

import { json, now, httpError } from "../lib/http.js";
import { addAudit, loadSampleFull } from "../lib/db.js";
import { canReadSample, canWorkOnSample, requireRole } from "../lib/perms.js";

const INLINE_LIMIT_BYTES = 300 * 1024;

export async function tryFiles(request, env, ctx, { path, method, user }) {
  /* ---------- Upload files ---------- */
  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "files" && !path[4]) {
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(path[2]).first();
    if (!s) throw httpError("Sample not found", 404);
    const isAdmin = user.role === "admin";
    const isCollector = s.collector === user.name;
    if (!isAdmin && !isCollector && !canWorkOnSample(user, s)) {
      throw httpError("Not allowed for this sample", 403);
    }
    const form = await request.formData();
    const category = String(form.get("category") || "Uploaded File");
    const lat = form.get("lat") ? String(form.get("lat")) : null;
    const lng = form.get("lng") ? String(form.get("lng")) : null;
    const takenAt = form.get("takenAt") ? String(form.get("takenAt")) : null;
    const batch = [];
    for (const [, value] of form.entries()) {
      if (!(value instanceof File) || !value.size) continue;
      const id = crypto.randomUUID();
      let dataUrl = null, r2Key = null;
      if (value.size > INLINE_LIMIT_BYTES && env.MEDIA) {
        r2Key = `samples/${s.id}/${id}-${value.name.replaceAll("/", "_")}`;
        await env.MEDIA.put(r2Key, await value.arrayBuffer(), {
          httpMetadata: { contentType: value.type }
        });
      } else {
        const buf = await value.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        bytes.forEach(b => bin += String.fromCharCode(b));
        dataUrl = `data:${value.type || "application/octet-stream"};base64,${btoa(bin)}`;
      }
      batch.push(env.DB.prepare(
        "INSERT INTO sample_files (id,sample_id,original_name,category,r2_key,data_url,size_bytes,mime_type,lat,lng,taken_at,uploaded_by,uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        id, s.id, value.name, category, r2Key, dataUrl,
        value.size, value.type || null, lat, lng, takenAt,
        user.name, now()
      ));
    }
    if (batch.length) await env.DB.batch(batch);
    await env.DB.prepare("UPDATE samples SET updated_at = ? WHERE id = ?").bind(now(), s.id).run();
    return json(await loadSampleFull(env, s.id));
  }

  /* ---------- R2 media serve (ACL-checked) ---------- */
  if (method === "GET" && path[0] === "api" && path[1] === "media") {
    const key = path.slice(2).join("/");
    if (!key || !env.MEDIA) throw httpError("Media not found", 404);

    // ACL: find the parent sample and check this user may read it. Admin reads
    // every file; analyst reads only files on samples canReadSample permits.
    const fileRow = await env.DB.prepare("SELECT sample_id FROM sample_files WHERE r2_key = ? LIMIT 1").bind(key).first();
    if (!fileRow) throw httpError("Media not found", 404);
    const parentSample = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(fileRow.sample_id).first();
    if (!parentSample) throw httpError("Media not found", 404);
    if (!canReadSample(user, parentSample)) throw httpError("Not allowed to read this file", 403);

    const obj = await env.MEDIA.get(key);
    if (!obj) throw httpError("Media not found", 404);
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
        "cache-control": "private, max-age=3600"
      }
    });
  }

  /* ---------- Delete a sample file ---------- */
  if (method === "DELETE" && path[0] === "api" && path[1] === "samples" && path[3] === "files" && path[4]) {
    requireRole(user, "admin");
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(path[2]).first();
    if (!s) throw httpError("Sample not found", 404);
    const file = await env.DB.prepare("SELECT * FROM sample_files WHERE id = ? AND sample_id = ?").bind(path[4], s.id).first();
    if (!file) throw httpError("File not found", 404);
    if (file.r2_key && env.MEDIA) {
      try { await env.MEDIA.delete(file.r2_key); } catch { /* best effort */ }
    }
    await env.DB.prepare("DELETE FROM sample_files WHERE id = ?").bind(file.id).run();
    await addAudit(env, user, "Deleted sample file", "sample", s.id, `${s.sample_code}: ${file.original_name || file.category}`);
    return json({ ok: true });
  }

  return null;
}
