// Admin-only user management: create, approve/reject pending signups,
// PATCH role/active, soft-delete.

import { json, bodyJson, now, httpError } from "../lib/http.js";
import { hashPassword } from "../lib/crypto.js";
import { requireRole } from "../lib/perms.js";
import { addAudit, rowToPublicUser } from "../lib/db.js";

export async function tryUsers(request, env, ctx, { path, method, user }) {
  if (!(path[0] === "api" && path[1] === "users")) return null;

  /* ---------- Create user ---------- */
  if (method === "POST" && path.length === 2) {
    requireRole(user, "admin");
    const body = await bodyJson(request);
    if (!["admin", "analyst"].includes(body.role)) {
      throw httpError("Choose admin/manager or analyst", 400);
    }
    const dupe = await env.DB.prepare("SELECT 1 FROM users WHERE active = 1 AND LOWER(email) = ? LIMIT 1").bind(String(body.email).toLowerCase()).first();
    if (dupe) throw httpError("Email already exists", 409);
    const id = crypto.randomUUID();
    const pwHash = await hashPassword(body.password);
    await env.DB.prepare(`
      INSERT INTO users (id,name,email,phone,country_code,password_hash,role,active,approval_status,approved_at,approved_by,created_at)
      VALUES (?,?,?,?,?,?,?,1,'approved',?,?,?)
    `).bind(
      id, body.name, body.email, body.phone || "", body.countryCode || "",
      pwHash, body.role, now(), user.name, now()
    ).run();
    const created = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    await addAudit(env, user, "Created user", "user", id, `${body.name} added as ${body.role}`);
    return json(rowToPublicUser(created));
  }

  /* ---------- Approve pending signup ---------- */
  if (method === "POST" && path[3] === "approve") {
    requireRole(user, "admin");
    const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(path[2]).first();
    if (!target) throw httpError("User not found", 404);
    if (target.approval_status !== "pending") {
      throw httpError(`Cannot approve — user status is "${target.approval_status}"`, 400);
    }
    const body = await bodyJson(request);
    const role = body.role && ["admin", "analyst"].includes(body.role) ? body.role : target.role;
    await env.DB.prepare("UPDATE users SET role = ?, approval_status = 'approved', approved_at = ?, approved_by = ?, active = 1 WHERE id = ?")
      .bind(role, now(), user.name, target.id).run();
    const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(target.id).first();
    await addAudit(env, user, "Approved user", "user", target.id, `${target.name} approved as ${role}`);
    return json(rowToPublicUser(updated));
  }

  /* ---------- Reject pending signup ---------- */
  if (method === "POST" && path[3] === "reject") {
    requireRole(user, "admin");
    const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(path[2]).first();
    if (!target) throw httpError("User not found", 404);
    if (target.approval_status !== "pending") {
      throw httpError(`Cannot reject — user status is "${target.approval_status}"`, 400);
    }
    const body = await bodyJson(request);
    const reason = String(body.reason || "").slice(0, 500);
    await env.DB.prepare("UPDATE users SET approval_status = 'rejected', active = 0, rejected_at = ?, rejected_by = ?, rejection_reason = ? WHERE id = ?")
      .bind(now(), user.name, reason, target.id).run();
    const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(target.id).first();
    await addAudit(env, user, "Rejected user signup", "user", target.id, `${target.name}${reason ? ` — ${reason}` : ""}`);
    return json(rowToPublicUser(updated));
  }

  /* ---------- Modify role/active ---------- */
  if (method === "PATCH") {
    requireRole(user, "admin");
    const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(path[2]).first();
    if (!target) throw httpError("User not found", 404);
    const body = await bodyJson(request);
    const parts = [], args = [];
    if (body.role && ["admin", "analyst"].includes(body.role)) { parts.push("role = ?"); args.push(body.role); }
    if (typeof body.active === "boolean") { parts.push("active = ?"); args.push(body.active ? 1 : 0); }
    if (parts.length) {
      args.push(target.id);
      await env.DB.prepare(`UPDATE users SET ${parts.join(", ")} WHERE id = ?`).bind(...args).run();
    }
    const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(target.id).first();
    await addAudit(env, user, "Modified user", "user", target.id, `${target.name}: role=${updated.role}, active=${updated.active}`);
    return json(rowToPublicUser(updated));
  }

  /* ---------- Soft delete ---------- */
  if (method === "DELETE") {
    requireRole(user, "admin");
    const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(path[2]).first();
    if (!target) throw httpError("User not found", 404);
    if (target.id === user.id) throw httpError("You cannot delete your own login", 400);
    // L5: wipe the stored password hash on soft-delete so an attacker who
    // later reactivates the row cannot sign in as the deleted user. A real
    // reactivation path has to go through password reset.
    await env.DB.prepare("UPDATE users SET active = 0, password_hash = NULL, deleted_at = ?, deleted_by = ? WHERE id = ?").bind(now(), user.name, target.id).run();
    const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(target.id).first();
    return json(rowToPublicUser(updated));
  }

  return null;
}
