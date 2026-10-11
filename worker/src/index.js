// Plasma Lab LIMS — Cloudflare Worker (D1-backed, Phase 2)
//
// Reads/writes a normalized D1 database (env.DB) instead of the old
// single-JSON-blob in Neon. Response shapes are preserved exactly so the
// frontend doesn't need to change. Photos still ride base64 in sample_files
// during Phase 2 — Phase 3 moves bytes to R2 (env.MEDIA) with a URL column.

import QRCode from "qrcode";

const APP_NAME = "Plasma Lab LIMS";
const PASSWORD_ITERATIONS = 100000;

/* ------------------------------------------------------------------------ */
/* HTTP helpers                                                              */
/* ------------------------------------------------------------------------ */

const json = (body, init = {}) => new Response(JSON.stringify(body), {
  ...init,
  headers: { "content-type": "application/json", ...(init.headers || {}) }
});

const html = (body, init = {}) => new Response(body, {
  ...init,
  headers: { "content-type": "text/html; charset=utf-8", ...(init.headers || {}) }
});

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const allowed = String(env.ALLOWED_ORIGINS || env.FRONTEND_PUBLIC_URL || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (!origin || (allowed.length && !allowed.includes(origin))) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "vary": "Origin"
  };
}

function now() { return new Date().toISOString(); }
function addDays(d, days) { const r = new Date(d); r.setDate(r.getDate() + days); return r.toISOString(); }
function parsePath(url) { return url.pathname.split("/").filter(Boolean); }
async function bodyJson(request) {
  if (!request.headers.get("content-type")?.includes("application/json")) return {};
  return request.json();
}

/* ------------------------------------------------------------------------ */
/* Crypto / auth helpers (same as before)                                   */
/* ------------------------------------------------------------------------ */

function b64url(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new TextEncoder().encode(String(input));
  let bin = ""; bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function fromB64url(v) {
  const padded = v.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(v.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
async function signJwt(payload, secret, exp = 12 * 60 * 60) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + exp }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}
async function verifyJwt(token, secret) {
  const [h, b, s] = String(token || "").split(".");
  if (!h || !b || !s) throw new Error("Invalid session");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${b}`)));
  if (expected !== s) throw new Error("Invalid session");
  const payload = JSON.parse(new TextDecoder().decode(fromB64url(b)));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Session expired");
  return payload;
}
async function hashPassword(pwd) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pwd), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PASSWORD_ITERATIONS, hash: "SHA-256" }, key, 256);
  return `pbkdf2$${PASSWORD_ITERATIONS}$${b64url(salt.buffer)}$${b64url(bits)}`;
}
async function verifyPassword(pwd, stored) {
  if (!stored?.startsWith("pbkdf2$")) return false;
  const [, iter, saltText, hashText] = stored.split("$");
  const salt = fromB64url(saltText);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pwd), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: Number(iter), hash: "SHA-256" }, key, 256);
  return b64url(bits) === hashText;
}

function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || "").trim()); }
function validPhone(cc, phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return /^\+\d{1,4}$/.test(String(cc || "")) && digits.length >= 6 && digits.length <= 15;
}
function otpCode() { return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0"); }
function otpExpiry() { return addDays(now(), 1); }

/* ------------------------------------------------------------------------ */
/* Email delivery (unchanged)                                                */
/* ------------------------------------------------------------------------ */

async function sendOtpEmail(env, to, otp, subject = "Plasma Lab LIMS verification code") {
  if (env.RESEND_API_KEY && env.SMTP_FROM) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: `${env.SMTP_FROM_NAME || "Plasma Lab LIMS"} <${env.SMTP_FROM}>`,
        to: [to], subject,
        text: `Your Plasma Lab LIMS OTP is ${otp}. This code expires in 24 hours.`
      })
    });
    if (!r.ok) throw new Error(`Email delivery failed: ${await r.text()}`);
    return true;
  }
  if (env.GMAIL_APPS_SCRIPT_URL) {
    const r = await fetch(env.GMAIL_APPS_SCRIPT_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, otp, subject })
    });
    if (!r.ok) throw new Error("Gmail email delivery failed");
    return true;
  }
  return false;
}
function emailConfigured(env) { return Boolean((env.RESEND_API_KEY && env.SMTP_FROM) || env.GMAIL_APPS_SCRIPT_URL); }
function sendOtpInBackground(ctx, env, to, otp, subject) {
  if (!emailConfigured(env)) return false;
  const task = sendOtpEmail(env, to, otp, subject).catch(e =>
    console.error(JSON.stringify({ event: "otp_email_failed", to, error: e.message }))
  );
  if (ctx?.waitUntil) ctx.waitUntil(task); else void task;
  return true;
}

/* ------------------------------------------------------------------------ */
/* D1 row helpers                                                            */
/* ------------------------------------------------------------------------ */

const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// Convert a D1 users row to the publicUser shape the frontend expects.
function rowToPublicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, email: u.email,
    phone: u.phone || "", countryCode: u.country_code || "",
    role: u.role, active: Boolean(u.active),
    approvalStatus: u.approval_status || (u.active ? "approved" : "deactivated"),
    signedUpAt: u.signed_up_at || null,
    approvedAt: u.approved_at || null, approvedBy: u.approved_by || null,
    rejectedAt: u.rejected_at || null, rejectedBy: u.rejected_by || null,
    rejectionReason: u.rejection_reason || null,
    createdAt: u.created_at
  };
}

// Full sample shape (with results/files/custody arrays) that the frontend
// receives. Pass preloaded children arrays so bulk endpoints can batch.
function rowToSample(s, { results = [], files = [], custody = [] } = {}) {
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

function rowToResult(r) {
  return {
    id: r.id, parameter: r.parameter, value: r.value || "",
    unit: r.unit || "", limit: r.limit || "", method: r.method || "",
    flag: r.flag || "OK", analyst: r.analyst || "",
    replicates: parseJson(r.replicates, null),
    avg: r.avg, stddev: r.stddev, msg: r.msg,
    enteredAt: r.entered_at
  };
}

function rowToFile(f) {
  return {
    id: f.id, originalName: f.original_name || "",
    category: f.category || "Uploaded File",
    url: f.data_url || (f.r2_key ? `/api/media/${f.r2_key}` : ""),
    size: f.size_bytes || 0, mimeType: f.mime_type,
    lat: f.lat, lng: f.lng, takenAt: f.taken_at,
    uploadedBy: f.uploaded_by || "", uploadedAt: f.uploaded_at
  };
}

function rowToCustody(c) {
  return {
    at: c.at, by: c.by_name || "", action: c.action,
    fromLocationId: c.from_location_id, toLocationId: c.to_location_id,
    locationId: c.location_id, note: c.note || ""
  };
}

// Load a sample + all its children in 4 queries, assemble.
async function loadSampleFull(env, sampleId) {
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

// Load many samples + hydrate children in 4 queries total. Scales to the
// whole table without N+1.
async function loadSamplesFull(env, { whereSql = "", whereArgs = [], limit = 500 } = {}) {
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
    results: resultsById[s.id] || [], files: filesById[s.id] || [], custody: custodyById[s.id] || []
  }));
}

async function addAudit(env, user, action, entity, entityId, detail) {
  await env.DB.prepare(
    "INSERT INTO audit_log (id,at,user_id,user_name,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(
    crypto.randomUUID(), now(),
    user?.id || "system", user?.name || "System",
    action, entity, entityId || null, detail || null
  ).run();
}

async function nextSampleCode(env) {
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

async function storageIsAvailable(env, id, currentId = "") {
  if (!id) return true;
  const loc = await env.DB.prepare("SELECT * FROM storage_locations WHERE id = ?").bind(id).first();
  if (!loc || !loc.active) return false;
  return !loc.is_full || id === currentId;
}

/* ------------------------------------------------------------------------ */
/* Auth middleware                                                           */
/* ------------------------------------------------------------------------ */

async function auth(request, env) {
  const token = (request.headers.get("authorization") || "").replace("Bearer ", "") || new URL(request.url).searchParams.get("token");
  if (!token) throw Object.assign(new Error("Login required"), { status: 401 });
  const payload = await verifyJwt(token, env.JWT_SECRET || "change-this-before-production");
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND active = 1").bind(payload.id).first();
  if (!user) throw Object.assign(new Error("Invalid user"), { status: 401 });
  // Multi-device allowed: no sessionVersion enforcement. Same account can
  // have multiple active tokens at once (phone + desktop + another phone).
  return { user };
}

function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) throw Object.assign(new Error("Not allowed"), { status: 403 });
}

function canReadSample(user, sample) {
  if (user.role === "admin") return true;
  if (user.role === "analyst") return sample.active !== false && !sample.archived_at;
  return false;
}
function normalizeAssignedTo(v) {
  const names = String(v || "").split(",").map(x => x.trim()).filter(Boolean);
  const unique = [...new Set(names)];
  if (unique.length > 2) {
    throw Object.assign(new Error("At most 2 analysts can be assigned to a sample"), { status: 400 });
  }
  return unique.join(", ");
}
// assignedTo may now hold multiple analyst names, comma-separated (e.g.
// "Amrutha Shanbhag, Anshika M"). An analyst can work on the sample if
// their name appears in the list — this is how the lab's two-person
// replicate flow works: 2 replicates by one analyst, 1 by another.
function assignedNames(sample) {
  return String(sample?.assigned_to || sample?.assignedTo || "")
    .split(",").map(s => s.trim()).filter(Boolean);
}
function canWorkOnSample(user, sample) {
  if (user.role === "admin") return true;
  if (user.role === "analyst") return assignedNames(sample).includes(user.name);
  return false;
}

/* ------------------------------------------------------------------------ */
/* Main handler                                                              */
/* ------------------------------------------------------------------------ */

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = parsePath(url);
  const method = request.method;

  if (path.join("/") === "api/health") {
    const [sCount, uCount] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM samples").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()
    ]);
    return json({ ok: true, service: "Plasma Lab LIMS Worker API", database: "Cloudflare D1", samples: sCount.n, users: uCount.n });
  }

  /* --- Login --- */
  if (method === "POST" && path.join("/") === "api/login") {
    const body = await bodyJson(request);
    const emailLower = String(body.email || "").toLowerCase();
    const anyUser = await env.DB.prepare(
      "SELECT * FROM users WHERE LOWER(email) = ? AND replaced_at IS NULL AND password_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1"
    ).bind(emailLower).first();
    if (!anyUser || !(await verifyPassword(body.password || "", anyUser.password_hash))) {
      throw Object.assign(new Error("Invalid email or password"), { status: 401 });
    }
    if (anyUser.approval_status === "pending") throw Object.assign(new Error("Your account is awaiting admin approval. You'll be able to sign in once an admin approves it."), { status: 403, approvalStatus: "pending" });
    if (anyUser.approval_status === "rejected") throw Object.assign(new Error("Your account request was declined. Contact the lab administrator."), { status: 403 });
    if (!anyUser.active) throw Object.assign(new Error("This account is deactivated. Contact the lab administrator."), { status: 403 });
    await env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now(), anyUser.id).run();
    await addAudit(env, anyUser, "Logged in", "user", anyUser.id, "User session started");
    // Multi-device allowed. Token expires in 12h regardless of Remember Me
    // because the frontend will drop it on browser close either way.
    const token = await signJwt({ id: anyUser.id }, env.JWT_SECRET || "change-this-before-production", 12 * 60 * 60);
    return json({ token, user: rowToPublicUser(anyUser) });
  }

  /* --- Signup email start --- */
  if (method === "POST" && path.join("/") === "api/signup/email/start") {
    const body = await bodyJson(request);
    if (!body.name || !validEmail(body.email)) throw Object.assign(new Error("Name and valid email are required"), { status: 400 });
    const emailLower = body.email.toLowerCase();
    const existing = await env.DB.prepare("SELECT 1 FROM users WHERE LOWER(email) = ? AND active = 1 LIMIT 1").bind(emailLower).first();
    if (existing) throw Object.assign(new Error("Email already exists"), { status: 409 });
    // Clear previous pending for this email
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

  /* --- Signup email verify --- */
  if (method === "POST" && path.join("/") === "api/signup/email/verify") {
    const body = await bodyJson(request);
    const p = await env.DB.prepare("SELECT * FROM pending_signups WHERE id = ?").bind(body.pendingId).first();
    if (!p || new Date(p.expires_at).getTime() <= Date.now() || String(p.email_otp) !== String(body.emailOtp || "").trim()) {
      throw Object.assign(new Error("Invalid or expired email OTP"), { status: 400 });
    }
    await env.DB.prepare("UPDATE pending_signups SET email_verified = 1, expires_at = ? WHERE id = ?").bind(otpExpiry(), body.pendingId).run();
    return json({ pendingId: body.pendingId, ok: true });
  }

  /* --- Signup phone save --- */
  if (method === "POST" && path.join("/") === "api/signup/phone/save") {
    const body = await bodyJson(request);
    const p = await env.DB.prepare("SELECT * FROM pending_signups WHERE id = ?").bind(body.pendingId).first();
    if (!p || !p.email_verified) throw Object.assign(new Error("Verify email first"), { status: 400 });
    if (!validPhone(body.countryCode, body.phone)) throw Object.assign(new Error("Enter a valid country code and phone number"), { status: 400 });
    const phoneDigits = String(body.phone).replace(/\D/g, "");
    const dupe = await env.DB.prepare(
      "SELECT 1 FROM users WHERE active = 1 AND country_code = ? AND phone = ? LIMIT 1"
    ).bind(String(body.countryCode), phoneDigits).first();
    if (dupe) throw Object.assign(new Error("Phone already exists"), { status: 409 });
    await env.DB.prepare("UPDATE pending_signups SET country_code = ?, phone = ?, expires_at = ? WHERE id = ?")
      .bind(body.countryCode, phoneDigits, otpExpiry(), body.pendingId).run();
    return json({ pendingId: body.pendingId, ok: true });
  }

  /* --- Signup complete (approval gate) --- */
  if (method === "POST" && path.join("/") === "api/signup/complete") {
    const body = await bodyJson(request);
    const p = await env.DB.prepare("SELECT * FROM pending_signups WHERE id = ?").bind(body.pendingId).first();
    if (!p || !p.email_verified || !p.phone) throw Object.assign(new Error("Verify email and enter phone before creating password"), { status: 400 });
    if (!body.password || String(body.password).length < 6) throw Object.assign(new Error("Password must be at least 6 characters"), { status: 400 });
    if (body.password !== body.confirmPassword) throw Object.assign(new Error("Passwords do not match"), { status: 400 });
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
      const token = await signJwt({ id, sv: 0 }, env.JWT_SECRET || "change-this-before-production", 12 * 60 * 60);
      return json({ token, user: rowToPublicUser(user), approvalStatus: "approved" });
    }
    return json({ approvalStatus: "pending", user: rowToPublicUser(user), message: "Account created — awaiting admin approval before you can sign in." });
  }

  /* --- Signup resend --- */
  if (method === "POST" && path.join("/") === "api/signup/resend") {
    const body = await bodyJson(request);
    const p = await env.DB.prepare("SELECT * FROM pending_signups WHERE id = ?").bind(body.pendingId).first();
    if (!p) throw Object.assign(new Error("Signup request not found"), { status: 404 });
    const emailOtp = otpCode();
    await env.DB.prepare("UPDATE pending_signups SET email_otp = ?, expires_at = ? WHERE id = ?").bind(emailOtp, otpExpiry(), p.id).run();
    const delivered = sendOtpInBackground(ctx, env, p.email, emailOtp, "Plasma Lab LIMS signup verification");
    await addAudit(env, null, delivered ? "Resent signup OTP" : "Regenerated signup OTP", "user", p.id, "email code refreshed");
    return json({ pendingId: p.id, expiresAt: otpExpiry(), deliveryConfigured: delivered });
  }

  /* --- Validate signup (email/phone availability) --- */
  if (path.join("/") === "api/validate/signup") {
    const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
    const countryCode = String(url.searchParams.get("countryCode") || "").trim();
    const phone = String(url.searchParams.get("phone") || "").replace(/\D/g, "");
    const emailValid = validEmail(email);
    const phoneValid = phone ? validPhone(countryCode, phone) : false;
    const emailDupe = emailValid ? await env.DB.prepare("SELECT 1 FROM users WHERE active = 1 AND LOWER(email) = ? LIMIT 1").bind(email).first() : null;
    const phoneDupe = phoneValid ? await env.DB.prepare("SELECT 1 FROM users WHERE active = 1 AND country_code = ? AND phone = ? LIMIT 1").bind(countryCode, phone).first() : null;
    return json({
      email: { valid: emailValid, available: emailValid && !emailDupe, message: !email ? "" : !emailValid ? "Invalid email format" : emailDupe ? "Email is already registered" : "Email looks valid and available" },
      phone: { valid: phoneValid, available: phoneValid && !phoneDupe, normalized: phone, message: !phone ? "" : !phoneValid ? "Invalid phone number" : phoneDupe ? "Phone is already registered" : "Phone looks valid and available" }
    });
  }

  /* --- Password reset --- */
  if (method === "POST" && path.join("/") === "api/password-reset/start") {
    const body = await bodyJson(request);
    const id = String(body.identifier || "").trim().toLowerCase();
    const u = await env.DB.prepare("SELECT * FROM users WHERE active = 1 AND LOWER(email) = ? LIMIT 1").bind(id).first();
    if (!u) throw Object.assign(new Error("No matching registered user found"), { status: 404 });
    await env.DB.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(u.id).run();
    const resetId = crypto.randomUUID(), code = otpCode();
    await env.DB.prepare("INSERT INTO password_resets (id,user_id,email_otp,expires_at,created_at) VALUES (?,?,?,?,?)").bind(resetId, u.id, code, otpExpiry(), now()).run();
    const delivered = sendOtpInBackground(ctx, env, u.email, code, "Plasma Lab LIMS password reset");
    await addAudit(env, u, delivered ? "Sent password reset OTP" : "Generated password reset OTP", "user", u.id, "Password reset OTP requested");
    return json({ resetId, expiresAt: otpExpiry(), deliveryConfigured: delivered });
  }
  if (method === "POST" && path.join("/") === "api/password-reset/confirm") {
    const body = await bodyJson(request);
    if (!body.password || String(body.password).length < 6) throw Object.assign(new Error("Password must be at least 6 characters"), { status: 400 });
    const r = await env.DB.prepare("SELECT * FROM password_resets WHERE id = ?").bind(body.resetId).first();
    if (!r || new Date(r.expires_at).getTime() <= Date.now() || String(r.email_otp) !== String(body.emailOtp || "").trim()) {
      throw Object.assign(new Error("Invalid or expired email OTP"), { status: 400 });
    }
    const u = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND active = 1").bind(r.user_id).first();
    if (!u) throw Object.assign(new Error("User not found"), { status: 404 });
    const pwHash = await hashPassword(body.password);
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(pwHash, u.id).run();
    await env.DB.prepare("DELETE FROM password_resets WHERE id = ?").bind(r.id).run();
    await addAudit(env, u, "Reset password", "user", u.id, "Password changed after OTP verification");
    return json({ ok: true });
  }

  /* ======================================================================== */
  /* Everything below requires auth                                            */
  /* ======================================================================== */

  const { user } = await auth(request, env);

  /* --- Bootstrap --- */
  if (method === "GET" && path.join("/") === "api/bootstrap") {
    const whereParts = ["(archived_at IS NULL OR archived_at = '')"];
    const whereArgs = [];
    if (user.role === "analyst") {
      whereParts.push("active = 1");
    }
    const samples = await loadSamplesFull(env, {
      whereSql: whereParts.join(" AND "),
      whereArgs,
      limit: 2000
    });
    const [people, storage, tests, usersRows, auditRows] = await Promise.all([
      env.DB.prepare("SELECT * FROM people ORDER BY name").all(),
      env.DB.prepare("SELECT * FROM storage_locations ORDER BY name").all(),
      env.DB.prepare("SELECT * FROM tests ORDER BY name").all(),
      user.role === "admin" ? env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all() : Promise.resolve({ results: [] }),
      user.role === "admin" ? env.DB.prepare("SELECT * FROM audit_log ORDER BY at DESC LIMIT 200").all() : Promise.resolve({ results: [] })
    ]);
    return json({
      user: rowToPublicUser(user),
      users: (usersRows.results || []).map(rowToPublicUser),
      people: (people.results || []).map(p => ({ id: p.id, name: p.name, role: p.role, active: Boolean(p.active) })),
      storageLocations: (storage.results || []).map(s => ({ id: s.id, name: s.name, type: s.type, active: Boolean(s.active), isFull: Boolean(s.is_full), capacityNote: s.capacity_note || "" })),
      tests: (tests.results || []).map(t => ({ id: t.id, name: t.name, unit: t.unit, limit: t.limit, method: t.method })),
      samples,
      audit: (auditRows.results || []).map(a => ({ id: a.id, at: a.at, userId: a.user_id, userName: a.user_name, action: a.action, entity: a.entity, entityId: a.entity_id, detail: a.detail })),
      alerts: {
        overdue: samples.filter(s => s.status !== "Approved" && s.status !== "Disposed" && new Date(s.dueAt || 0).getTime() < Date.now()),
        dueSoon: samples.filter(s => s.status !== "Approved" && s.status !== "Disposed" && new Date(s.dueAt || 0).getTime() - Date.now() < 24*60*60*1000 && new Date(s.dueAt || 0).getTime() >= Date.now()),
        waitingUpload: samples.filter(s => !(s.files || []).some(f => f.category?.includes("Written Record") || f.category?.includes("Book"))),
        waitingApproval: samples.filter(s => s.status === "Needs Review" || s.status === "Results Entered"),
        disposalReady: samples.filter(s => s.status === "Approved" && s.retentionStatus === "Active")
      },
      files: [],
      health: user.role === "admin" ? { database: "Cloudflare D1", samples: samples.length, users: (usersRows.results || []).length, auditEntries: (auditRows.results || []).length, uploadedFiles: samples.reduce((n, s) => n + (s.files || []).length, 0), storage: "D1 + R2" } : null
    });
  }

  /* --- Users admin --- */
  if (method === "POST" && path.join("/") === "api/users") {
    requireRole(user, "admin");
    const body = await bodyJson(request);
    if (!["admin", "analyst"].includes(body.role)) throw Object.assign(new Error("Choose admin/manager or analyst"), { status: 400 });
    const dupe = await env.DB.prepare("SELECT 1 FROM users WHERE active = 1 AND LOWER(email) = ? LIMIT 1").bind(String(body.email).toLowerCase()).first();
    if (dupe) throw Object.assign(new Error("Email already exists"), { status: 409 });
    const id = crypto.randomUUID();
    const pwHash = await hashPassword(body.password);
    await env.DB.prepare(`
      INSERT INTO users (id,name,email,phone,country_code,password_hash,role,active,approval_status,approved_at,approved_by,created_at)
      VALUES (?,?,?,?,?,?,?,1,'approved',?,?,?)
    `).bind(id, body.name, body.email, body.phone || "", body.countryCode || "", pwHash, body.role, now(), user.name, now()).run();
    const created = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    await addAudit(env, user, "Created user", "user", id, `${body.name} added as ${body.role}`);
    return json(rowToPublicUser(created));
  }

  if (method === "POST" && path[0] === "api" && path[1] === "users" && path[3] === "approve") {
    requireRole(user, "admin");
    const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(path[2]).first();
    if (!target) throw Object.assign(new Error("User not found"), { status: 404 });
    if (target.approval_status !== "pending") throw Object.assign(new Error(`Cannot approve — user status is "${target.approval_status}"`), { status: 400 });
    const body = await bodyJson(request);
    const role = body.role && ["admin", "analyst"].includes(body.role) ? body.role : target.role;
    await env.DB.prepare("UPDATE users SET role = ?, approval_status = 'approved', approved_at = ?, approved_by = ?, active = 1 WHERE id = ?")
      .bind(role, now(), user.name, target.id).run();
    const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(target.id).first();
    await addAudit(env, user, "Approved user", "user", target.id, `${target.name} approved as ${role}`);
    return json(rowToPublicUser(updated));
  }

  if (method === "POST" && path[0] === "api" && path[1] === "users" && path[3] === "reject") {
    requireRole(user, "admin");
    const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(path[2]).first();
    if (!target) throw Object.assign(new Error("User not found"), { status: 404 });
    if (target.approval_status !== "pending") throw Object.assign(new Error(`Cannot reject — user status is "${target.approval_status}"`), { status: 400 });
    const body = await bodyJson(request);
    const reason = String(body.reason || "").slice(0, 500);
    await env.DB.prepare("UPDATE users SET approval_status = 'rejected', active = 0, rejected_at = ?, rejected_by = ?, rejection_reason = ? WHERE id = ?")
      .bind(now(), user.name, reason, target.id).run();
    const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(target.id).first();
    await addAudit(env, user, "Rejected user signup", "user", target.id, `${target.name}${reason ? ` — ${reason}` : ""}`);
    return json(rowToPublicUser(updated));
  }

  if (method === "PATCH" && path[0] === "api" && path[1] === "users") {
    requireRole(user, "admin");
    const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(path[2]).first();
    if (!target) throw Object.assign(new Error("User not found"), { status: 404 });
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

  if (method === "DELETE" && path[0] === "api" && path[1] === "users") {
    requireRole(user, "admin");
    const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(path[2]).first();
    if (!target) throw Object.assign(new Error("User not found"), { status: 404 });
    if (target.id === user.id) throw Object.assign(new Error("You cannot delete your own login"), { status: 400 });
    await env.DB.prepare("UPDATE users SET active = 0, deleted_at = ?, deleted_by = ? WHERE id = ?").bind(now(), user.name, target.id).run();
    const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(target.id).first();
    return json(rowToPublicUser(updated));
  }

  /* --- Master data (people / storage-locations / tests) --- */
  const masterRoutes = { people: "people", "storage-locations": "storage_locations", tests: "tests" };
  if (path[0] === "api" && masterRoutes[path[1]]) {
    requireRole(user, "admin");
    const table = masterRoutes[path[1]];
    if (method === "POST") {
      const body = await bodyJson(request);
      const id = crypto.randomUUID();
      if (table === "people") {
        await env.DB.prepare("INSERT INTO people (id,name,role,active,created_at) VALUES (?,?,?,1,?)").bind(id, body.name, body.role || "Analyst", now()).run();
      } else if (table === "storage_locations") {
        await env.DB.prepare("INSERT INTO storage_locations (id,name,type,active,is_full,capacity_note) VALUES (?,?,?,1,?,?)").bind(id, body.name, body.type || "Storage", body.isFull ? 1 : 0, body.capacityNote || "").run();
      } else if (table === "tests") {
        await env.DB.prepare('INSERT INTO tests (id,name,unit,"limit",method) VALUES (?,?,?,?,?)').bind(id, body.name, body.unit || "", body.limit || "", body.method || "").run();
      }
      await addAudit(env, user, `Added ${path[1]}`, path[1], id, body.name || "");
      const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      return json(row);
    }
    if (method === "PATCH") {
      const body = await bodyJson(request);
      const parts = [], args = [];
      for (const [k, v] of Object.entries(body)) {
        // Map camelCase to snake_case + whitelist
        const col = k === "isFull" ? "is_full" : k === "capacityNote" ? "capacity_note" : k;
        if (!["name", "role", "active", "type", "is_full", "capacity_note", "unit", "limit", "method"].includes(col)) continue;
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
  }

  /* --- Samples: create --- */
  if (method === "POST" && path.join("/") === "api/samples") {
    requireRole(user, "admin");
    const body = await bodyJson(request);
    if (!body.clientName || !body.collectionSite || !body.sourceType || !body.collector) throw Object.assign(new Error("Project/client, site, source type, and brought by are required"), { status: 400 });
    if (!Array.isArray(body.requestedTests) || body.requestedTests.length === 0) throw Object.assign(new Error("Choose at least one requested test"), { status: 400 });
    if (!(await storageIsAvailable(env, body.storageLocationId))) throw Object.assign(new Error("Selected storage is full or inactive"), { status: 400 });
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
    await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,location_id,note) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(), id, now(), user.name, "Bottle labelled", body.storageLocationId || null, "").run();
    await addAudit(env, user, "Prepared bottle label", "sample", id, `${code} created`);
    return json(await loadSampleFull(env, id));
  }

  /* --- Samples: bulk create --- */
  if (method === "POST" && path.join("/") === "api/samples/bulk") {
    requireRole(user, "admin");
    const body = await bodyJson(request);
    const created = [], errors = [];
    const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 250);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        if (!row.clientName || !row.collectionSite || !row.sourceType || !row.collector) throw new Error("Project/client, site, source type, and brought by are required");
        if (!Array.isArray(row.requestedTests) || row.requestedTests.length === 0) throw new Error("Choose at least one requested test");
        if (!(await storageIsAvailable(env, row.storageLocationId))) throw new Error("Selected storage is full or inactive");
        const id = crypto.randomUUID();
        const code = await nextSampleCode(env);
        const dueAt = row.dueAt || addDays(now(), 3);
        await env.DB.prepare(`
          INSERT INTO samples (id,sample_code,status,workflow_stage,client_name,source_type,collection_site,collector,received_by,received_at,storage_location_id,assigned_to,requested_tests,notes,planned_sampling_date,due_at,retention_status,active,created_at,updated_at)
          VALUES (?,?,'Bottle Ready','Bottle Ready',?,?,?,?,?,?,?,?,?,?,?,?,'Active',1,?,?)
        `).bind(id, code, row.clientName, row.sourceType, row.collectionSite, row.collector, user.name, now(), row.storageLocationId || null, normalizeAssignedTo(row.assignedTo), JSON.stringify(row.requestedTests), row.notes || "", row.plannedSamplingDate || "", dueAt, now(), now()).run();
        await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,location_id,note) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(), id, now(), user.name, "Bottle labelled", row.storageLocationId || null, "").run();
        created.push(await loadSampleFull(env, id));
      } catch (e) {
        errors.push({ row: i + 1, error: e.message });
      }
    }
    if (!created.length) throw Object.assign(new Error("No samples could be created"), { status: 400, errors });
    await addAudit(env, user, "Bulk created samples", "sample", "bulk", `${created.length} samples created`);
    return json({ created, errors });
  }

  /* --- Samples: field collect --- */
  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "collect") {
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(path[2]).first();
    if (!s) throw Object.assign(new Error("Sample not found"), { status: 404 });
    const isAdmin = user.role === "admin";
    if (!isAdmin && s.collector !== user.name) throw Object.assign(new Error("Only the named collector or an admin can mark this sample collected"), { status: 403 });
    if (s.status !== "Bottle Ready" && s.status !== "Sample Collected") throw Object.assign(new Error(`Cannot mark collected — sample is on step "${s.status}"`), { status: 400 });
    const body = await bodyJson(request);
    const site = String(body.collectionSite || "").trim();
    if (!site) throw Object.assign(new Error("Sampling site required"), { status: 400 });
    await env.DB.prepare(`
      UPDATE samples SET collection_site = ?, status = 'Sample Collected', workflow_stage = 'Sample Collected',
        collected_at = ?, collection_lat = ?, collection_lng = ?, updated_at = ? WHERE id = ?
    `).bind(site, body.collectedAt || now(), body.collectionLat ? String(body.collectionLat) : null, body.collectionLng ? String(body.collectionLng) : null, now(), s.id).run();
    const locNote = body.collectionLat && body.collectionLng ? ` @ ${body.collectionLat},${body.collectionLng}` : "";
    await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,location_id) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(), s.id, now(), user.name, `Sample collected at ${site}${locNote}`, s.storage_location_id).run();
    await addAudit(env, user, "Sample collected", "sample", s.id, `${s.sample_code}: site=${site}${locNote}`);
    return json(await loadSampleFull(env, s.id));
  }

  /* --- Samples: storage move (any analyst) --- */
  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "storage") {
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(path[2]).first();
    if (!s) throw Object.assign(new Error("Sample not found"), { status: 404 });
    const body = await bodyJson(request);
    const prev = s.storage_location_id || "";
    const next = body.storageLocationId || "";
    if (next && !(await storageIsAvailable(env, next, prev))) throw Object.assign(new Error("Selected storage is full or inactive"), { status: 400 });
    if (prev === next) throw Object.assign(new Error("Sample is already in that storage"), { status: 400 });
    const isFirstStore = s.status === "Sample Collected" && next;
    const updates = ["storage_location_id = ?", "updated_at = ?"];
    const args = [next || null, now()];
    if (isFirstStore) { updates.push("status = 'Stored'", "workflow_stage = 'Stored'"); }
    args.push(s.id);
    await env.DB.prepare(`UPDATE samples SET ${updates.join(", ")} WHERE id = ?`).bind(...args).run();
    await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,from_location_id,to_location_id,location_id,note) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), s.id, now(), user.name, isFirstStore ? "Logged into storage" : "Storage moved", prev || null, next || null, next || null, body.reason || body.note || "").run();
    await addAudit(env, user, isFirstStore ? "Sample stored" : "Storage moved", "sample", s.id, `${s.sample_code}: ${prev || "unstored"} -> ${next || "unstored"}${body.reason ? ` (${body.reason})` : ""}`);
    return json(await loadSampleFull(env, s.id));
  }

  /* --- Samples: PATCH (status, assignedTo, notes, dueAt) --- */
  if (method === "PATCH" && path[0] === "api" && path[1] === "samples") {
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(path[2]).first();
    if (!s) throw Object.assign(new Error("Sample not found"), { status: 404 });
    if (!canWorkOnSample(user, s)) throw Object.assign(new Error("Not allowed for this sample"), { status: 403 });
    const body = await bodyJson(request);
    const prev = s.storage_location_id || "";
    if ("storageLocationId" in body && !(await storageIsAvailable(env, body.storageLocationId, prev))) throw Object.assign(new Error("Selected storage is full or inactive"), { status: 400 });
    if ("assignedTo" in body) body.assignedTo = normalizeAssignedTo(body.assignedTo);
    const parts = [], args = [];
    const map = { status: "status", assignedTo: "assigned_to", storageLocationId: "storage_location_id", notes: "notes", dueAt: "due_at" };
    for (const [k, col] of Object.entries(map)) {
      if (k in body) { parts.push(`${col} = ?`); args.push(body[k] || null); }
    }
    if ("status" in body) { parts.push("workflow_stage = ?"); args.push(body.status); }
    parts.push("updated_at = ?"); args.push(now());
    args.push(s.id);
    await env.DB.prepare(`UPDATE samples SET ${parts.join(", ")} WHERE id = ?`).bind(...args).run();
    if ("storageLocationId" in body && prev !== (body.storageLocationId || "")) {
      await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,from_location_id,to_location_id,location_id,note) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), s.id, now(), user.name, "Storage moved", prev || null, body.storageLocationId || null, body.storageLocationId || null, body.movementNote || body.notes || "").run();
    }
    if ("assignedTo" in body && body.assignedTo) {
      await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,location_id) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(), s.id, now(), user.name, `Assigned to ${body.assignedTo}`, s.storage_location_id).run();
    }
    const changed = Object.keys(body).join(", ");
    await addAudit(env, user, "Modified sample", "sample", s.id, `${s.sample_code}: ${changed}`);
    return json(await loadSampleFull(env, s.id));
  }

  /* --- Samples: results (single / bulk / sheet) --- */
  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "results") {
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(path[2]).first();
    if (!s) throw Object.assign(new Error("Sample not found"), { status: 404 });
    if (!canWorkOnSample(user, s)) throw Object.assign(new Error("Not allowed for this sample"), { status: 403 });
    const body = await bodyJson(request);
    let rows = [];
    if (path[4] === "bulk") {
      rows = String(body.rows || "").split(/\r?\n/).map(l => l.split(/,|\t/).map(c => c.trim())).filter(c => c[0] && c[1]).map(c => ({ parameter: c[0], value: c[1], unit: c[2] || "", limit: c[3] || "", method: c[4] || "", flag: c[5] || "OK" }));
    } else if (path[4] === "sheet") {
      rows = (Array.isArray(body.rows) ? body.rows : []).filter(r => r.parameter && r.value);
    } else if (path[4] === "excel") {
      throw Object.assign(new Error("Excel result import is not migrated yet. Use Input Data sheet online."), { status: 400 });
    } else {
      rows = [{ parameter: body.parameter, value: body.value, unit: body.unit || "", limit: body.limit || "", method: body.method || "", flag: body.flag || "OK" }];
    }
    if (!rows.length) throw Object.assign(new Error("Enter at least one result row"), { status: 400 });
    const insertedAt = now();
    const batch = rows.map(r => env.DB.prepare('INSERT INTO sample_results (id,sample_id,parameter,value,unit,"limit",method,flag,analyst,replicates,avg,stddev,msg,entered_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(
      crypto.randomUUID(), s.id, r.parameter, r.value || "", r.unit || "", r.limit || "", r.method || "", r.flag || "OK", user.name,
      r.replicates ? JSON.stringify(r.replicates) : null,
      r.avg == null ? null : Number(r.avg), r.stddev == null ? null : Number(r.stddev), r.msg || null,
      insertedAt
    ));
    await env.DB.batch(batch);
    const newStatus = rows.some(r => r.flag === "Alert") ? "Flagged" : "Results Entered";
    await env.DB.prepare("UPDATE samples SET status = ?, workflow_stage = ?, updated_at = ? WHERE id = ?").bind(newStatus, newStatus, now(), s.id).run();
    return json(await loadSampleFull(env, s.id));
  }

  /* --- Samples: files upload --- */
  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "files") {
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(path[2]).first();
    if (!s) throw Object.assign(new Error("Sample not found"), { status: 404 });
    const isAdmin = user.role === "admin";
    const isCollector = s.collector === user.name;
    if (!isAdmin && !isCollector && !canWorkOnSample(user, s)) throw Object.assign(new Error("Not allowed for this sample"), { status: 403 });
    const form = await request.formData();
    const category = String(form.get("category") || "Uploaded File");
    const lat = form.get("lat") ? String(form.get("lat")) : null;
    const lng = form.get("lng") ? String(form.get("lng")) : null;
    const takenAt = form.get("takenAt") ? String(form.get("takenAt")) : null;
    const batch = [];
    for (const [, value] of form.entries()) {
      if (!(value instanceof File) || !value.size) continue;
      const id = crypto.randomUUID();
      // Phase 2: write small files inline (data URL) OR to R2 if MEDIA bound
      // and file > 300 KB. Phase 3 polishes.
      let dataUrl = null, r2Key = null;
      if (value.size > 300 * 1024 && env.MEDIA) {
        r2Key = `samples/${s.id}/${id}-${value.name.replaceAll("/", "_")}`;
        await env.MEDIA.put(r2Key, await value.arrayBuffer(), { httpMetadata: { contentType: value.type } });
      } else {
        const buf = await value.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = ""; bytes.forEach(b => bin += String.fromCharCode(b));
        dataUrl = `data:${value.type || "application/octet-stream"};base64,${btoa(bin)}`;
      }
      batch.push(env.DB.prepare("INSERT INTO sample_files (id,sample_id,original_name,category,r2_key,data_url,size_bytes,mime_type,lat,lng,taken_at,uploaded_by,uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(
        id, s.id, value.name, category, r2Key, dataUrl, value.size, value.type || null, lat, lng, takenAt, user.name, now()
      ));
    }
    if (batch.length) await env.DB.batch(batch);
    await env.DB.prepare("UPDATE samples SET updated_at = ? WHERE id = ?").bind(now(), s.id).run();
    return json(await loadSampleFull(env, s.id));
  }

  /* --- R2 media serve --- */
  if (method === "GET" && path[0] === "api" && path[1] === "media") {
    const key = path.slice(2).join("/");
    if (!key || !env.MEDIA) throw Object.assign(new Error("Media not found"), { status: 404 });
    const obj = await env.MEDIA.get(key);
    if (!obj) throw Object.assign(new Error("Media not found"), { status: 404 });
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
        "cache-control": "private, max-age=3600"
      }
    });
  }

  /* --- Samples: delete a file --- */
  if (method === "DELETE" && path[0] === "api" && path[1] === "samples" && path[3] === "files" && path[4]) {
    requireRole(user, "admin");
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(path[2]).first();
    if (!s) throw Object.assign(new Error("Sample not found"), { status: 404 });
    const file = await env.DB.prepare("SELECT * FROM sample_files WHERE id = ? AND sample_id = ?").bind(path[4], s.id).first();
    if (!file) throw Object.assign(new Error("File not found"), { status: 404 });
    if (file.r2_key && env.MEDIA) {
      try { await env.MEDIA.delete(file.r2_key); } catch (e) { /* best effort */ }
    }
    await env.DB.prepare("DELETE FROM sample_files WHERE id = ?").bind(file.id).run();
    await addAudit(env, user, "Deleted sample file", "sample", s.id, `${s.sample_code}: ${file.original_name || file.category}`);
    return json({ ok: true });
  }

  /* --- Samples: approve --- */
  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "approve") {
    requireRole(user, "admin");
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(path[2]).first();
    if (!s) throw Object.assign(new Error("Sample not found"), { status: 404 });
    const resultCount = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sample_results WHERE sample_id = ?").bind(s.id).first()).n;
    if (resultCount === 0) throw Object.assign(new Error("Enter results before approval"), { status: 400 });
    await env.DB.prepare("UPDATE samples SET status = 'Approved', workflow_stage = 'Approved', reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?").bind(user.name, now(), now(), s.id).run();
    await addAudit(env, user, "Approved sample", "sample", s.id, `${s.sample_code} approved`);
    return json(await loadSampleFull(env, s.id));
  }

  /* --- Samples: lifecycle --- */
  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "lifecycle") {
    requireRole(user, "admin");
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(path[2]).first();
    if (!s) throw Object.assign(new Error("Sample not found"), { status: 404 });
    const body = await bodyJson(request);
    const action = body.action === "Dispose" ? "Disposed" : body.action;
    if (!["Retained", "Disposed", "Active"].includes(action)) throw Object.assign(new Error("Invalid lifecycle action"), { status: 400 });
    const updates = ["retention_status = ?", "updated_at = ?"];
    const args = [action, now()];
    if (action === "Disposed") {
      updates.push("status = 'Disposed'", "workflow_stage = 'Disposed'", "disposal_json = ?");
      args.push(JSON.stringify({ disposedAt: now(), disposedBy: user.name, reason: body.reason || "" }));
    }
    args.push(s.id);
    await env.DB.prepare(`UPDATE samples SET ${updates.join(", ")} WHERE id = ?`).bind(...args).run();
    await env.DB.prepare("INSERT INTO chain_of_custody (id,sample_id,at,by_name,action,location_id) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(), s.id, now(), user.name, action, s.storage_location_id).run();
    await addAudit(env, user, `Lifecycle: ${action}`, "sample", s.id, `${s.sample_code}${body.reason ? ` — ${body.reason}` : ""}`);
    return json(await loadSampleFull(env, s.id));
  }

  /* --- Search sample by code --- */
  if (method === "GET" && path[0] === "api" && path[1] === "search-sample") {
    const code = decodeURIComponent(path.slice(2).join("/"));
    const s = await env.DB.prepare("SELECT * FROM samples WHERE sample_code = ? OR id = ? LIMIT 1").bind(code, code).first();
    if (!s) throw Object.assign(new Error("Sample not found"), { status: 404 });
    if (!canReadSample(user, s)) throw Object.assign(new Error("Not allowed for this sample"), { status: 403 });
    return json(await loadSampleFull(env, s.id));
  }

  /* --- QR + report + label HTML --- */
  if (method === "GET" && path[0] === "api" && path[1] === "samples") {
    const sId = path[2];
    const sub = path[3];
    if (!sId) throw Object.assign(new Error("API route not found"), { status: 404 });
    const s = await env.DB.prepare("SELECT * FROM samples WHERE id = ?").bind(sId).first();
    if (!s || !canReadSample(user, s)) throw Object.assign(new Error("Sample not found"), { status: 404 });
    const payload = `${(env.FRONTEND_PUBLIC_URL || "").replace(/\/$/, "")}/?sample=${encodeURIComponent(s.sample_code)}`;
    if (sub === "qr.svg") {
      return new Response(await QRCode.toString(payload, { type: "svg", margin: 1, width: 240 }), { headers: { "content-type": "image/svg+xml" } });
    }
    if (sub === "tube-label") {
      const qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await QRCode.toString(payload, { type: "svg", margin: 0, width: 110 }))}`;
      return html(`<!doctype html><html><head><meta charset="utf-8"><title>${s.sample_code} label</title><style>body{font-family:Arial;margin:14px}.toolbar{margin-bottom:12px}.tube-label{width:38mm;height:18mm;border:1px solid #111;padding:1mm;display:grid;grid-template-columns:13mm 1fr;gap:1.5mm;align-items:center}.tube-label img{width:13mm;height:13mm}.tube-code{font-size:8px;font-weight:800}.tube-meta{font-size:6.5px}@media print{.toolbar{display:none}body{margin:0}}</style></head><body><div class="toolbar"><button onclick="window.print()">Print</button></div><div class="tube-label"><img src="${qr}"><div><div class="tube-code">${s.sample_code}</div><div class="tube-meta">${s.collection_site || ""}</div></div></div></body></html>`);
    }
    if (sub === "report" || sub === "report.pdf") {
      const results = (await env.DB.prepare("SELECT * FROM sample_results WHERE sample_id = ? ORDER BY entered_at").bind(s.id).all()).results || [];
      const rows = results.map(r => `<tr><td>${r.parameter}</td><td>${r.value} ${r.unit || ""}</td><td>${r.limit || ""}</td><td>${r.method || ""}</td><td>${r.flag || "OK"}</td><td>${r.analyst || ""}</td></tr>`).join("");
      return html(`<!doctype html><html><head><meta charset="utf-8"><title>${s.sample_code} report</title><style>body{font-family:Arial;margin:28px}table{border-collapse:collapse;width:100%;margin-top:14px}td,th{border:1px solid #999;padding:8px}@media print{button{display:none}}</style></head><body><button onclick="window.print()">Print</button><h1>${APP_NAME} — ${s.sample_code}</h1><p><b>Project:</b> ${s.client_name}<br><b>Site:</b> ${s.collection_site}<br><b>Status:</b> ${s.status}</p><table><thead><tr><th>Parameter</th><th>Result</th><th>Limit</th><th>Method</th><th>Flag</th><th>Analyst</th></tr></thead><tbody>${rows || "<tr><td colspan=6>No results entered</td></tr>"}</tbody></table></body></html>`);
    }
  }

  /* --- Alerts --- */
  if (method === "GET" && path.join("/") === "api/alerts") {
    const samples = await loadSamplesFull(env, { limit: 2000 });
    return json({
      overdue: samples.filter(s => s.status !== "Approved" && s.status !== "Disposed" && new Date(s.dueAt || 0).getTime() < Date.now()),
      dueSoon: samples.filter(s => s.status !== "Approved" && s.status !== "Disposed" && new Date(s.dueAt || 0).getTime() - Date.now() < 24*60*60*1000 && new Date(s.dueAt || 0).getTime() >= Date.now()),
      waitingUpload: samples.filter(s => !(s.files || []).some(f => f.category?.includes("Written Record") || f.category?.includes("Book"))),
      waitingApproval: samples.filter(s => s.status === "Needs Review" || s.status === "Results Entered"),
      disposalReady: samples.filter(s => s.status === "Approved" && s.retentionStatus === "Active")
    });
  }

  throw Object.assign(new Error("API route not found"), { status: 404 });
}

/* ------------------------------------------------------------------------ */
/* Entry point                                                               */
/* ------------------------------------------------------------------------ */

export default {
  async fetch(request, env, context) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const response = await handle(request, env, context);
      const headers = new Headers(response.headers);
      Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      return json({ error: error.message || "Worker error", errors: error.errors }, { status: error.status || 500, headers: cors });
    }
  }
};
