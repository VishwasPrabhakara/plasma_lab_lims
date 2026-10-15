// Sample lifecycle routes: create, bulk create, field-collect, storage move,
// PATCH (status/assignedTo/notes/dueAt), approve (signed), lifecycle, search,
// QR / tube label / printable report.
//
// Results entry and file upload live in sibling route modules.

import { json, html, bodyJson, now, addDays, httpError, APP_NAME } from "../lib/http.js";
import { verifyPassword } from "../lib/crypto.js";
import {
  addAudit, loadSampleFull, nextSampleCode, storageIsAvailable
} from "../lib/db.js";
import {
  requireRole, canReadSample, canWorkOnSample, normalizeAssignedTo
} from "../lib/perms.js";
import QRCode from "qrcode";

// Statuses the PATCH endpoint may set. "Approved" is signed via /approve;
// "Disposed" is set via /lifecycle. Keeping that invariant here means the
// ceremony cannot be routed around.
const PATCH_ALLOWED_STATUSES = new Set([
  "Bottle Ready", "Sample Collected", "Stored", "Assigned",
  "In Analysis", "Results Entered", "Needs Review", "Flagged"
]);

export async function trySamples(request, env, ctx, { url, path, method, user }) {
  /* ---------- Samples: create one ---------- */
  if (method === "POST" && path.join("/") === "api/samples") {
    requireRole(user, "admin");
    const body = await bodyJson(request);
    validateSampleBody(body);
    if (!(await storageIsAvailable(env, body.storageLocationId))) {
      throw httpError("Selected storage is full or inactive", 400);
    }
    const id = crypto.randomUUID();
    const code = await nextSampleCode(env);
    const dueAt = body.dueAt || addDays(now(), 3);
    await env.DB.prepare(`
      INSERT INTO samples (id,sample_code,status,workflow_stage,client_name,source_type,collection_site,collector,received_by,received_at,storage_location_id,assigned_to,requested_tests,notes,planned_sampling_date,due_at,retention_status,active,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Active',1,?,?)
    `).bind(
      id, code, body.status || "Bottle Ready", body.status || "Bottle Ready",
      body.clientName, body.sourceType, body.collectionSite, body.collector,
      user.name, now(),
      body.storageLocationId || null, normalizeAssignedTo(body.assignedTo),
      JSON.stringify(body.requestedTests), body.notes || "",
      body.plannedSamplingDate || "",
      dueAt, now(), now()
    ).run();
    await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,location_id,note) VALUES (?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), id, now(), user.name, "Bottle labelled", body.storageLocationId || null, "").run();
    await addAudit(env, user, "Prepared bottle label", "sample", id, `${code} created`);
    return json(await loadSampleFull(env, id));
  }

  /* ---------- Samples: bulk create ---------- */
  if (method === "POST" && path.join("/") === "api/samples/bulk") {
    requireRole(user, "admin");
    const body = await bodyJson(request);
    const created = [], errors = [];
    const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 250);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        validateSampleBody(row);
        if (!(await storageIsAvailable(env, row.storageLocationId))) {
          throw new Error("Selected storage is full or inactive");
        }
        const id = crypto.randomUUID();
        const code = await nextSampleCode(env);
        const dueAt = row.dueAt || addDays(now(), 3);
        await env.DB.prepare(`
          INSERT INTO samples (id,sample_code,status,workflow_stage,client_name,source_type,collection_site,collector,received_by,received_at,storage_location_id,assigned_to,requested_tests,notes,planned_sampling_date,due_at,retention_status,active,created_at,updated_at)
          VALUES (?,?,'Bottle Ready','Bottle Ready',?,?,?,?,?,?,?,?,?,?,?,?,'Active',1,?,?)
        `).bind(
          id, code,
          row.clientName, row.sourceType, row.collectionSite, row.collector,
          user.name, now(),
          row.storageLocationId || null, normalizeAssignedTo(row.assignedTo),
          JSON.stringify(row.requestedTests), row.notes || "",
          row.plannedSamplingDate || "",
          dueAt, now(), now()
        ).run();
        await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,location_id,note) VALUES (?,?,?,?,?,?,?)")
          .bind(crypto.randomUUID(), id, now(), user.name, "Bottle labelled", row.storageLocationId || null, "").run();
        created.push(await loadSampleFull(env, id));
      } catch (e) {
        errors.push({ row: i + 1, error: e.message });
      }
    }
    if (!created.length) throw httpError("No samples could be created", 400, { errors });
    await addAudit(env, user, "Bulk created samples", "sample", "bulk", `${created.length} samples created`);
    return json({ created, errors });
  }

  /* ---------- Samples: field collect ---------- */
  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "collect") {
    const s = await requireSample(env, path[2]);
    const isAdmin = user.role === "admin";
    if (!isAdmin && s.collector !== user.name) {
      throw httpError("Only the named collector or an admin can mark this sample collected", 403);
    }
    if (s.status !== "Bottle Ready" && s.status !== "Sample Collected") {
      throw httpError(`Cannot mark collected — sample is on step "${s.status}"`, 400);
    }
    const body = await bodyJson(request);
    const site = String(body.collectionSite || "").trim();
    if (!site) throw httpError("Sampling site required", 400);
    await env.DB.prepare(`
      UPDATE samples SET collection_site = ?, status = 'Sample Collected', workflow_stage = 'Sample Collected',
        collected_at = ?, collection_lat = ?, collection_lng = ?, updated_at = ? WHERE id = ?
    `).bind(
      site, body.collectedAt || now(),
      body.collectionLat ? String(body.collectionLat) : null,
      body.collectionLng ? String(body.collectionLng) : null,
      now(), s.id
    ).run();
    const locNote = body.collectionLat && body.collectionLng ? ` @ ${body.collectionLat},${body.collectionLng}` : "";
    await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,location_id) VALUES (?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), s.id, now(), user.name, `Sample collected at ${site}${locNote}`, s.storage_location_id).run();
    await addAudit(env, user, "Sample collected", "sample", s.id, `${s.sample_code}: site=${site}${locNote}`);
    return json(await loadSampleFull(env, s.id));
  }

  /* ---------- Samples: storage move (any analyst) ---------- */
  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "storage") {
    const s = await requireSample(env, path[2]);
    const body = await bodyJson(request);
    const prev = s.storage_location_id || "";
    const next = body.storageLocationId || "";
    if (next && !(await storageIsAvailable(env, next, prev))) throw httpError("Selected storage is full or inactive", 400);
    if (prev === next) throw httpError("Sample is already in that storage", 400);
    const isFirstStore = s.status === "Sample Collected" && next;
    const updates = ["storage_location_id = ?", "updated_at = ?"];
    const args = [next || null, now()];
    if (isFirstStore) {
      updates.push("status = 'Stored'", "workflow_stage = 'Stored'");
    }
    args.push(s.id);
    await env.DB.prepare(`UPDATE samples SET ${updates.join(", ")} WHERE id = ?`).bind(...args).run();
    await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,from_location_id,to_location_id,location_id,note) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), s.id, now(), user.name,
        isFirstStore ? "Logged into storage" : "Storage moved",
        prev || null, next || null, next || null,
        body.reason || body.note || "").run();
    await addAudit(env, user, isFirstStore ? "Sample stored" : "Storage moved", "sample", s.id,
      `${s.sample_code}: ${prev || "unstored"} -> ${next || "unstored"}${body.reason ? ` (${body.reason})` : ""}`);
    return json(await loadSampleFull(env, s.id));
  }

  /* ---------- Samples: approve (signed, password-reauthenticated) ---------- */
  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "approve") {
    requireRole(user, "admin");
    const body = await bodyJson(request);
    // Signature password: the admin re-authenticates at the moment of approval.
    // Without this the "signed approval" claim in the audit trail is a lie.
    if (!body.signaturePassword || !(await verifyPassword(body.signaturePassword, user.password_hash))) {
      await addAudit(env, user, "Approval refused — bad signature password", "sample", path[2], "signature password did not match stored hash");
      throw httpError("Signature password did not match. Approval refused.", 401);
    }
    const s = await requireSample(env, path[2]);
    const resultCount = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sample_results WHERE sample_id = ?").bind(s.id).first()).n;
    if (resultCount === 0) throw httpError("Enter results before approval", 400);
    const t = now();
    const reason = (body.reason || "").trim();
    await env.DB.batch([
      env.DB.prepare("UPDATE samples SET status = 'Approved', workflow_stage = 'Approved', reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
        .bind(user.name, t, t, s.id),
      env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,location_id,note) VALUES (?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), s.id, t, user.name, "Approved (signed)", s.storage_location_id, reason),
      env.DB.prepare("INSERT INTO audit_log (id,at,user_id,user_name,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), t, user.id, user.name, "Approved sample (signed)", "sample", s.id,
          `${s.sample_code} approved${reason ? ": " + reason : ""}`)
    ]);
    return json(await loadSampleFull(env, s.id));
  }

  /* ---------- Samples: lifecycle (Retained / Disposed / Active) ---------- */
  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "lifecycle") {
    requireRole(user, "admin");
    const s = await requireSample(env, path[2]);
    const body = await bodyJson(request);
    const action = body.action === "Dispose" ? "Disposed" : body.action;
    if (!["Retained", "Disposed", "Active"].includes(action)) throw httpError("Invalid lifecycle action", 400);
    const updates = ["retention_status = ?", "updated_at = ?"];
    const args = [action, now()];
    if (action === "Disposed") {
      updates.push("status = 'Disposed'", "workflow_stage = 'Disposed'", "disposal_json = ?");
      args.push(JSON.stringify({ disposedAt: now(), disposedBy: user.name, reason: body.reason || "" }));
    }
    args.push(s.id);
    await env.DB.prepare(`UPDATE samples SET ${updates.join(", ")} WHERE id = ?`).bind(...args).run();
    await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,location_id) VALUES (?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), s.id, now(), user.name, action, s.storage_location_id).run();
    await addAudit(env, user, `Lifecycle: ${action}`, "sample", s.id, `${s.sample_code}${body.reason ? ` — ${body.reason}` : ""}`);
    return json(await loadSampleFull(env, s.id));
  }

  /* ---------- Samples: PATCH (status, assignedTo, notes, dueAt, storage) ----------
     Status is whitelisted to the intermediate lifecycle. "Approved" must come
     through /approve (signature-password ceremony); "Disposed" must come through
     /lifecycle. assignedTo is admin-only — an analyst who could rewrite the
     assignment on their own sample could kick other analysts off or add names,
     muddying attribution. */
  if (method === "PATCH" && path[0] === "api" && path[1] === "samples" && path.length === 3) {
    const s = await requireSample(env, path[2]);
    if (!canWorkOnSample(user, s)) throw httpError("Not allowed for this sample", 403);
    const body = await bodyJson(request);

    if ("status" in body && !PATCH_ALLOWED_STATUSES.has(body.status)) {
      throw httpError(
        `Status "${body.status}" cannot be set here. Use /approve for Approved and /lifecycle for Disposed; status must be one of: ${[...PATCH_ALLOWED_STATUSES].join(", ")}.`,
        400
      );
    }
    if ("assignedTo" in body && user.role !== "admin") {
      throw httpError("Only an admin can reassign a sample.", 403);
    }

    const prev = s.storage_location_id || "";
    const prevAssignedTo = s.assignedTo || "";
    const prevCollectionLat = s.collectionLat || "";
    const prevCollectionLng = s.collectionLng || "";
    let statusToSet = body.status;

    // Smart status updates based on data changes
    if (!statusToSet) {
      // If GPS data is being set for the first time, set to Sample Collected
      if (("collectionLat" in body || "collectionLng" in body) &&
          (!prevCollectionLat || !prevCollectionLng) &&
          (body.collectionLat || body.collectionLng)) {
        statusToSet = "Sample Collected";
      }
      // If storage is being set for the first time, set to Stored
      else if ("storageLocationId" in body && body.storageLocationId && !prev) {
        statusToSet = "Stored";
      }
      // If analysts are being assigned for the first time, set to In Analysis
      else if ("assignedTo" in body && body.assignedTo && !prevAssignedTo) {
        statusToSet = "In Analysis";
      }
    }

    // Validate status if being set (either directly or via smart update)
    if (statusToSet && !PATCH_ALLOWED_STATUSES.has(statusToSet)) {
      throw httpError(
        `Status "${statusToSet}" cannot be set here. Use /approve for Approved and /lifecycle for Disposed; status must be one of: ${[...PATCH_ALLOWED_STATUSES].join(", ")}.`,
        400
      );
    }

    if ("assignedTo" in body) body.assignedTo = normalizeAssignedTo(body.assignedTo);
    const parts = [], args = [];
    const map = {
      status: "status",
      assignedTo: "assigned_to",
      storageLocationId: "storage_location_id",
      notes: "notes",
      dueAt: "due_at",
      collectionLat: "collection_lat",
      collectionLng: "collection_lng"
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in body) { parts.push(`${col} = ?`); args.push(body[k] || null); }
    }
    // Apply smart status update if determined
    if (statusToSet) {
      parts.push("status = ?");
      args.push(statusToSet);
      parts.push("workflow_stage = ?");
      args.push(statusToSet);
    }
    parts.push("updated_at = ?"); args.push(now());
    args.push(s.id);
    await env.DB.prepare(`UPDATE samples SET ${parts.join(", ")} WHERE id = ?`).bind(...args).run();

    // Handle chain of custody for GPS data
    if ((body.collectionLat || body.collectionLng) &&
        (!prevCollectionLat || !prevCollectionLng)) {
      const locNote = body.collectionLat && body.collectionLng ? ` @ ${body.collectionLat},${body.collectionLng}` : "";
      await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,location_id) VALUES (?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), s.id, now(), user.name, `Sample collected at ${s.collection_site}${locNote}`, s.storage_location_id).run();
    }

    if ("storageLocationId" in body && prev !== (body.storageLocationId || "")) {
      await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,from_location_id,to_location_id,location_id,note) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), s.id, now(), user.name, "Storage moved",
          prev || null, body.storageLocationId || null, body.storageLocationId || null,
          body.movementNote || body.notes || "").run();
    }
    if ("assignedTo" in body && body.assignedTo) {
      await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,location_id) VALUES (?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), s.id, now(), user.name, `Assigned to ${body.assignedTo}`, s.storage_location_id).run();
    }
    const changed = Object.keys(body).join(", ");
    await addAudit(env, user, "Modified sample", "sample", s.id, `${s.sample_code}: ${changed}`);
    return json(await loadSampleFull(env, s.id));
  }

  /* ---------- Search sample by code or id ---------- */
  if (method === "GET" && path[0] === "api" && path[1] === "search-sample") {
    const code = decodeURIComponent(path.slice(2).join("/"));
    const s = await env.DB.prepare("SELECT * FROM samples WHERE sample_code = ? OR id = ? LIMIT 1").bind(code, code).first();
    if (!s) throw httpError("Sample not found", 404);
    if (!canReadSample(user, s)) throw httpError("Not allowed for this sample", 403);
    return json(await loadSampleFull(env, s.id));
  }

  /* ---------- QR SVG, tube label HTML, printable report ---------- */
  if (method === "GET" && path[0] === "api" && path[1] === "samples" && path[2] && path[3]) {
    const sId = path[2];
    const sub = path[3];
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(sId).first();
    if (!s || !canReadSample(user, s)) throw httpError("Sample not found", 404);
    const base = (env.FRONTEND_PUBLIC_URL || "").replace(/\/$/, "");
    const payload = `${base}/?sample=${encodeURIComponent(s.sample_code)}`;

    if (sub === "qr.svg") {
      return new Response(await QRCode.toString(payload, { type: "svg", margin: 1, width: 240 }), {
        headers: { "content-type": "image/svg+xml" }
      });
    }
    if (sub === "tube-label") {
      const qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await QRCode.toString(payload, { type: "svg", margin: 0, width: 110 }))}`;
      return html(`<!doctype html><html><head><meta charset="utf-8"><title>${s.sample_code} label</title><style>body{font-family:Arial;margin:14px}.toolbar{margin-bottom:12px}.tube-label{width:38mm;height:18mm;border:1px solid #111;padding:1mm;display:grid;grid-template-columns:13mm 1fr;gap:1.5mm;align-items:center}.tube-label img{width:13mm;height:13mm}.tube-code{font-size:8px;font-weight:800}.tube-meta{font-size:6.5px}@media print{.toolbar{display:none}body{margin:0}}</style></head><body><div class="toolbar"><button onclick="window.print()">Print</button></div><div class="tube-label"><img src="${qr}"><div><div class="tube-code">${s.sample_code}</div><div class="tube-meta">${s.collection_site || ""}</div></div></div></body></html>`);
    }
    if (sub === "report" || sub === "report.pdf") {
      const results = (await env.DB.prepare("SELECT * FROM sample_results WHERE sample_id = ? ORDER BY entered_at").bind(s.id).all()).results || [];
      const rows = results.map(r =>
        `<tr><td>${r.parameter}</td><td>${r.value} ${r.unit || ""}</td><td>${r.limit || ""}</td><td>${r.method || ""}</td><td>${r.flag || "OK"}</td><td>${r.analyst || ""}</td></tr>`
      ).join("");
      return html(`<!doctype html><html><head><meta charset="utf-8"><title>${s.sample_code} report</title><style>body{font-family:Arial;margin:28px}table{border-collapse:collapse;width:100%;margin-top:14px}td,th{border:1px solid #999;padding:8px}@media print{button{display:none}}</style></head><body><button onclick="window.print()">Print</button><h1>${APP_NAME} — ${s.sample_code}</h1><p><b>Project:</b> ${s.client_name}<br><b>Site:</b> ${s.collection_site}<br><b>Status:</b> ${s.status}</p><table><thead><tr><th>Parameter</th><th>Result</th><th>Limit</th><th>Method</th><th>Flag</th><th>Analyst</th></tr></thead><tbody>${rows || "<tr><td colspan=6>No results entered</td></tr>"}</tbody></table></body></html>`);
    }
    // Fall through — some other /samples/:id/sub route may handle it.
  }

  return null;
}

/* ---------- helpers ---------- */

function validateSampleBody(body) {
  if (!body.clientName || !body.collectionSite || !body.sourceType || !body.collector) {
    throw new Error("Project/client, site, source type, and brought by are required");
  }
  if (!Array.isArray(body.requestedTests) || body.requestedTests.length === 0) {
    throw new Error("Choose at least one requested test");
  }
}

async function requireSample(env, id) {
  const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(id).first();
  if (!s) throw httpError("Sample not found", 404);
  return s;
}
