#!/usr/bin/env node
/**
 * Phase 3 migration — move inline data_url photos from D1 to R2.
 *
 * Reads `sample_files` rows where `data_url IS NOT NULL AND r2_key IS NULL`,
 * uploads the bytes to R2 under `samples/<sampleId>/<fileId>.<ext>`,
 * then sets `r2_key = <key>, data_url = NULL` on the row.
 *
 * This script uses the Cloudflare REST API (D1 query + R2 PUT) directly, so
 * you only need an API token with D1 + R2 edit permissions. No wrangler
 * wrapper needed; run from any machine with internet.
 *
 * Usage:
 *   CF_ACCOUNT_ID=... CF_API_TOKEN=... D1_DB_ID=... R2_BUCKET=plasma-lab-lims-media \
 *     node migrate-data-urls-to-r2.mjs [--dry-run] [--limit 50]
 *
 * Where:
 *   CF_ACCOUNT_ID  Cloudflare account id (dashboard > top-right id)
 *   CF_API_TOKEN   API token with D1:Edit + R2:Edit on that account
 *   D1_DB_ID       uuid of plasma-lab-lims database (wrangler.jsonc > d1_databases[].database_id)
 *   R2_BUCKET      bucket name (default: plasma-lab-lims-media)
 *
 * Flags:
 *   --dry-run     list what would move, no writes
 *   --limit N     process at most N rows (default: all)
 */

const CF = {
  account: process.env.CF_ACCOUNT_ID,
  token: process.env.CF_API_TOKEN,
  dbId: process.env.D1_DB_ID,
  bucket: process.env.R2_BUCKET || "plasma-lab-lims-media",
};
if (!CF.account || !CF.token || !CF.dbId) {
  console.error("Missing env: CF_ACCOUNT_ID, CF_API_TOKEN, D1_DB_ID required.");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 ? parseInt(args[i + 1], 10) : Infinity;
})();

const H = {
  Authorization: `Bearer ${CF.token}`,
  "Content-Type": "application/json",
};

async function d1(sql, params = []) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF.account}/d1/database/${CF.dbId}/query`,
    { method: "POST", headers: H, body: JSON.stringify({ sql, params }) }
  );
  const j = await r.json();
  if (!j.success) throw new Error("D1: " + JSON.stringify(j.errors));
  return j.result[0];
}
async function r2Put(key, bytes, contentType) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF.account}/r2/buckets/${CF.bucket}/objects/${encodeURIComponent(key)}`,
    { method: "PUT", headers: { Authorization: `Bearer ${CF.token}`, "Content-Type": contentType || "application/octet-stream" }, body: bytes }
  );
  if (!r.ok) throw new Error("R2 PUT " + r.status + " " + (await r.text()));
}

function dataUrlToBytes(url) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (!m) return null;
  return { contentType: m[1], bytes: Buffer.from(m[2], "base64") };
}

function extFromMime(mime = "") {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("pdf")) return "pdf";
  return "bin";
}

async function main() {
  console.error(`${DRY ? "[dry-run] " : ""}Scanning sample_files…`);
  const rows = (await d1("SELECT id, sample_id, original_name, mime_type, LENGTH(data_url) AS size_b64 FROM sample_files WHERE data_url IS NOT NULL AND (r2_key IS NULL OR r2_key = '') ORDER BY uploaded_at DESC")).results;
  console.error(`Found ${rows.length} rows to migrate${rows.length ? ":" : "."}`);
  const todo = rows.slice(0, Math.min(rows.length, LIMIT));
  let ok = 0, fail = 0;
  for (const r of todo) {
    try {
      const full = (await d1("SELECT data_url, mime_type FROM sample_files WHERE id = ?", [r.id])).results[0];
      if (!full?.data_url) { console.error(`  [skip ${r.id}] no data_url`); continue; }
      const parsed = dataUrlToBytes(full.data_url);
      if (!parsed) { console.error(`  [skip ${r.id}] data_url not base64`); continue; }
      const contentType = r.mime_type || parsed.contentType;
      const key = `samples/${r.sample_id}/${r.id}.${extFromMime(contentType)}`;
      console.error(`  ${DRY ? "[dry] " : ""}${r.id} → R2 key ${key} (${Math.round(parsed.bytes.length / 1024)} KB${r.original_name ? ", " + r.original_name : ""})`);
      if (!DRY) {
        await r2Put(key, parsed.bytes, contentType);
        await d1("UPDATE sample_files SET r2_key = ?, data_url = NULL, mime_type = COALESCE(mime_type, ?) WHERE id = ?", [key, contentType, r.id]);
      }
      ok++;
    } catch (e) {
      fail++;
      console.error(`  [FAIL ${r.id}] ${e.message}`);
    }
  }
  console.error(`Done. ${ok} migrated, ${fail} failed, ${rows.length - todo.length} not touched (limit).`);
  if (DRY) console.error("Dry-run only. Re-run without --dry-run to apply.");
}

main().catch(e => { console.error(e); process.exit(1); });
