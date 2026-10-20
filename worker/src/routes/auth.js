// Public auth routes: health, login, signup, OTP verification, password
// reset. Everything in this file is reachable without a session token.
//
// Security notes:
//   - Login: PBKDF2 verify runs on a dummy hash for unknown emails
//     (dummyVerifyPassword) so a timing side-channel cannot enumerate.
//     Rate-limited per IP and per email identifier.
//   - Signup start / /validate/signup: enumeration-safe — the response is
//     the same shape whether the email is registered or not. The real
//     duplicate-email check happens inside /signup/complete.
//   - OTP verify (signup + reset): wrong codes increment an attempts
//     counter on the OTP-bearing row; 5 wrong codes lock the row for
//     15 minutes and the OTP is wiped. Successful verify clears the OTP.
//   - OTP resend (signup + reset): 60s cooldown and 10/day cap per row.
//   - First-user bootstrap: a `meta.bootstrap_completed` flag replaces
//     the COUNT(users) check so a race cannot create two "first" admins
//     (migration 0004 seeds it from an existing users table).

import { json, bodyJson, now, httpError, rateLimit, rateLimitReset, clientIp } from "../lib/http.js";
import { hashPassword, verifyPassword, dummyVerifyPassword, signJwt, otpCode, otpExpiry, timingSafeEqual } from "../lib/crypto.js";
import { validEmail, validPhone } from "../lib/validators.js";
import { sendOtpInBackground, emailConfigured } from "../lib/email.js";
import { addAudit, rowToPublicUser } from "../lib/db.js";

// ---- Small helpers for OTP brute-force + resend cooldown ----

// Called before comparing an OTP: refuses if the row is currently locked.
function assertOtpNotLocked(row) {
  if (row.email_otp_locked_until && new Date(row.email_otp_locked_until).getTime() > Date.now()) {
    throw httpError("Too many wrong codes. Try again in 15 minutes.", 429);
  }
}

// Called when an OTP comparison fails. Increments attempts; after 5 wrong
// attempts, locks the row for 15 minutes and clears the OTP so the stale
// code cannot be used after the lock expires.
async function recordOtpFailure(env, table, id, prevAttempts) {
  const next = (prevAttempts || 0) + 1;
  if (next >= 5) {
    const lockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await env.DB.prepare(
      `UPDATE ${table} SET email_otp_attempts = ?, email_otp_locked_until = ?, email_otp = NULL WHERE id = ?`
    ).bind(next, lockUntil, id).run();
    throw httpError("Too many wrong codes. Try again in 15 minutes.", 429);
  }
  await env.DB.prepare(
    `UPDATE ${table} SET email_otp_attempts = ? WHERE id = ?`
  ).bind(next, id).run();
}

// Enforce 60s between resends and a 10/day cap. Returns the next
// daily_sent_count/date to persist. Throws 429 on overflow.
function enforceResendCooldown(row) {
  const nowMs = Date.now();
  if (row.last_sent_at && (nowMs - new Date(row.last_sent_at).getTime()) < 60 * 1000) {
    throw httpError("Please wait 60 seconds between resends.", 429);
  }
  const todayIso = new Date().toISOString().slice(0, 10);
  let count = Number(row.daily_sent_count || 0);
  if (row.daily_sent_date !== todayIso) count = 0;   // reset counter on a new day
  if (count >= 10) {
    throw httpError("Daily OTP limit reached. Try again tomorrow.", 429);
  }
  return { nextCount: count + 1, nextDate: todayIso };
}

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
    const ip = clientIp(request);
    // H4: throttle both the IP and the email bucket. 10 attempts / 10 min
    // per bucket — generous enough for a fat-fingered colleague, tight
    // enough to make online brute-force impractical.
    const ipKey = "login:ip:" + ip;
    const emailKey = "login:email:" + emailLower;
    const rlIp = await rateLimit(env, ipKey, { max: 10, intervalS: 600 });
    const rlEmail = await rateLimit(env, emailKey, { max: 10, intervalS: 600 });
    if (rlIp.limited || rlEmail.limited) {
      throw httpError("Too many sign-in attempts. Wait a few minutes and try again.", 429);
    }
    const anyUser = await env.DB.prepare(
      "SELECT * FROM users WHERE LOWER(email) = ? AND replaced_at IS NULL AND password_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1"
    ).bind(emailLower).first();
    // H4: when there's no row for this email, run a PBKDF2 against a dummy
    // hash so response time matches a real verify. Without this, the
    // "no such user" branch returns ~1000x faster than a real check and
    // leaks whether an email is registered.
    if (!anyUser) {
      await dummyVerifyPassword(body.password || "");
    }
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
    // Clear both rate-limit buckets on success so a legitimate user who
    // mistyped a few times isn't locked out after they get in.
    await rateLimitReset(env, ipKey);
    await rateLimitReset(env, emailKey);
    // Multi-device allowed. Token expires in 12h regardless of Remember Me —
    // the frontend drops it on browser close either way.
    // Bind the token to the user's current session_version so sign-out can
    // revoke every outstanding token for this account. Middleware refuses a
    // token whose sv doesn't match the user row.
    const token = await signJwt(
      { id: anyUser.id, sv: Number(anyUser.session_version || 0) },
      env.JWT_SECRET,
      12 * 60 * 60
    );
    return json({ token, user: rowToPublicUser(anyUser) });
  }

  /* ---------- Signup — email OTP start ---------- */
  if (method === "POST" && path.join("/") === "api/signup/email/start") {
    const body = await bodyJson(request);
    if (!body.name || !validEmail(body.email)) throw httpError("Name and valid email are required", 400);
    const emailLower = body.email.toLowerCase();
    // H3 enumeration defense: both branches add a 300-500ms random delay so
    // response time cannot distinguish "email in use" from "email new".
    await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
    const existing = await env.DB.prepare("SELECT 1 FROM users WHERE LOWER(email) = ? AND active = 1 LIMIT 1").bind(emailLower).first();
    if (existing) {
      // H3: do NOT reveal the email is taken. Return a plausible success
      // shape — no OTP is actually sent, no pending_signups row inserted.
      // The caller cannot distinguish; a genuine new user never reaches
      // this branch. The real duplicate check lives in /signup/complete.
      const fakeId = crypto.randomUUID();
      await addAudit(env, null, "Signup attempted for existing email (enumeration-safe)", "user", fakeId, `email=${emailLower}`);
      return json({ pendingId: fakeId, expiresAt: otpExpiry(), deliveryConfigured: emailConfigured(env) });
    }
    await env.DB.prepare("DELETE FROM pending_signups WHERE LOWER(email) = ?").bind(emailLower).run();
    const emailOtp = otpCode();
    const id = crypto.randomUUID();
    const todayIso = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO pending_signups (id,name,email,email_otp,email_verified,expires_at,created_at,last_sent_at,daily_sent_count,daily_sent_date) VALUES (?,?,?,?,0,?,?,?,?,?)"
    ).bind(id, body.name, body.email, emailOtp, otpExpiry(), now(), now(), 1, todayIso).run();
    const delivered = sendOtpInBackground(ctx, env, body.email, emailOtp, "Plasma Lab LIMS signup verification");
    await addAudit(env, null, delivered ? "Sent signup email OTP" : "Generated signup OTP", "user", id, `${body.name} requested email verification`);
    return json({ pendingId: id, expiresAt: otpExpiry(), deliveryConfigured: delivered });
  }

  /* ---------- Signup — email OTP verify ---------- */
  if (method === "POST" && path.join("/") === "api/signup/email/verify") {
    const body = await bodyJson(request);
    const p = await env.DB.prepare("SELECT * FROM pending_signups WHERE id = ?").bind(body.pendingId).first();
    if (!p || new Date(p.expires_at).getTime() <= Date.now()) {
      throw httpError("Invalid or expired email OTP", 400);
    }
    // C1 brute-force defense: refuse if the row is locked; otherwise compare
    // in constant time and record failures. 5 wrong codes → 15-min lockout.
    assertOtpNotLocked(p);
    if (!p.email_otp || !timingSafeEqual(String(p.email_otp), String(body.emailOtp || "").trim())) {
      await recordOtpFailure(env, "pending_signups", p.id, p.email_otp_attempts);
      throw httpError("Invalid or expired email OTP", 400);
    }
    // L3: null out the consumed OTP, reset the attempts counter. Verified
    // flag drives the next step.
    await env.DB.prepare(
      "UPDATE pending_signups SET email_verified = 1, email_otp = NULL, email_otp_attempts = 0, email_otp_locked_until = NULL, expires_at = ? WHERE id = ?"
    ).bind(otpExpiry(), body.pendingId).run();
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
    if (!body.password || String(body.password).length < 10) throw httpError("Password must be at least 10 characters.", 400);
    if (body.password !== body.confirmPassword) throw httpError("Passwords do not match", 400);
    // Mark any previous unactive users with this email as replaced
    await env.DB.prepare("UPDATE users SET replaced_at = ?, replaced_by_email = ? WHERE LOWER(email) = ? AND active = 0")
      .bind(now(), p.email, p.email.toLowerCase()).run();
    // L7: the first-user bootstrap used to read COUNT(users)=0, which races
    // under concurrent requests. Migration 0004 adds a `meta` table with a
    // `bootstrap_completed` flag seeded when any user row already exists.
    const metaRow = await env.DB.prepare("SELECT value FROM meta WHERE key = 'bootstrap_completed'").first();
    const isFirstUser = !metaRow || metaRow.value !== "1";
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
    if (isFirstUser) {
      // Set the flag so subsequent signups go through the approval path
      // even if their /signup/complete race-arrives before the user row
      // is visible to the COUNT.
      await env.DB.prepare(
        "INSERT OR REPLACE INTO meta (key,value,updated_at) VALUES ('bootstrap_completed','1',?)"
      ).bind(now()).run();
    }
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
    // H5: 60s cooldown + 10/day cap. Throws 429 on overflow.
    const { nextCount, nextDate } = enforceResendCooldown(p);
    const emailOtp = otpCode();
    await env.DB.prepare(
      "UPDATE pending_signups SET email_otp = ?, email_otp_attempts = 0, email_otp_locked_until = NULL, expires_at = ?, last_sent_at = ?, daily_sent_count = ?, daily_sent_date = ? WHERE id = ?"
    ).bind(emailOtp, otpExpiry(), now(), nextCount, nextDate, p.id).run();
    const delivered = sendOtpInBackground(ctx, env, p.email, emailOtp, "Plasma Lab LIMS signup verification");
    await addAudit(env, null, delivered ? "Resent signup OTP" : "Regenerated signup OTP", "user", p.id, "email code refreshed");
    return json({ pendingId: p.id, expiresAt: otpExpiry(), deliveryConfigured: delivered });
  }

  /* ---------- Validate signup field availability (live form check) ---------- */
  if (path.join("/") === "api/validate/signup") {
    // H3: this endpoint used to confirm whether an email/phone was already
    // registered. That was a drive-by enumeration oracle. The real duplicate
    // check now runs server-side at /signup/email/start (and /signup/complete
    // for the race window) — the response here always claims "available".
    // The frontend still validates format locally.
    const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
    const countryCode = String(url.searchParams.get("countryCode") || "").trim();
    const phone = String(url.searchParams.get("phone") || "").replace(/\D/g, "");
    const emailValid = validEmail(email);
    const phoneValid = phone ? validPhone(countryCode, phone) : false;
    return json({
      email: {
        valid: emailValid,
        available: true,
        message: !email ? "" : !emailValid ? "Invalid email format" : ""
      },
      phone: {
        valid: phoneValid,
        available: true,
        normalized: phone,
        message: !phone ? "" : !phoneValid ? "Invalid phone number" : ""
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
      // H5: 60s resend cooldown on the previous reset row (if any).
      const prior = await env.DB.prepare("SELECT last_sent_at FROM password_resets WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").bind(u.id).first();
      if (prior?.last_sent_at && (Date.now() - new Date(prior.last_sent_at).getTime()) < 60 * 1000) {
        throw httpError("Please wait 60 seconds between resends.", 429);
      }
      await env.DB.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(u.id).run();
      const code = otpCode();
      await env.DB.prepare(
        "INSERT INTO password_resets (id,user_id,email_otp,expires_at,created_at,last_sent_at) VALUES (?,?,?,?,?,?)"
      ).bind(resetId, u.id, code, exp, now(), now()).run();
      const delivered = sendOtpInBackground(ctx, env, u.email, code, "Plasma Lab LIMS password reset");
      await addAudit(env, u, delivered ? "Sent password reset OTP" : "Generated password reset OTP", "user", u.id, "Password reset OTP requested");
    } else {
      // Audit the attempt — repeated failures from one source look suspicious.
      await addAudit(env, null, "Password reset requested for unknown email", "user", resetId, `identifier=${id}`);
    }
    // Enumeration-safe: deliveryConfigured describes the server's email
    // config, not whether the email is registered. Both branches above return
    // the same shape here.
    return json({ resetId, expiresAt: exp, deliveryConfigured: emailConfigured(env) });
  }

  /* ---------- Password reset — confirm ---------- */
  if (method === "POST" && path.join("/") === "api/password-reset/confirm") {
    const body = await bodyJson(request);
    if (!body.password || String(body.password).length < 10) throw httpError("Password must be at least 10 characters.", 400);
    const r = await env.DB.prepare("SELECT * FROM password_resets WHERE id = ?").bind(body.resetId).first();
    if (!r || new Date(r.expires_at).getTime() <= Date.now()) {
      throw httpError("Invalid or expired email OTP", 400);
    }
    // C1 brute-force defense mirrors /signup/email/verify.
    assertOtpNotLocked(r);
    if (!r.email_otp || !timingSafeEqual(String(r.email_otp), String(body.emailOtp || "").trim())) {
      await recordOtpFailure(env, "password_resets", r.id, r.email_otp_attempts);
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
