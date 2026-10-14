// Bootstrap + alerts. Both aggregate across many tables so they live together.
// Bootstrap is what the frontend calls once after login; alerts is the live
// re-fetch used by the dashboard.

import { json } from "../lib/http.js";
import { loadSamplesFull, rowToPublicUser } from "../lib/db.js";

export async function tryBootstrap(request, env, ctx, { path, method, user }) {
  if (method === "GET" && path.join("/") === "api/bootstrap") {
    const whereParts = [];
    const whereArgs = [];
    if (user.role === "analyst") {
      whereParts.push("(archived_at IS NULL OR archived_at = '')");
      whereParts.push("active = 1");
    }
    if (whereParts.length === 0) whereParts.push("1 = 1");

    const samples = await loadSamplesFull(env, {
      whereSql: whereParts.join(" AND "),
      whereArgs,
      limit: 2000
    });

    const [people, storage, tests, usersRows, auditRows] = await Promise.all([
      env.DB.prepare("SELECT * FROM people ORDER BY name").all(),
      env.DB.prepare("SELECT * FROM storage_locations ORDER BY name").all(),
      env.DB.prepare("SELECT * FROM tests ORDER BY name").all(),
      user.role === "admin"
        ? env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all()
        : Promise.resolve({ results: [] }),
      user.role === "admin"
        ? env.DB.prepare("SELECT * FROM audit_log ORDER BY at DESC LIMIT 200").all()
        : Promise.resolve({ results: [] })
    ]);

    return json({
      user: rowToPublicUser(user),
      users: (usersRows.results || []).map(rowToPublicUser),
      people: (people.results || []).map(p => ({
        id: p.id, name: p.name, role: p.role, active: Boolean(p.active)
      })),
      storageLocations: (storage.results || []).map(s => ({
        id: s.id, name: s.name, type: s.type,
        active: Boolean(s.active), isFull: Boolean(s.is_full),
        capacityNote: s.capacity_note || ""
      })),
      tests: (tests.results || []).map(t => ({
        id: t.id, name: t.name, unit: t.unit, limit: t.limit, method: t.method
      })),
      samples,
      audit: (auditRows.results || []).map(a => ({
        id: a.id, at: a.at,
        userId: a.user_id, userName: a.user_name,
        action: a.action, entity: a.entity, entityId: a.entity_id,
        detail: a.detail
      })),
      alerts: computeAlerts(samples),
      files: [],
      health: user.role === "admin" ? {
        database: "Cloudflare D1",
        samples: samples.length,
        users: (usersRows.results || []).length,
        auditEntries: (auditRows.results || []).length,
        uploadedFiles: samples.reduce((n, s) => n + (s.files || []).length, 0),
        storage: "D1 + R2"
      } : null
    });
  }

  if (method === "GET" && path.join("/") === "api/alerts") {
    const samples = await loadSamplesFull(env, { limit: 2000 });
    return json(computeAlerts(samples));
  }

  return null;
}

function computeAlerts(samples) {
  const nowMs = Date.now();
  return {
    overdue: samples.filter(s =>
      s.status !== "Approved" && s.status !== "Disposed"
      && new Date(s.dueAt || 0).getTime() < nowMs
    ),
    dueSoon: samples.filter(s =>
      s.status !== "Approved" && s.status !== "Disposed"
      && new Date(s.dueAt || 0).getTime() - nowMs < 24 * 60 * 60 * 1000
      && new Date(s.dueAt || 0).getTime() >= nowMs
    ),
    waitingUpload: samples.filter(s =>
      !(s.files || []).some(f =>
        f.category?.includes("Written Record") || f.category?.includes("Book")
      )
    ),
    waitingApproval: samples.filter(s =>
      s.status === "Needs Review" || s.status === "Results Entered"
    ),
    disposalReady: samples.filter(s =>
      s.status === "Approved" && s.retentionStatus === "Active"
    )
  };
}
