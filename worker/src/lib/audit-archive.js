// Audit-log monthly archive rotator.
//
// Called by the scheduled handler once a month. Walks every calendar month
// older than AUDIT_RETENTION_DAYS (default 90) that has not yet been
// archived, copies those rows to R2 as NDJSON with a SHA-256 companion, and
// records the batch in audit_archive_batches. Phase 2 (env.AUDIT_PRUNE_D1 =
// "true") then deletes the matching D1 rows in the same batch as the archive
// row's write — never the other way around.
//
// Invariants:
//   - R2 object is uploaded and confirmed before any D1 write.
//   - D1 DELETE only runs after the audit_archive_batches row for that month
//     is in the batch, so a crash between upload and delete leaves the
//     archive discoverable.
//   - chain_of_custody is NEVER rotated by this function — it is per-sample
//     operational data and stays in D1 for the sample's life.

import { now } from "./http.js";

const DEFAULT_RETENTION_DAYS = 90;

function retentionDays(env) {
  const n = Number(env.AUDIT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
}

function pruneEnabled(env) {
  return String(env.AUDIT_PRUNE_D1 || "").toLowerCase() === "true";
}

function yearMonthOf(iso) {
  // "2026-07-14T..." -> "2026-07"
  return String(iso || "").slice(0, 7);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Serialize rows to NDJSON (one JSON object per line). NDJSON streams well
// and is friendly to grep / jq / line-by-line replay.
function rowsToNdjson(rows) {
  const enc = new TextEncoder();
  const lines = rows.map(r => JSON.stringify(r) + "\n").join("");
  return enc.encode(lines);
}

export async function rotateAuditLog(env, { actorName = "system cron" } = {}) {
  if (!env.DB) throw new Error("rotateAuditLog: env.DB missing");
  if (!env.MEDIA) {
    // R2 is required for archive. If the deploy forgot it, skip quietly and
    // leave D1 intact. Admin sees nothing archived and can investigate.
    console.warn("[audit-archive] env.MEDIA (R2) not bound — skipping rotation");
    return { skipped: "no_media_binding" };
  }

  const cutoffMs = Date.now() - retentionDays(env) * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs).toISOString();
  const cutoffMonth = yearMonthOf(cutoff);

  // Find the oldest row still in audit_log, under the cutoff.
  const oldestRow = await env.DB.prepare(
    "SELECT at FROM audit_log WHERE at < ? ORDER BY at ASC LIMIT 1"
  ).bind(cutoff).first();
  if (!oldestRow) return { months: 0, archived: 0, bytes: 0 };

  // Months already recorded (so we never archive the same month twice).
  const existingRows = (await env.DB.prepare(
    "SELECT year_month FROM audit_archive_batches"
  ).all()).results || [];
  const existing = new Set(existingRows.map(r => r.year_month));

  // Walk months from the oldest row up to (but not including) the cutoff
  // month — the cutoff month is still "operational".
  const summaries = [];
  let cursor = new Date(oldestRow.at + "Z").toISOString().slice(0, 7); // YYYY-MM
  while (cursor < cutoffMonth) {
    if (!existing.has(cursor)) {
      const summary = await archiveMonth(env, cursor, actorName);
      if (summary) summaries.push(summary);
    }
    cursor = nextYearMonth(cursor);
  }

  const totals = summaries.reduce(
    (acc, s) => ({ archived: acc.archived + s.rowCount, bytes: acc.bytes + s.byteSize }),
    { archived: 0, bytes: 0 }
  );
  return { months: summaries.length, ...totals, retentionDays: retentionDays(env), pruned: pruneEnabled(env) };
}

async function archiveMonth(env, yearMonth, actorName) {
  const monthStart = `${yearMonth}-01T00:00:00.000Z`;
  const next = nextYearMonth(yearMonth);
  const monthEnd = `${next}-01T00:00:00.000Z`;

  // Read every audit row for this month in deterministic order so the file
  // bytes (and hash) are reproducible.
  const rows = (await env.DB.prepare(
    "SELECT id, at, user_id, user_name, action, entity, entity_id, detail FROM audit_log WHERE at >= ? AND at < ? ORDER BY at ASC, id ASC"
  ).bind(monthStart, monthEnd).all()).results || [];

  if (rows.length === 0) return null; // no rows this month, nothing to do

  const bytes = rowsToNdjson(rows);
  const sha256 = await sha256Hex(bytes);
  const r2Key = `audit/${yearMonth}.ndjson`;

  // 1. Upload to R2 first. If this throws, nothing is written to D1 or
  //    removed from it — safe.
  await env.MEDIA.put(r2Key, bytes, {
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { sha256, rowCount: String(rows.length), fromAt: rows[0].at, toAt: rows[rows.length - 1].at }
  });

  // 2. Build the atomic batch: record the archive, and (phase 2 only) prune
  //    the archived rows from D1 — in one call so a crash cannot land us in
  //    the "pruned but no record" state.
  const archiveId = crypto.randomUUID();
  const stmts = [
    env.DB.prepare(
      "INSERT INTO audit_archive_batches (id, year_month, r2_key, sha256, row_count, from_at, to_at, byte_size, pruned_from_d1, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      archiveId, yearMonth, r2Key, sha256, rows.length,
      rows[0].at, rows[rows.length - 1].at, bytes.byteLength,
      pruneEnabled(env) ? 1 : 0, now(), actorName
    )
  ];
  if (pruneEnabled(env)) {
    stmts.push(env.DB.prepare(
      "DELETE FROM audit_log WHERE at >= ? AND at < ?"
    ).bind(monthStart, monthEnd));
  }
  await env.DB.batch(stmts);

  return {
    yearMonth, r2Key, sha256,
    rowCount: rows.length, byteSize: bytes.byteLength,
    pruned: pruneEnabled(env)
  };
}

function nextYearMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}
