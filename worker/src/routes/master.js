// Master data CRUD: people, storage locations, tests. Admin-only.
// Treats the three tables uniformly through a tiny whitelist.

import { json, bodyJson, now } from "../lib/http.js";
import { requireRole } from "../lib/perms.js";
import { addAudit } from "../lib/db.js";

const TABLES = {
  people: "people",
  "storage-locations": "storage_locations",
  tests: "tests"
};

const PATCH_COLUMN_WHITELIST = [
  "name", "role", "active", "type", "is_full", "capacity_note", "unit", "limit", "method"
];

export async function tryMaster(request, env, ctx, { path, method, user }) {
  if (!(path[0] === "api" && TABLES[path[1]])) return null;
  requireRole(user, "admin");
  const table = TABLES[path[1]];

  /* ---------- Create row ---------- */
  if (method === "POST") {
    const body = await bodyJson(request);
    const id = crypto.randomUUID();
    if (table === "people") {
      await env.DB.prepare("INSERT INTO people (id,name,role,active,created_at) VALUES (?,?,?,1,?)")
        .bind(id, body.name, body.role || "Analyst", now()).run();
    } else if (table === "storage_locations") {
      await env.DB.prepare("INSERT INTO storage_locations (id,name,type,active,is_full,capacity_note) VALUES (?,?,?,1,?,?)")
        .bind(id, body.name, body.type || "Storage", body.isFull ? 1 : 0, body.capacityNote || "").run();
    } else if (table === "tests") {
      await env.DB.prepare('INSERT INTO tests (id,name,unit,"limit",method) VALUES (?,?,?,?,?)')
        .bind(id, body.name, body.unit || "", body.limit || "", body.method || "").run();
    }
    await addAudit(env, user, `Added ${path[1]}`, path[1], id, body.name || "");
    const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
    return json(row);
  }

  /* ---------- Patch row ---------- */
  if (method === "PATCH") {
    const body = await bodyJson(request);
    const parts = [], args = [];
    for (const [k, v] of Object.entries(body)) {
      // camelCase → snake_case for the two columns that have it
      const col = k === "isFull" ? "is_full" : k === "capacityNote" ? "capacity_note" : k;
      if (!PATCH_COLUMN_WHITELIST.includes(col)) continue;
      parts.push(col === "limit" ? '"limit" = ?' : `${col} = ?`);
      args.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
    if (parts.length) {
      args.push(path[2]);
      await env.DB.prepare(`UPDATE ${table} SET ${parts.join(", ")} WHERE id = ?`).bind(...args).run();
    }
    const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(path[2]).first();
    return json(row);
  }

  return null;
}
