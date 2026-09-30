#!/usr/bin/env node
/**
 * One-time migration: read the single-JSON-blob from Neon Postgres and emit
 * a stream of D1 SQL statements to populate the normalized schema.
 *
 * Usage:
 *   DATABASE_URL="postgres://..." node migrate-neon-to-d1.mjs > seed.sql
 *   wrangler d1 execute plasma-lab-lims --remote --file=./seed.sql
 *
 * DATABASE_URL is your Neon connection string (Cloudflare secret NEON_URL,
 * or the copy in your Worker's env). If you don't have it locally, run
 *   wrangler secret list
 * on the current Worker and copy DATABASE_URL from your Cloudflare dashboard.
 *
 * This script only READS from Neon. It never writes back or deletes.
 */
import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Set DATABASE_URL to your Neon connection string, then re-run.");
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const rows = await sql`select data from lims_store where id = 'primary'`;
if (!rows[0]?.data) {
  console.error("No lims_store.primary row found in Neon.");
  process.exit(1);
}
const db = rows[0].data;

// -- Helpers --------------------------------------------------------------

const q = (v) => {
  if (v == null) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replaceAll("'", "''")}'`;
};
const b = (v) => (v ? 1 : 0);
const j = (v) => (v == null ? "NULL" : q(JSON.stringify(v)));
const uuid = () => globalThis.crypto?.randomUUID?.() || require("crypto").randomUUID();

const stmts = [];
const emit = (s) => stmts.push(s);

emit("-- Migration seed generated " + new Date().toISOString());
emit("PRAGMA foreign_keys = OFF;");
emit("BEGIN TRANSACTION;");

// -- Users --------------------------------------------------------------
for (const u of db.users || []) {
  emit(`INSERT OR IGNORE INTO users (id,name,email,phone,country_code,password_hash,role,active,approval_status,signed_up_at,approved_at,approved_by,rejected_at,rejected_by,rejection_reason,session_version,last_login_at,replaced_at,replaced_by_email,deleted_at,deleted_by,created_at) VALUES (${q(u.id)},${q(u.name)},${q(u.email)},${q(u.phone||"")},${q(u.countryCode||"")},${q(u.passwordHash)},${q(u.role)},${b(u.active)},${q(u.approvalStatus || (u.active?"approved":"deactivated"))},${q(u.signedUpAt)},${q(u.approvedAt)},${q(u.approvedBy)},${q(u.rejectedAt)},${q(u.rejectedBy)},${q(u.rejectionReason)},${Number(u.sessionVersion)||0},${q(u.lastLoginAt)},${q(u.replacedAt)},${q(u.replacedByEmail)},${q(u.deletedAt)},${q(u.deletedBy)},${q(u.createdAt || new Date().toISOString())});`);
}

// -- Pending signups --------------------------------------------------------
for (const p of db.pendingSignups || []) {
  emit(`INSERT OR IGNORE INTO pending_signups (id,name,email,email_otp,email_verified,country_code,phone,expires_at,created_at) VALUES (${q(p.id)},${q(p.name)},${q(p.email)},${q(p.emailOtp)},${b(p.emailVerified)},${q(p.countryCode)},${q(p.phone)},${q(p.expiresAt)},${q(p.createdAt || new Date().toISOString())});`);
}

// -- Password resets --------------------------------------------------------
for (const r of db.passwordResets || []) {
  emit(`INSERT OR IGNORE INTO password_resets (id,user_id,email_otp,expires_at,created_at) VALUES (${q(r.id)},${q(r.userId)},${q(r.emailOtp)},${q(r.expiresAt)},${q(r.createdAt || new Date().toISOString())});`);
}

// -- People --------------------------------------------------------
for (const p of db.people || []) {
  emit(`INSERT OR IGNORE INTO people (id,name,role,active,created_at) VALUES (${q(p.id)},${q(p.name)},${q(p.role)},${b(p.active !== false)},${q(p.createdAt || new Date().toISOString())});`);
}

// -- Storage locations --------------------------------------------------------
for (const s of db.storageLocations || []) {
  emit(`INSERT OR IGNORE INTO storage_locations (id,name,type,active,is_full,capacity_note) VALUES (${q(s.id)},${q(s.name)},${q(s.type || "Storage")},${b(s.active !== false)},${b(s.isFull)},${q(s.capacityNote||"")});`);
}

// -- Tests --------------------------------------------------------
for (const t of db.tests || []) {
  emit(`INSERT OR IGNORE INTO tests (id,name,unit,"limit",method) VALUES (${q(t.id)},${q(t.name)},${q(t.unit||"")},${q(t.limit||"")},${q(t.method||"")});`);
}

// -- Samples + children --------------------------------------------------------
for (const s of db.samples || []) {
  emit(`INSERT OR IGNORE INTO samples (id,sample_code,status,workflow_stage,client_name,source_type,collection_site,collector,received_by,received_at,storage_location_id,assigned_to,requested_tests,notes,planned_sampling_date,collected_at,collection_lat,collection_lng,due_at,retention_status,disposal_json,reviewed_by,reviewed_at,archived_at,archived_by,archive_batch_id,active,created_at,updated_at) VALUES (${q(s.id)},${q(s.sampleCode)},${q(s.status||"Bottle Ready")},${q(s.workflowStage||s.status||"Bottle Ready")},${q(s.clientName||"")},${q(s.sourceType||"")},${q(s.collectionSite||"")},${q(s.collector||"")},${q(s.receivedBy||"")},${q(s.receivedAt)},${q(s.storageLocationId||null)},${q(s.assignedTo||"")},${j(s.requestedTests||[])},${q(s.notes||"")},${q(s.plannedSamplingDate||"")},${q(s.collectedAt)},${q(s.collectionLat)},${q(s.collectionLng)},${q(s.dueAt)},${q(s.retentionStatus||"Active")},${j(s.disposal)},${q(s.reviewedBy)},${q(s.reviewedAt)},${q(s.archivedAt)},${q(s.archivedBy)},${q(s.archiveBatchId)},${b(s.active !== false)},${q(s.createdAt || new Date().toISOString())},${q(s.updatedAt || s.createdAt || new Date().toISOString())});`);

  // Results
  for (const r of s.results || []) {
    emit(`INSERT OR IGNORE INTO sample_results (id,sample_id,parameter,value,unit,"limit",method,flag,analyst,replicates,avg,stddev,msg,entered_at) VALUES (${q(r.id || uuid())},${q(s.id)},${q(r.parameter)},${q(r.value||"")},${q(r.unit||"")},${q(r.limit||"")},${q(r.method||"")},${q(r.flag||"OK")},${q(r.analyst||"")},${j(r.replicates)},${r.avg==null?"NULL":Number(r.avg)},${r.stddev==null?"NULL":Number(r.stddev)},${q(r.msg||null)},${q(r.enteredAt || new Date().toISOString())});`);
  }

  // Files (base64 URLs preserved as data_url; Phase 3 will move to R2)
  for (const f of s.files || []) {
    emit(`INSERT OR IGNORE INTO sample_files (id,sample_id,original_name,category,r2_key,data_url,size_bytes,mime_type,lat,lng,taken_at,uploaded_by,uploaded_at) VALUES (${q(f.id || uuid())},${q(s.id)},${q(f.originalName||"")},${q(f.category||"Uploaded File")},NULL,${q(f.url||null)},${Number(f.size)||0},${q(f.mimeType||null)},${q(f.lat||null)},${q(f.lng||null)},${q(f.takenAt||null)},${q(f.uploadedBy||"")},${q(f.uploadedAt || new Date().toISOString())});`);
  }

  // Chain of custody
  for (const c of s.chainOfCustody || []) {
    emit(`INSERT OR IGNORE INTO chain_of_custody (id,sample_id,at,by_name,action,from_location_id,to_location_id,location_id,note) VALUES (${q(uuid())},${q(s.id)},${q(c.at || new Date().toISOString())},${q(c.by||"")},${q(c.action||"")},${q(c.fromLocationId||null)},${q(c.toLocationId||null)},${q(c.locationId||null)},${q(c.note||"")});`);
  }
}

// -- Audit log --------------------------------------------------------
for (const a of db.audit || []) {
  emit(`INSERT OR IGNORE INTO audit_log (id,at,user_id,user_name,action,entity,entity_id,detail) VALUES (${q(a.id || uuid())},${q(a.at || new Date().toISOString())},${q(a.userId||"system")},${q(a.userName||"System")},${q(a.action)},${q(a.entity)},${q(a.entityId)},${q(a.detail||"")});`);
}

// -- Meta --------------------------------------------------------
emit(`INSERT OR REPLACE INTO meta (key,value,updated_at) VALUES ('migrated_from_neon_at', ${q(new Date().toISOString())}, ${q(new Date().toISOString())});`);
emit(`INSERT OR REPLACE INTO meta (key,value,updated_at) VALUES ('source_sample_count', ${q(String((db.samples||[]).length))}, ${q(new Date().toISOString())});`);
emit(`INSERT OR REPLACE INTO meta (key,value,updated_at) VALUES ('source_user_count', ${q(String((db.users||[]).length))}, ${q(new Date().toISOString())});`);

emit("COMMIT;");
emit("PRAGMA foreign_keys = ON;");
emit(`-- Migration complete. Rows: users=${(db.users||[]).length}, samples=${(db.samples||[]).length}, results=${(db.samples||[]).reduce((n,s)=>n+(s.results||[]).length,0)}, files=${(db.samples||[]).reduce((n,s)=>n+(s.files||[]).length,0)}, audit=${(db.audit||[]).length}`);

process.stdout.write(stmts.join("\n") + "\n");
