// Sample file management: upload (multipart), serve from R2, delete.
// Small files ride base64 inline in D1 (Phase 2 compatibility); larger files
// go to R2 and D1 just holds the key.
//
// Security:
//   - H6: on upload, we sniff the first 12 bytes and reject mismatches
//     between declared Content-Type and the file's magic header. A client
//     that uploads `evil.html` as image/jpeg is caught here.
//   - H6: on serve, we send `Content-Disposition: attachment` and
//     `X-Content-Type-Options: nosniff` so the browser never renders the
//     file inline even if an ALLOWED_MIME upload later turns out to be
//     something the sniffer missed.
//   - H7: JPEG APPn/COM and PNG non-essential ancillary chunks are stripped
//     before the bytes land in R2 / D1. This drops EXIF, GPS, ICC profiles,
//     thumbnails, and comments — common leak vectors for a lab shot that
//     also captured a residence address.
//   - H1: POST /api/download-url issues a short-lived signed URL for one
//     specific GET path. The ACL check runs here; the signed URL carries
//     the resource binding into the signature, so a leaked URL buys an
//     attacker 120s on that one resource and nothing else.

import { json, bodyJson, now, httpError } from "../lib/http.js";
import { signDownloadUrl } from "../lib/crypto.js";
import { addAudit, loadSampleFull } from "../lib/db.js";
import { canReadSample, requireRole } from "../lib/perms.js";

const INLINE_LIMIT_BYTES = 300 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;      // 20 MB per file
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;    // 60 MB per request
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"
]);

// H6: magic-byte checker. Returns the normalized MIME we read from the file
// bytes, or null if the leading bytes don't match any supported type.
function sniffMime(head) {
  // JPEG: FF D8 FF
  if (head.length >= 3 && head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (head.length >= 8 &&
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47 &&
      head[4] === 0x0D && head[5] === 0x0A && head[6] === 0x1A && head[7] === 0x0A) return "image/png";
  // WEBP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
  if (head.length >= 12 &&
      head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return "image/webp";
  // PDF: 25 50 44 46 2D   ("%PDF-")
  if (head.length >= 5 &&
      head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2D) return "application/pdf";
  return null;
}

// H6: the declared type must agree with the sniff. image/jpg (common client
// quirk) is treated as image/jpeg.
function mimesAgree(declared, sniffed) {
  const d = declared === "image/jpg" ? "image/jpeg" : declared;
  return d === sniffed;
}

// H7: strip image metadata (EXIF/GPS/comments/etc.) before persisting.
// For JPEG, walk markers from byte 0 and drop APPn (0xFFE0..0xFFEF) and
// COM (0xFFFE) segments. For PNG, walk chunks after the 8-byte signature
// and keep only a tight whitelist of essential + harmless ancillary chunks.
// Other formats pass through — WEBP strip is not implemented here (its
// chunks are more involved); it reaches R2 as-is.
function stripImageMetadata(bytes, mime) {
  if (mime === "image/jpeg" || mime === "image/jpg") return stripJpegMetadata(bytes);
  if (mime === "image/png") return stripPngMetadata(bytes);
  return bytes;
}

function stripJpegMetadata(bytes) {
  // Expect SOI (FF D8). Walk markers until SOS (FF DA) or EOI (FF D9).
  // Each marker is FF XX; segments with length have a 2-byte big-endian
  // length word that INCLUDES those two length bytes. SOS begins the
  // scan data: copy from SOS onward verbatim.
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes;
  const out = [];
  out.push(0xFF, 0xD8);
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xFF) throw new Error("JPEG: expected marker");
    // Fill bytes between markers (rare in well-formed JPEGs; just skip)
    let m = bytes[i + 1];
    while (m === 0xFF && i + 2 < bytes.length) { i++; m = bytes[i + 1]; }
    i += 2;
    if (m === 0xD9) { // EOI
      out.push(0xFF, 0xD9);
      break;
    }
    if (m === 0xDA) { // SOS — copy length word + segment + all remaining bytes
      const len = (bytes[i] << 8) | bytes[i + 1];
      out.push(0xFF, 0xDA);
      for (let k = 0; k < len; k++) out.push(bytes[i + k]);
      i += len;
      // Entropy-coded data runs to EOI; copy verbatim.
      while (i < bytes.length) out.push(bytes[i++]);
      break;
    }
    // Standalone markers (no length): RST0..RST7, TEM. Just copy.
    if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) {
      out.push(0xFF, m);
      continue;
    }
    // Length-bearing marker.
    const len = (bytes[i] << 8) | bytes[i + 1];
    const isAppN = m >= 0xE0 && m <= 0xEF;
    const isCom = m === 0xFE;
    if (!isAppN && !isCom) {
      out.push(0xFF, m);
      for (let k = 0; k < len; k++) out.push(bytes[i + k]);
    }
    i += len;
  }
  return new Uint8Array(out);
}

const PNG_KEEP = new Set(["IHDR", "IDAT", "PLTE", "IEND", "tRNS", "pHYs", "gAMA", "cHRM", "sRGB"]);

function stripPngMetadata(bytes) {
  // Signature (8 bytes) + chunks: 4-byte big-endian length, 4-byte type,
  // <length> data bytes, 4-byte CRC. Keep only whitelisted chunk types.
  if (bytes.length < 8) return bytes;
  const out = [];
  for (let k = 0; k < 8; k++) out.push(bytes[k]);
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = (bytes[i] << 24 >>> 0) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    const chunkEnd = i + 8 + len + 4;
    if (chunkEnd > bytes.length) throw new Error("PNG: chunk length out of range");
    if (PNG_KEEP.has(type)) {
      for (let k = i; k < chunkEnd; k++) out.push(bytes[k]);
    }
    i = chunkEnd;
    if (type === "IEND") break;
  }
  return new Uint8Array(out);
}

// H1: ACL-check a path we're about to sign a short-lived URL for. The path
// must be a GET route that signatureBypassAllowed covers in the router.
// We load the parent sample and defer to canReadSample.
async function assertCanReadDownloadPath(env, user, path) {
  const parts = path.split("/").filter(Boolean);
  // /api/samples/:id/{qr.svg,tube-label,report,report.pdf,pdf}
  if (parts[0] === "api" && parts[1] === "samples" && parts[2] && parts[3] &&
      ["qr.svg", "tube-label", "report", "report.pdf", "pdf"].includes(parts[3])) {
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(parts[2]).first();
    if (!s || !canReadSample(user, s)) throw httpError("Not allowed to download this resource", 403);
    return;
  }
  // /api/files/:id — look up the file row, find its parent sample.
  if (parts[0] === "api" && parts[1] === "files" && parts[2]) {
    const f = await env.DB.prepare("SELECT sample_id FROM sample_files WHERE id = ?").bind(parts[2]).first();
    if (!f) throw httpError("File not found", 404);
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(f.sample_id).first();
    if (!s || !canReadSample(user, s)) throw httpError("Not allowed to download this resource", 403);
    return;
  }
  // /api/media/<key> — look up the file row by r2_key.
  if (parts[0] === "api" && parts[1] === "media" && parts.length >= 3) {
    const key = parts.slice(2).join("/");
    const f = await env.DB.prepare("SELECT sample_id FROM sample_files WHERE r2_key = ? LIMIT 1").bind(key).first();
    if (!f) throw httpError("Media not found", 404);
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(f.sample_id).first();
    if (!s || !canReadSample(user, s)) throw httpError("Not allowed to download this resource", 403);
    return;
  }
  throw httpError("Path cannot be signed", 400);
}

export async function tryFiles(request, env, ctx, { path, method, user }) {
  /* ---------- H1: POST /api/download-url — issue a short-lived signed URL ---------- */
  if (method === "POST" && path[0] === "api" && path[1] === "download-url" && path.length === 2) {
    const body = await bodyJson(request);
    const p = String(body.path || "");
    if (!p.startsWith("/api/")) throw httpError("Invalid path", 400);
    await assertCanReadDownloadPath(env, user, p);
    return json({ url: await signDownloadUrl(p, env, 120) });
  }

  /* ---------- Upload files ---------- */
  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "files" && !path[4]) {
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(path[2]).first();
    if (!s) throw httpError("Sample not found", 404);
    // Any admin or analyst in the lab may attach a sample photo — the small
    // team's workflow has colleagues snapping photos for each other
    // pre-collection. Every row carries uploaded_by, so attribution survives
    // the loose gate.
    if (user.role !== "admin" && user.role !== "analyst") {
      throw httpError("Not allowed to upload", 403);
    }
    const form = await request.formData();
    const category = String(form.get("category") || "Uploaded File");
    const lat = form.get("lat") ? String(form.get("lat")) : null;
    const lng = form.get("lng") ? String(form.get("lng")) : null;
    const takenAt = form.get("takenAt") ? String(form.get("takenAt")) : null;

    // Validate everything up front so a single bad file rejects the whole
    // upload — avoids half-written state and gives a clear error.
    let totalBytes = 0;
    for (const [, value] of form.entries()) {
      if (!(value instanceof File) || !value.size) continue;
      if (value.size > MAX_FILE_BYTES) {
        throw httpError(`"${value.name}" is ${Math.round(value.size / (1024 * 1024))} MB — per-file limit is 20 MB.`, 400);
      }
      totalBytes += value.size;
      const mime = String(value.type || "").toLowerCase();
      if (!ALLOWED_MIME.has(mime)) {
        throw httpError(`"${value.name}" has unsupported type "${value.type || "unknown"}". Allowed: JPEG, PNG, WEBP, PDF.`, 400);
      }
    }
    if (totalBytes > MAX_UPLOAD_BYTES) {
      throw httpError(`Upload totals ${Math.round(totalBytes / (1024 * 1024))} MB — per-request limit is 60 MB.`, 400);
    }

    const batch = [];
    for (const [, value] of form.entries()) {
      if (!(value instanceof File) || !value.size) continue;
      // H6: sniff the first 12 bytes before trusting the client-declared
      // MIME. A mismatch means the client is lying about the type — reject.
      const headBuf = await value.slice(0, 12).arrayBuffer();
      const head = new Uint8Array(headBuf);
      const sniffed = sniffMime(head);
      const declared = String(value.type || "").toLowerCase();
      if (!sniffed || !mimesAgree(declared, sniffed)) {
        throw httpError(`"${value.name}": File content doesn't match its declared type`, 400);
      }
      // H7: strip metadata before persisting. If stripping blows up on a
      // malformed file, we refuse — safer than storing untouched EXIF/GPS.
      let bytes = new Uint8Array(await value.arrayBuffer());
      try {
        bytes = stripImageMetadata(bytes, sniffed);
      } catch {
        throw httpError(`"${value.name}": Could not sanitize image`, 400);
      }

      const id = crypto.randomUUID();
      let dataUrl = null, r2Key = null;
      if (bytes.byteLength > INLINE_LIMIT_BYTES && env.MEDIA) {
        r2Key = `samples/${s.id}/${id}-${value.name.replaceAll("/", "_")}`;
        await env.MEDIA.put(r2Key, bytes, {
          httpMetadata: { contentType: value.type }
        });
      } else {
        let bin = "";
        bytes.forEach(b => bin += String.fromCharCode(b));
        dataUrl = `data:${value.type || "application/octet-stream"};base64,${btoa(bin)}`;
      }
      batch.push(env.DB.prepare(
        "INSERT INTO sample_files (id,sample_id,original_name,category,r2_key,data_url,size_bytes,mime_type,lat,lng,taken_at,uploaded_by,uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        id, s.id, value.name, category, r2Key, dataUrl,
        bytes.byteLength, value.type || null, lat, lng, takenAt,
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
    // Routes reached via signed URL have user=null; the signer already did
    // the ACL check, so skip it here.
    const fileRow = await env.DB.prepare("SELECT sample_id, original_name FROM sample_files WHERE r2_key = ? LIMIT 1").bind(key).first();
    if (!fileRow) throw httpError("Media not found", 404);
    if (user) {
      const parentSample = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(fileRow.sample_id).first();
      if (!parentSample) throw httpError("Media not found", 404);
      if (!canReadSample(user, parentSample)) throw httpError("Not allowed to read this file", 403);
    }

    const obj = await env.MEDIA.get(key);
    if (!obj) throw httpError("Media not found", 404);
    // H6: attachment disposition + nosniff — browsers never render the file
    // inline, even if the stored content-type is wrong.
    const safeName = (fileRow.original_name || "download").replaceAll('"', "");
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
        "cache-control": "private, max-age=3600",
        "content-disposition": `attachment; filename="${safeName}"`,
        "x-content-type-options": "nosniff"
      }
    });
  }

  /* ---------- GET /api/files/:id — single file by id (ACL-checked) ---------- */
  if (method === "GET" && path[0] === "api" && path[1] === "files" && path[2]) {
    const file = await env.DB.prepare("SELECT * FROM sample_files WHERE id = ?").bind(path[2]).first();
    if (!file) throw httpError("File not found", 404);
    if (user) {
      const parent = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(file.sample_id).first();
      if (!parent || !canReadSample(user, parent)) throw httpError("Not allowed to read this file", 403);
    }
    let body, contentType;
    if (file.r2_key && env.MEDIA) {
      const obj = await env.MEDIA.get(file.r2_key);
      if (!obj) throw httpError("File not found", 404);
      body = obj.body;
      contentType = obj.httpMetadata?.contentType || file.mime_type || "application/octet-stream";
    } else if (file.data_url) {
      // Legacy inline file. Parse "data:<mime>;base64,<payload>".
      const m = /^data:([^;]+);base64,(.*)$/.exec(file.data_url);
      if (!m) throw httpError("File not found", 404);
      contentType = m[1];
      body = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
    } else {
      throw httpError("File not found", 404);
    }
    const safeName = (file.original_name || "download").replaceAll('"', "");
    return new Response(body, {
      headers: {
        "content-type": contentType,
        "cache-control": "private, max-age=3600",
        "content-disposition": `attachment; filename="${safeName}"`,
        "x-content-type-options": "nosniff"
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
