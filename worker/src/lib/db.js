// Database adapters: D1 row → frontend shape, plus the two "load N samples
// with children" helpers that scale without N+1 queries.
//
// All functions in this file are pure in the sense that they do not throw
// their own HTTP errors — the caller does. They raise regular Error()s on
// corrupted state (missing row, bad JSON) which the top-level fetch handler
// catches and turns into 500.

import { now } from "./http.js";

export const parseJson = (s, fallback) => {
  try { return JSON.parse(s); } catch { return fallback; }
};

export function rowToPublicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone || "",
    countryCode: u.country_code || "",
    role: u.role,
    active: Boolean(u.active),
    approvalStatus: u.approval_status || (u.active ? "approved" : "deactivated"),
    signedUpAt: u.signed_up_at || null,
    approvedAt: u.approved_at || null,
    approvedBy: u.approved_by || null,
    rejectedAt: u.rejected_at || null,
    rejectedBy: u.rejected_by || null,
    rejectionReason: u.rejection_reason || null,
    createdAt: u.created_at
  };
}

export function rowToResult(r) {
  return {
    id: r.id,
    parameter: r.parameter,
    value: r.value || "",
    unit: r.unit || "",
    limit: r.limit || "",
    method: r.method || "",
    flag: r.flag || "OK",
    analyst: r.analyst || "",
    replicates: parseJson(r.replicates, null),
    avg: r.avg,
    stddev: r.stddev,
    msg: r.msg,
    enteredAt: r.entered_at
  };
}

export function rowToFile(f) {
  return {
    id: f.id,
    originalName: f.original_name || "",
    category: f.category || "Uploaded File",
    url: f.data_url || (f.r2_key ? `/api/media/${f.r2_key}` : ""),
    size: f.size_bytes || 0,
    mimeType: f.mime_type,
    lat: f.lat,
    lng: f.lng,
    takenAt: f.taken_at,
    uploadedBy: f.uploaded_by || "",
    uploadedAt: f.uploaded_at
  };
}

export function rowToCustody(c) {
  return {
    at: c.at,
    by: c.by_name || "",
    action: c.action,
    fromLocationId: c.from_location_id,
    toLocationId: c.to_location_id,
    locationId: c.location_id,
    note: c.note || ""
  };
}

export function rowToSample(s, { results = [], files = [], custody = [] } = {}) {
  return {
    id: s.id,
    sampleCode: s.sample_code,
    status: s.status,
    workflowStage: s.workflow_stage,
    clientName: s.client_name || "",
    sourceType: s.source_type || "",
    collectionSite: s.collection_site || "",
    collector: s.collector || "",
    receivedBy: s.received_by || "",
    receivedAt: s.received_at,
    storageLocationId: s.storage_location_id || "",
    assignedTo: s.assigned_to || "",
    requestedTests: parseJson(s.requested_tests, []),
    notes: s.notes || "",
    plannedSamplingDate: s.planned_sampling_date || "",
    collectedAt: s.collected_at,
    collectionLat: s.collection_lat,
    collectionLng: s.collection_lng,
    dueAt: s.due_at,
    retentionStatus: s.retention_status || "Active",
    disposal: parseJson(s.disposal_json, null),
    reviewedBy: s.reviewed_by,
    reviewedAt: s.reviewed_at,
    archivedAt: s.archived_at,
    active: Boolean(s.active),
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    results: results.map(rowToResult),
    files: files.map(rowToFile),
    chainOfCustody: custody.map(rowToCustody)
  };
}

// Load one sample + its three child collections in parallel.
export async function loadSampleFull(env, sampleId) {
  const sRow = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(sampleId).first();
  if (!sRow) return null;
  const [results, files, custody] = await Promise.all([
    env.DB.prepare("SELECT * FROM sample_results WHERE sample_id = ? ORDER BY entered_at DESC").bind(sampleId).all(),
    env.DB.prepare("SELECT * FROM sample_files WHERE sample_id = ? ORDER BY uploaded_at DESC").bind(sampleId).all(),
    env.DB.prepare("SELECT * FROM chain_of_custody WHERE sample_id = ? ORDER BY at DESC").bind(sampleId).all()
  ]);
  return rowToSample(sRow, {
    results: results.results || [],
    files: files.results || [],
    custody: custody.results || []
  });
}

// Load many samples + hydrate children in 4 queries total. Used by the
// bootstrap endpoint and anywhere the whole list is needed.
export async function loadSamplesFull(env, { whereSql = "", whereArgs = [], limit = 500 } = {}) {
  const sampleQuery = `SELECT * FROM samples ${whereSql ? "WHERE " + whereSql : ""} ORDER BY created_at DESC LIMIT ${Number(limit) || 500}`;
  const sStmt = env.DB.prepare(sampleQuery);
  const sRows = (await (whereArgs.length ? sStmt.bind(...whereArgs) : sStmt).all()).results || [];
  if (sRows.length === 0) return [];

  const ids = sRows.map(r => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const [results, files, custody] = await Promise.all([
    env.DB.prepare(`SELECT * FROM sample_results WHERE sample_id IN (${placeholders}) ORDER BY entered_at DESC`).bind(...ids).all(),
    env.DB.prepare(`SELECT * FROM sample_files WHERE sample_id IN (${placeholders}) ORDER BY uploaded_at DESC`).bind(...ids).all(),
    env.DB.prepare(`SELECT * FROM chain_of_custody WHERE sample_id IN (${placeholders}) ORDER BY at DESC`).bind(...ids).all()
  ]);

  const resultsById = {}, filesById = {}, custodyById = {};
  for (const r of (results.results || [])) (resultsById[r.sample_id] ||= []).push(r);
  for (const f of (files.results || [])) (filesById[f.sample_id] ||= []).push(f);
  for (const c of (custody.results || [])) (custodyById[c.sample_id] ||= []).push(c);

  return sRows.map(s => rowToSample(s, {
    results: resultsById[s.id] || [],
    files: filesById[s.id] || [],
    custody: custodyById[s.id] || []
  }));
}

export async function addAudit(env, user, action, entity, entityId, detail) {
  await env.DB.prepare(
    "INSERT INTO audit_log (id,at,user_id,user_name,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(
    crypto.randomUUID(), now(),
    user?.id || "system", user?.name || "System",
    action, entity, entityId || null, detail || null
  ).run();
}

export async function nextSampleCode(env) {
  const year = new Date().getFullYear();
  const row = await env.DB.prepare(
    "SELECT sample_code FROM samples WHERE sample_code LIKE ? ORDER BY sample_code DESC LIMIT 1"
  ).bind(`PL-${year}-%`).first();
  let next = 1;
  if (row?.sample_code) {
    const parsed = Number(row.sample_code.split("-").pop());
    if (parsed) next = parsed + 1;
  }
  return `PL-${year}-${String(next).padStart(6, "0")}`;
}

export async function storageIsAvailable(env, id, currentId = "") {
  if (!id) return true;
  const loc = await env.DB.prepare("SELECT * FROM storage_locations WHERE id = ?").bind(id).first();
  if (!loc || !loc.active) return false;
  return !loc.is_full || id === currentId;
}
