// Results entry: single row, bulk paste (CSV/TSV), or structured sheet.
// Advances the sample's workflow:
//   - any row flagged Alert   → status = "Flagged" (admin reviews before
//                                reclassifying)
//   - otherwise               → status = "Needs Review" (actionable
//                                "waiting for approval" state the admin
//                                sees in the approvals queue)
// "Results Entered" as a distinct status is retired for new submissions —
// the presence of result rows on the Results tab tells you results exist;
// the status itself signals what needs doing next.

import { json, bodyJson, now, httpError } from "../lib/http.js";
import { addAudit, loadSampleFull } from "../lib/db.js";
import { canWorkOnSample } from "../lib/perms.js";

export async function tryResults(request, env, ctx, { path, method, user }) {
  if (!(method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "results")) {
    return null;
  }

  const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(path[2]).first();
  if (!s) throw httpError("Sample not found", 404);
  if (!canWorkOnSample(user, s)) throw httpError("Not allowed for this sample", 403);

  const body = await bodyJson(request);
  let rows = [];
  if (path[4] === "bulk") {
    rows = String(body.rows || "")
      .split(/\r?\n/)
      .map(l => l.split(/,|\t/).map(c => c.trim()))
      .filter(c => c[0] && c[1])
      .map(c => ({
        parameter: c[0], value: c[1], unit: c[2] || "",
        limit: c[3] || "", method: c[4] || "", flag: c[5] || "OK"
      }));
  } else if (path[4] === "sheet") {
    rows = (Array.isArray(body.rows) ? body.rows : []).filter(r => r.parameter && r.value);
  } else if (path[4] === "excel") {
    throw httpError("Excel result import is not migrated yet. Use Input Data sheet online.", 400);
  } else {
    rows = [{
      parameter: body.parameter, value: body.value, unit: body.unit || "",
      limit: body.limit || "", method: body.method || "", flag: body.flag || "OK"
    }];
  }

  if (!rows.length) throw httpError("Enter at least one result row", 400);

  const insertedAt = now();
  const newStatus = rows.some(r => r.flag === "Alert") ? "Flagged" : "Needs Review";

  // Single atomic batch: results insert, sample status update, audit, custody.
  const batch = [
    ...rows.map(r => env.DB.prepare(
      'INSERT INTO sample_results (id,sample_id,parameter,value,unit,"limit",method,flag,analyst,replicates,avg,stddev,msg,entered_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      crypto.randomUUID(), s.id, r.parameter, r.value || "",
      r.unit || "", r.limit || "", r.method || "", r.flag || "OK", user.name,
      r.replicates ? JSON.stringify(r.replicates) : null,
      r.avg == null ? null : Number(r.avg),
      r.stddev == null ? null : Number(r.stddev),
      r.msg || null, insertedAt
    )),
    env.DB.prepare("UPDATE samples SET status = ?, workflow_stage = ?, updated_at = ? WHERE id = ?")
      .bind(newStatus, newStatus, insertedAt, s.id),
    env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,location_id,note) VALUES (?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), s.id, insertedAt, user.name,
        `Entered ${rows.length} result row${rows.length > 1 ? "s" : ""}`,
        s.storage_location_id, newStatus),
    env.DB.prepare("INSERT INTO audit_log (id,at,user_id,user_name,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), insertedAt, user.id, user.name,
        "Entered results", "sample", s.id,
        `${s.sample_code}: ${rows.length} row${rows.length > 1 ? "s" : ""} (${newStatus})`)
  ];
  await env.DB.batch(batch);

  return json(await loadSampleFull(env, s.id));
}
