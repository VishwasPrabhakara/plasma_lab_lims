-- Plasma Lab LIMS — D1 initial schema
-- Normalized from the single-JSON-blob model. One table per entity so writes
-- touch one row at a time and reads paginate cheaply. Foreign keys keep the
-- graph consistent; every child row cascades when its parent sample is
-- archived or deleted.

-- ---------------------------------------------------------------------------
-- People, users, auth
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL,                -- not unique because of replacedAt history
  phone             TEXT DEFAULT '',
  country_code      TEXT DEFAULT '',
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL,                -- admin | analyst
  active            INTEGER NOT NULL DEFAULT 0,   -- 0/1 (SQLite has no bool)
  approval_status   TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | deactivated
  signed_up_at      TEXT,
  approved_at       TEXT,
  approved_by       TEXT,
  rejected_at       TEXT,
  rejected_by       TEXT,
  rejection_reason  TEXT,
  session_version   INTEGER NOT NULL DEFAULT 0,
  last_login_at     TEXT,
  replaced_at       TEXT,                         -- when a newer signup superseded this record
  replaced_by_email TEXT,
  deleted_at        TEXT,
  deleted_by        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status   ON users(approval_status, active);
CREATE INDEX IF NOT EXISTS idx_users_role     ON users(role, active);

CREATE TABLE IF NOT EXISTS pending_signups (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  email_otp      TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  country_code   TEXT,
  phone          TEXT,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_email ON pending_signups(email);

CREATE TABLE IF NOT EXISTS password_resets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_otp  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_resets(user_id);

CREATE TABLE IF NOT EXISTS people (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS storage_locations (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT DEFAULT 'Storage',
  active         INTEGER NOT NULL DEFAULT 1,
  is_full        INTEGER NOT NULL DEFAULT 0,
  capacity_note  TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tests (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  unit   TEXT DEFAULT '',
  "limit" TEXT DEFAULT '',
  method TEXT DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- Samples: the core entity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS samples (
  id                    TEXT PRIMARY KEY,
  sample_code           TEXT NOT NULL UNIQUE,
  status                TEXT NOT NULL DEFAULT 'Bottle Ready',
  workflow_stage        TEXT NOT NULL DEFAULT 'Bottle Ready',
  client_name           TEXT DEFAULT '',
  source_type           TEXT DEFAULT '',
  collection_site       TEXT DEFAULT '',
  collector             TEXT DEFAULT '',
  received_by           TEXT DEFAULT '',
  received_at           TEXT,
  storage_location_id   TEXT REFERENCES storage_locations(id) ON DELETE SET NULL,
  assigned_to           TEXT DEFAULT '',
  requested_tests       TEXT DEFAULT '[]',        -- JSON array
  notes                 TEXT DEFAULT '',
  planned_sampling_date TEXT DEFAULT '',
  collected_at          TEXT,
  collection_lat        TEXT,
  collection_lng        TEXT,
  due_at                TEXT,
  retention_status      TEXT DEFAULT 'Active',
  disposal_json         TEXT,                     -- JSON: {disposedAt, disposedBy, reason}
  reviewed_by           TEXT,
  reviewed_at           TEXT,
  archived_at           TEXT,                     -- non-null = archived (kept for audit)
  archived_by           TEXT,
  archive_batch_id      TEXT,
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_status         ON samples(status);
CREATE INDEX IF NOT EXISTS idx_samples_assigned       ON samples(assigned_to);
CREATE INDEX IF NOT EXISTS idx_samples_storage        ON samples(storage_location_id);
CREATE INDEX IF NOT EXISTS idx_samples_collector      ON samples(collector);
CREATE INDEX IF NOT EXISTS idx_samples_client         ON samples(client_name);
CREATE INDEX IF NOT EXISTS idx_samples_created_at     ON samples(created_at);
CREATE INDEX IF NOT EXISTS idx_samples_archived       ON samples(archived_at);
CREATE INDEX IF NOT EXISTS idx_samples_retention      ON samples(retention_status);

-- ---------------------------------------------------------------------------
-- Sample children: results, files, custody
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sample_results (
  id           TEXT PRIMARY KEY,
  sample_id    TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  parameter    TEXT NOT NULL,
  value        TEXT DEFAULT '',
  unit         TEXT DEFAULT '',
  "limit"      TEXT DEFAULT '',
  method       TEXT DEFAULT '',
  flag         TEXT DEFAULT 'OK',
  analyst      TEXT DEFAULT '',
  replicates   TEXT,                 -- JSON: [{value, analyst}]
  avg          REAL,
  stddev       REAL,
  msg          TEXT,
  entered_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_sample ON sample_results(sample_id, entered_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_param  ON sample_results(parameter);
CREATE INDEX IF NOT EXISTS idx_results_analyst ON sample_results(analyst);

CREATE TABLE IF NOT EXISTS sample_files (
  id             TEXT PRIMARY KEY,
  sample_id      TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  original_name  TEXT DEFAULT '',
  category       TEXT DEFAULT 'Uploaded File',
  r2_key         TEXT,                -- object key in R2 bucket (phase 3)
  data_url       TEXT,                -- fallback: base64 for tiny files during migration window
  size_bytes     INTEGER DEFAULT 0,
  mime_type      TEXT,
  lat            TEXT,
  lng            TEXT,
  taken_at       TEXT,
  uploaded_by    TEXT DEFAULT '',
  uploaded_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_sample   ON sample_files(sample_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_category ON sample_files(category);

CREATE TABLE IF NOT EXISTS chain_of_custody (
  id                TEXT PRIMARY KEY,
  sample_id         TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  at                TEXT NOT NULL,
  by_name           TEXT DEFAULT '',
  action            TEXT NOT NULL,
  from_location_id  TEXT,
  to_location_id    TEXT,
  location_id       TEXT,
  note              TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_custody_sample ON chain_of_custody(sample_id, at DESC);

-- ---------------------------------------------------------------------------
-- Global audit log (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  user_id    TEXT DEFAULT 'system',
  user_name  TEXT DEFAULT 'System',
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at    ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user  ON audit_log(user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

-- ---------------------------------------------------------------------------
-- Archive tracking: each archive batch = one downloadable bundle. Rows in
-- samples with archive_batch_id set have been included in that bundle.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS archive_batches (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  cutoff_date     TEXT NOT NULL,       -- samples with disposed_at older than this were archived
  sample_count    INTEGER NOT NULL DEFAULT 0,
  result_count    INTEGER NOT NULL DEFAULT 0,
  file_count      INTEGER NOT NULL DEFAULT 0,
  bundle_r2_key   TEXT,                -- R2 key for the downloadable JSON+CSV bundle
  bundle_size     INTEGER,
  purged_at       TEXT,                -- when the archived rows were actually deleted from D1
  purged_by       TEXT,
  notes           TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_archive_created ON archive_batches(created_at DESC);

-- ---------------------------------------------------------------------------
-- Meta / migration bookkeeping
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
