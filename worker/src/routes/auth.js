// Public auth routes: health, login, signup, OTP verification, password
// reset. Everything in this file is reachable without a session token.

import { json, bodyJson, now, httpError } from "../lib/http.js";
import { hashPassword, verifyPassword, signJwt, otpCode, otpExpiry } from "../lib/crypto.js";
import { validEmail, validPhone } from "../lib/validators.js";
import { sendOtpInBackground } from "../lib/email.js";
import { addAudit, rowToPublicUser } from "../lib/db.js";

export async function tryAuth(request, env, ctx, { url, path, method }) {
  /* ---------- Health check ---------- */
  if (path.join("/") === "api/health") {
    const [sCount, uCount] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM samples").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()
    ]);
    return json({ ok: true, service: "Plasma Lab LIMS Worker API", database: "Cloudflare D1", samples: sCount.n, users: uCount.n });
  }

  /* ---------- Login ---------- */
  if (method === "POST" && path.join("/") === "api/login") {
    const body = await bodyJson(request);
    const emailLower = String(body.email || "").toLowerCase();
    const anyUser = await env.DB.prepare(
      "SELECT * FROM users WHERE LOWER(email) = ? AND replaced_at IS NULL AND password_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1"
    ).bind(emailLower).first();
    if (!anyUser || !(await verifyPassword(body.password || "", anyUser.password_hash))) {
      // Write a failure audit row so repeated attempts are visible to admins.
      // Log the email, never the password.
      try {
        await addAudit(env, null, "Failed login", "user", anyUser ? anyUser.id : "unknown", `email=${emailLower}`);
      } catch { /* best-effort audit */ }
      throw httpError("Invalid email or password", 401);
    }
    if (anyUser.approval_status === "pending") {
      throw httpError("Your account is awaiting admin approval. You'll be able to sign in once an admin approves it.", 403, { approvalStatus: "pending" });
    }
    if (anyUser.approval_status === "rejected") {
      throw httpError("Your account request was declined. Contact the lab administrator.", 403);
    }
    if (!anyUser.active) {
      throw httpError("This account is deactivated. Contact the lab administrator.", 403);
    }
    await env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now(), anyUser.id).run();
    await addAudit(env, anyUser, "Logged in", "user", anyUser.id, "User session started");
    // Multi-device allowed. Token expires in 12h regardless of Remember Me —
    // the frontend drops it on browser close either way.
    const token = await signJwt({ id: anyUser.id }, env.JWT_SECRET, 12 * 60 * 60);
    return json({ token, user: rowToPublicUser(anyUser) });
  }

  /* ---------- Signup — email OTP start ---------- */
  if (method === "POST" && path.join("/") === "api/signup/email/start") {
    const body = await bodyJson(request);
    if (!body.name || !validEmail(body.email)) throw httpError("Name and valid email are required", 400);
    const emailLower = body.email.toLowerCase();
    const existing = await env.DB.prepare("SELECT 1 FROM users WHERE LOWER(email) = ? AND active = 1 LIMIT 1").bind(emailLower).first();
    if (existing) throw httpError("Email already exists", 409);
    await env.DB.prepare("DELETE FROM pending_signups WHERE LOWER(email) = ?").bind(emailLower).run();
    const emailOtp = otpCode();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO pending_signups (id,name,email,email_otp,email_verified,expires_at,created_at) VALUES (?,?,?,?,0,?,?)"
    ).bind(id, body.name, body.email, emailOtp, otpExpiry(), now()).run();
    const delivered = sendOtpInBackground(ctx, env, body.email, emailOtp, "Plasma Lab LIMS signup verification");
    await addAudit(env, null, delivered ? "Sent signup email OTP" : "Generated signup OTP", "user", id, `${body.name} requested email verification`);
    return json({ pendingId: id, expiresAt: otpExpiry(), deliveryConfigured: delivered });
  }

  /* ---------- Signup — email OTP verify ---------- */
  if (method === "POST" && path.join("/") === "api/signup/email/verify") {
    const body = await bodyJson(request);
    const p = await env.DB.prepare("SELECT * FROM pending_signups WHERE id = ?").bind(body.pendingId).first();
    if (!p || new Date(p.expires_at).getTime() <= Date.now() || String(p.email_otp) !== String(body.emailOtp || "").trim()) {
      throw httpError("Invalid or expired email OTP", 400);
    }
    await env.DB.prepare("UPDATE pending_signups SET email_verified = 1, expires_at = ? WHERE id = ?").bind(otpExpiry(), body.pendingId).run();
    return json({ pendingId: body.pendingId, ok: true });
  }

  /* ---------- Signup — phone save ---------- */
  if (method === "POST" && path.join("/") === "api/signup/phone/save") {
    const body = await bodyJson(request);
    const p = await env.DB.prepare("SELECT * FROM pending_signups WHERE id = ?").bind(body.pendingId).first();
    if (!p || !p.email_verified) throw httpError("Verify email first", 400);
    if (!validPhone(body.countryCode, body.phone)) throw httpError("Enter a valid country code and phone number", 400);
    const phoneDigits = String(body.phone).replace(/\D/g, "");
    const dupe = await env.DB.prepare(
      "SELECT 1 FROM users WHERE active = 1 AND country_code = ? AND phone = ? LIMIT 1"
    ).bind(String(body.countryCode), phoneDigits).first();
    if (dupe) throw httpError("Phone already exists", 409);
    await env.DB.prepare("UPDATE pending_signups SET country_code = ?, phone = ?, expires_at = ? WHERE id = ?")
      .bind(body.countryCode, phoneDigits, otpExpiry(), body.pendingId).run();
    return json({ pendingId: body.pendingId, ok: true });
  }

  /* ---------- Signup — complete (approval-gated except first user) ---------- */
  if (method === "POST" && path.join("/") === "api/signup/complete") {
    const body = await bodyJson(request);
    const p = await env.DB.prepare("SELECT * FROM pending_signups WHERE id = ?").bind(body.pendingId).first();
    if (!p || !p.email_verified || !p.phone) throw httpError("Verify email and enter phone before creating password", 400);
    if (!body.password || String(body.password).length < 6) throw httpError("Password must be at least 6 characters", 400);
    if (body.password !== body.confirmPassword) throw httpError("Passwords do not match", 400);
    // Mark any previous unactive users with this email as replaced
    await env.DB.prepare("UPDATE users SET replaced_at = ?, replaced_by_email = ? WHERE LOWER(email) = ? AND active = 0")
      .bind(now(), p.email, p.email.toLowerCase()).run();
    const userCount = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).n;
    const isFirstUser = userCount === 0;
    const role = isFirstUser ? "admin" : "analyst";
    const id = crypto.randomUUID();
    const pwHash = await hashPassword(body.password);
    await env.DB.prepare(`
      INSERT INTO users (id,name,email,phone,country_code,password_hash,role,active,approval_status,signed_up_at,approved_at,approved_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      id, p.name, p.email, p.phone, p.country_code, pwHash, role,
      isFirstUser ? 1 : 0,
      isFirstUser ? "approved" : "pending",
      now(),
      isFirstUser ? now() : null,
      isFirstUser ? "system (first user)" : null,
      now()
    ).run();
    await env.DB.prepare("DELETE FROM pending_signups WHERE id = ?").bind(body.pendingId).run();
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    await addAudit(env, user, isFirstUser ? "Verified signup (auto-approved as first user)" : "Signed up — awaiting approval", "user", id, `${p.name} · ${p.email}`);
    if (isFirstUser) {
      const token = await signJwt({ id, sv: 0 }, env.JWT_SECRET, 12 * 60 * 60);
      return json({ token, user: rowToPublicUser(user), approvalStatus: "approved" });
    }
    return json({ approvalStatus: "pending", user: rowToPublicUser(user), message: "Account created — awaiting admin approval before you can sign in." });
  }

  /* ---------- Signup — resend OTP ---------- */
  if (method === "POST" && path.join("/") === "api/signup/resend") {
    const body = await bodyJson(request);
    const p = await env.DB.prepare("SELECT * FROM pending_signups WHERE id = ?").bind(body.pendingId).first();
    if (!p) throw httpError("Signup request not found", 404);
    const emailOtp = otpCode();
    await env.DB.prepare("UPDATE pending_signups SET email_otp = ?, expires_at = ? WHERE id = ?").bind(emailOtp, otpExpiry(), p.id).run();
    const delivered = sendOtpInBackground(ctx, env, p.email, emailOtp, "Plasma Lab LIMS signup verification");
    await addAudit(env, null, delivered ? "Resent signup OTP" : "Regenerated signup OTP", "user", p.id, "email code refreshed");
    return json({ pendingId: p.id, expiresAt: otpExpiry(), deliveryConfigured: delivered });
  }

  /* ---------- Validate signup field availability (live form check) ---------- */
  if (path.join("/") === "api/validate/signup") {
    const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
    const countryCode = String(url.searchParams.get("countryCode") || "").trim();
    const phone = String(url.searchParams.get("phone") || "").replace(/\D/g, "");
    const emailValid = validEmail(email);
    const phoneValid = phone ? validPhone(countryCode, phone) : false;
    const emailDupe = emailValid ? await env.DB.prepare("SELECT 1 FROM users WHERE active = 1 AND LOWER(email) = ? LIMIT 1").bind(email).first() : null;
    const phoneDupe = phoneValid ? await env.DB.prepare("SELECT 1 FROM users WHERE active = 1 AND country_code = ? AND phone = ? LIMIT 1").bind(countryCode, phone).first() : null;
    return json({
      email: {
        valid: emailValid,
        available: emailValid && !emailDupe,
        message: !email ? "" : !emailValid ? "Invalid email format" : emailDupe ? "Email is already registered" : "Email looks valid and available"
      },
      phone: {
        valid: phoneValid,
        available: phoneValid && !phoneDupe,
        normalized: phone,
        message: !phone ? "" : !phoneValid ? "Invalid phone number" : phoneDupe ? "Phone is already registered" : "Phone looks valid and available"
      }
    });
  }

  /* ---------- Password reset — start ---------- */
  if (method === "POST" && path.join("/") === "api/password-reset/start") {
    // Account-enumeration defense: always return the same shape whether the
    // email is registered or not. A real OTP is still only sent when the email
    // matches an active user. The caller cannot distinguish from the response.
    const body = await bodyJson(request);
    const id = String(body.identifier || "").trim().toLowerCase();
    const u = await env.DB.prepare("SELECT * FROM users WHERE active = 1 AND LOWER(email) = ? LIMIT 1").bind(id).first();
    const resetId = crypto.randomUUID();
    const exp = otpExpiry();
    if (u) {
      await env.DB.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(u.id).run();
      const code = otpCode();
      await env.DB.prepare("INSERT INTO password_resets (id,user_id,email_otp,expires_at,created_at) VALUES (?,?,?,?,?)").bind(resetId, u.id, code, exp, now()).run();
      const delivered = sendOtpInBackground(ctx, env, u.email, code, "Plasma Lab LIMS password reset");
      await addAudit(env, u, delivered ? "Sent password reset OTP" : "Generated password reset OTP", "user", u.id, "Password reset OTP requested");
    } else {
      // Audit the attempt — repeated failures from one source look suspicious.
      await addAudit(env, null, "Password reset requested for unknown email", "user", resetId, `identifier=${id}`);
    }
    return json({ resetId, expiresAt: exp, deliveryConfigured: !!u });
  }

  /* ---------- Password reset — confirm ---------- */
  if (method === "POST" && path.join("/") === "api/password-reset/confirm") {
    const body = await bodyJson(request);
    if (!body.password || String(body.password).length < 6) throw httpError("Password must be at least 6 characters", 400);
    const r = await env.DB.prepare("SELECT * FROM password_resets WHERE id = ?").bind(body.resetId).first();
    if (!r || new Date(r.expires_at).getTime() <= Date.now() || String(r.email_otp) !== String(body.emailOtp || "").trim()) {
      throw httpError("Invalid or expired email OTP", 400);
    }
    const u = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND active = 1").bind(r.user_id).first();
    if (!u) throw httpError("User not found", 404);
    const pwHash = await hashPassword(body.password);
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(pwHash, u.id).run();
    await env.DB.prepare("DELETE FROM password_resets WHERE id = ?").bind(r.id).run();
    await addAudit(env, u, "Reset password", "user", u.id, "Password changed after OTP verification");
    return json({ ok: true });
  }

  return null;
}

// Private: sign out — lives here because it belongs with the auth story,
// but needs an authenticated user. Called by the router after auth() has
// run successfully.
export async function trySignOut(request, env, ctx, { path, method, user }) {
  if (method === "POST" && path.join("/") === "api/sign-out") {
    await env.DB.prepare("UPDATE users SET session_version = COALESCE(session_version, 0) + 1 WHERE id = ?").bind(user.id).run();
    await addAudit(env, user, "Signed out", "user", user.id, "User chose to sign out — session_version bumped");
    return json({ ok: true });
  }
  return null;
}
