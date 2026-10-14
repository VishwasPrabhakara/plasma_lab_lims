-- Migration 0002: audit log monthly archive registry.
--
-- The monthly cron (worker/src/lib/audit-archive.js) copies audit_log rows
-- older than AUDIT_RETENTION_DAYS (default 90) into one R2 object per
-- calendar month at key `audit/YYYY-MM.ndjson`, computes a SHA-256 of the
-- bytes, and records the batch here. This table is the index for finding
-- the archive files later, and it is also the tamper-evidence anchor —
-- re-hash the R2 object and compare to `sha256` here.
--
-- Nothing in this table is edited after insert. There is no DELETE route.
--
-- `pruned_from_d1` is 0 while audit_log still holds the original rows (the
-- archive is pure backup). When AUDIT_PRUNE_D1 is turned on and the rotator
-- deletes the matching D1 rows, this flips to 1 in the same atomic batch.

CREATE TABLE IF NOT EXISTS audit_archive_batches (
  id              TEXT PRIMARY KEY,
  year_month      TEXT NOT NULL UNIQUE,   -- e.g. "2026-07"
  r2_key          TEXT NOT NULL,          -- e.g. "audit/2026-07.ndjson"
  sha256          TEXT NOT NULL,
  row_count       INTEGER NOT NULL,
  from_at         TEXT NOT NULL,
  to_at           TEXT NOT NULL,
  byte_size       INTEGER NOT NULL,
  pruned_from_d1  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL           -- "system cron" or admin name on manual rotations
);

CREATE INDEX IF NOT EXISTS idx_audit_archive_batches_year_month
  ON audit_archive_batches (year_month);
