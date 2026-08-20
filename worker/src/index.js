import { neon } from "@neondatabase/serverless";
import QRCode from "qrcode";

const APP_NAME = "Plasma Lab LIMS";
const STATUS_OPTIONS = ["Bottle Ready", "Sample Collected", "Stored", "Assigned", "In Analysis", "Results Entered", "Needs Review", "Approved", "Flagged", "Disposed"];
const PASSWORD_ITERATIONS = 100000;

const json = (body, init = {}) => new Response(JSON.stringify(body), {
  ...init,
  headers: {
    "content-type": "application/json",
    ...(init.headers || {})
  }
});

const html = (body, init = {}) => new Response(body, {
  ...init,
  headers: {
    "content-type": "text/html; charset=utf-8",
    ...(init.headers || {})
  }
});

function now() {
  return new Date().toISOString();
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result.toISOString();
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const allowed = String(env.ALLOWED_ORIGINS || env.FRONTEND_PUBLIC_URL || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  if (!origin || (allowed.length && !allowed.includes(origin))) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "vary": "Origin"
  };
}

async function ensureStore(env) {
  const sql = neon(env.DATABASE_URL);
  await sql`
    create table if not exists lims_store (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `;
  return sql;
}

function newDb() {
  return {
    pendingSignups: [],
    passwordResets: [],
    users: [],
    people: [
      { id: crypto.randomUUID(), name: "Priya Nair", role: "Analyst", active: true },
      { id: crypto.randomUUID(), name: "Rahul Menon", role: "Analyst", active: true }
    ],
    storageLocations: [
      { id: crypto.randomUUID(), name: "Freezer 1 / Shelf A / Rack 01", type: "Freezer", active: true, isFull: false, capacityNote: "" },
      { id: crypto.randomUUID(), name: "Freezer 2 / Shelf B / Rack 02", type: "Freezer", active: true, isFull: false, capacityNote: "" },
      { id: crypto.randomUUID(), name: "Quarantine Freezer / Tray Q1", type: "Quarantine", active: true, isFull: false, capacityNote: "" }
    ],
    tests: [
      { id: crypto.randomUUID(), name: "pH", unit: "pH", limit: "6.5-8.5", method: "Electrometric" },
      { id: crypto.randomUUID(), name: "TDS", unit: "mg/L", limit: "<500", method: "Conductivity calculation" },
      { id: crypto.randomUUID(), name: "Turbidity", unit: "NTU", limit: "<1", method: "Nephelometric" },
      { id: crypto.randomUUID(), name: "Nitrate", unit: "mg/L", limit: "<45", method: "UV screening" },
      { id: crypto.randomUUID(), name: "E. coli", unit: "/100 mL", limit: "Absent", method: "Membrane filtration" }
    ],
    samples: [],
    audit: [],
    meta: { createdAt: now(), lastWriteAt: now(), writeCount: 0 }
  };
}

function normalizeDb(db) {
  db.pendingSignups ||= [];
  db.passwordResets ||= [];
  db.users ||= [];
  db.people ||= [];
  db.storageLocations ||= [];
  db.tests ||= [];
  db.samples ||= [];
  db.audit ||= [];
  db.meta ||= {};
  db.storageLocations.forEach(item => {
    item.active = item.active !== false;
    item.isFull = Boolean(item.isFull);
    item.capacityNote ||= "";
  });
  db.samples.forEach(sample => {
    sample.status ||= "Bottle Ready";
    if (sample.status === "Received") sample.status = sample.storageLocationId ? "Stored" : "Sample Collected";
    sample.workflowStage ||= sample.status;
    sample.results ||= [];
    sample.files ||= [];
    sample.chainOfCustody ||= [];
    sample.retentionStatus ||= "Active";
    sample.disposal ||= null;
    sample.active = sample.active !== false;
  });
  return db;
}

async function readDb(env) {
  const sql = await ensureStore(env);
  const rows = await sql`select data from lims_store where id = 'primary'`;
  if (rows[0]?.data) return normalizeDb(rows[0].data);
  const db = newDb();
  const adminId = crypto.randomUUID();
  db.users.push({
    id: adminId,
    name: "Lab Admin",
    email: "admin@lab.local",
    phone: "0000000000",
    countryCode: "+91",
    passwordHash: await hashPassword("admin123"),
    role: "admin",
    active: true,
    createdAt: now()
  });
  addAudit(db, null, "Initialized online database", "system", "primary", "Seeded default admin");
  await writeDb(env, db);
  return db;
}

async function writeDb(env, db) {
  db.meta ||= {};
  db.meta.lastWriteAt = now();
  db.meta.writeCount = Number(db.meta.writeCount || 0) + 1;
  const sql = await ensureStore(env);
  await sql`
    insert into lims_store (id, data, updated_at)
    values ('primary', ${JSON.stringify(db)}::jsonb, now())
    on conflict (id) do update set data = excluded.data, updated_at = now()
  `;
}

function addAudit(db, user, action, entity, entityId, detail) {
  db.audit.unshift({
    id: crypto.randomUUID(),
    at: now(),
    userId: user?.id || "system",
    userName: user?.name || "System",
    action,
    entity,
    entityId,
    detail
  });
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || "",
    countryCode: user.countryCode || "",
    role: user.role,
    active: user.active,
    createdAt: user.createdAt
  };
}

function b64url(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new TextEncoder().encode(String(input));
  let binary = "";
  bytes.forEach(byte => binary += String.fromCharCode(byte));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromB64url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function signJwt(payload, secret, expiresInSeconds = 12 * 60 * 60) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSeconds }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

async function verifyJwt(token, secret) {
  const [header, body, signature] = String(token || "").split(".");
  if (!header || !body || !signature) throw new Error("Invalid session");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`)));
  if (expected !== signature) throw new Error("Invalid session");
  const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Session expired");
  return payload;
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PASSWORD_ITERATIONS, hash: "SHA-256" }, key, 256);
  return `pbkdf2$${PASSWORD_ITERATIONS}$${b64url(salt.buffer)}$${b64url(bits)}`;
}

async function verifyPassword(password, stored) {
  if (!stored?.startsWith("pbkdf2$")) return false;
  const [, iter, saltText, hashText] = stored.split("$");
  const salt = fromB64url(saltText);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: Number(iter), hash: "SHA-256" }, key, 256);
  return b64url(bits) === hashText;
}

async function auth(request, env) {
  const token = (request.headers.get("authorization") || "").replace("Bearer ", "") || new URL(request.url).searchParams.get("token");
  if (!token) throw Object.assign(new Error("Login required"), { status: 401 });
  const payload = await verifyJwt(token, env.JWT_SECRET || "change-this-before-production");
  const db = await readDb(env);
  const user = db.users.find(item => item.id === payload.id && item.active);
  if (!user) throw Object.assign(new Error("Invalid user"), { status: 401 });
  return { db, user };
}

function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) throw Object.assign(new Error("Not allowed"), { status: 403 });
}

function canReadSample(user, sample) {
  if (user.role === "admin") return true;
  if (user.role === "analyst") return !sample.assignedTo || sample.assignedTo === user.name;
  return false;
}

function canWorkOnSample(user, sample) {
  return canReadSample(user, sample) && user.role !== "viewer";
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || "").trim());
}

function validPhone(countryCode, phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return /^\+\d{1,4}$/.test(String(countryCode || "")) && digits.length >= 6 && digits.length <= 15;
}

function otpCode() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
}

function otpExpiry() {
  return addDays(now(), 1);
}

function validOtp(record, field, value) {
  return Boolean(record && new Date(record.expiresAt).getTime() > Date.now() && String(record[field] || "") === String(value || "").trim());
}

async function sendOtpEmail(env, to, otp, subject = "Plasma Lab LIMS verification code") {
  if (env.RESEND_API_KEY && env.SMTP_FROM) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: `${env.SMTP_FROM_NAME || "Plasma Lab LIMS"} <${env.SMTP_FROM}>`,
        to: [to],
        subject,
        text: `Your Plasma Lab LIMS OTP is ${otp}. This code expires in 24 hours.`
      })
    });
    if (!response.ok) throw new Error(`Email delivery failed: ${await response.text()}`);
    return true;
  }

  if (env.GMAIL_APPS_SCRIPT_URL) {
    const response = await fetch(env.GMAIL_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, otp, subject })
    });
    if (!response.ok) throw new Error("Gmail email delivery failed");
    return true;
  }

  return false;
}

function nextSampleId(db) {
  const year = new Date().getFullYear();
  const nums = db.samples
    .map(sample => sample.sampleCode)
    .filter(code => code && code.includes(`PL-${year}-`))
    .map(code => Number(code.split("-").pop()))
    .filter(Boolean);
  return `PL-${year}-${String(nums.length ? Math.max(...nums) + 1 : 1).padStart(6, "0")}`;
}

function storageName(db, id) {
  return db.storageLocations.find(item => item.id === id)?.name || "Not stored";
}

function storageIsAvailable(db, id, currentId = "") {
  if (!id) return true;
  const location = db.storageLocations.find(item => item.id === id);
  if (!location || location.active === false) return false;
  return !location.isFull || id === currentId;
}

function createSampleRecord(db, user, body) {
  if (!storageIsAvailable(db, body.storageLocationId)) throw new Error("Selected storage is full or inactive");
  const sample = {
    id: crypto.randomUUID(),
    sampleCode: nextSampleId(db),
    status: body.status || "Bottle Ready",
    workflowStage: body.status || "Bottle Ready",
    clientName: body.clientName || "",
    sourceType: body.sourceType || "",
    collectionSite: body.collectionSite || "",
    collector: body.collector || "",
    receivedBy: user.name,
    receivedAt: now(),
    storageLocationId: body.storageLocationId || "",
    assignedTo: body.assignedTo || "",
    requestedTests: Array.isArray(body.requestedTests) ? body.requestedTests : [],
    notes: body.notes || "",
    results: [],
    files: [],
    chainOfCustody: [{ at: now(), by: user.name, action: "Bottle labelled", locationId: body.storageLocationId || "" }],
    dueAt: body.dueAt || addDays(now(), 3),
    retentionStatus: "Active",
    disposal: null,
    active: true,
    createdAt: now(),
    updatedAt: now()
  };
  db.samples.unshift(sample);
  return sample;
}

function validateSampleBody(body) {
  if (!body.clientName || !body.collectionSite || !body.sourceType || !body.collector) return "Project/client, site, source type, and brought by are required";
  if (!Array.isArray(body.requestedTests) || body.requestedTests.length === 0) return "Choose at least one requested test";
  return "";
}

function frontendOrigin(env, request) {
  if (env.FRONTEND_PUBLIC_URL) return env.FRONTEND_PUBLIC_URL.replace(/\/$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function sampleQrPayload(sample, env, request) {
  return `${frontendOrigin(env, request)}/?sample=${encodeURIComponent(sample.sampleCode)}`;
}

function parsePath(url) {
  return url.pathname.split("/").filter(Boolean);
}

async function bodyJson(request) {
  if (!request.headers.get("content-type")?.includes("application/json")) return {};
  return request.json();
}

function sampleDueState(sample) {
  if (sample.status === "Approved" || sample.status === "Disposed" || sample.retentionStatus === "Disposed") return "complete";
  const due = new Date(sample.dueAt || sample.createdAt || sample.receivedAt).getTime();
  if (!due) return "none";
  const remaining = due - Date.now();
  if (remaining < 0) return "overdue";
  if (remaining <= 24 * 60 * 60 * 1000) return "due-soon";
  return "on-time";
}

function readableBackupHtml(db, exportedBy = "System") {
  const rows = db.samples.map(sample => `<tr><td>${sample.sampleCode}</td><td>${sample.status}</td><td>${sample.clientName}</td><td>${sample.collectionSite}</td><td>${sample.assignedTo || ""}</td><td>${storageName(db, sample.storageLocationId)}</td><td>${(sample.results || []).map(r => `${r.parameter}: ${r.value} ${r.unit}`).join("; ")}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME} Backup</title><style>body{font-family:Arial,sans-serif;margin:24px}table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid #999;padding:6px;text-align:left}</style></head><body><h1>${APP_NAME} Readable Backup</h1><p>Exported ${new Date().toLocaleString()} by ${exportedBy}</p><table><thead><tr><th>Sample</th><th>Status</th><th>Project</th><th>Site</th><th>Analyst</th><th>Storage</th><th>Results</th></tr></thead><tbody>${rows || "<tr><td colspan='7'>No samples</td></tr>"}</tbody></table></body></html>`;
}

async function fileToDataUrl(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach(byte => binary += String.fromCharCode(byte));
  return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = parsePath(url);
  const method = request.method;

  if (path.join("/") === "api/health") {
    const db = await readDb(env);
    return json({ ok: true, service: "Plasma Lab LIMS Worker API", database: "Neon PostgreSQL", samples: db.samples.length, users: db.users.length, frontend: env.FRONTEND_PUBLIC_URL || "" });
  }

  if (method === "POST" && path.join("/") === "api/login") {
    const body = await bodyJson(request);
    const db = await readDb(env);
    const user = db.users.find(item => item.email.toLowerCase() === String(body.email || "").toLowerCase() && item.active);
    if (!user || !(await verifyPassword(body.password || "", user.passwordHash))) throw Object.assign(new Error("Invalid email or password"), { status: 401 });
    addAudit(db, user, "Logged in", "user", user.id, "User session started");
    await writeDb(env, db);
    const token = await signJwt({ id: user.id }, env.JWT_SECRET || "change-this-before-production", body.rememberMe ? 30 * 24 * 60 * 60 : 12 * 60 * 60);
    return json({ token, user: publicUser(user) });
  }

  if (path.join("/") === "api/validate/signup") {
    const db = await readDb(env);
    const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
    const countryCode = String(url.searchParams.get("countryCode") || "").trim();
    const phone = String(url.searchParams.get("phone") || "").replace(/\D/g, "");
    const emailLooksValid = validEmail(email);
    const emailAvailable = emailLooksValid && !db.users.some(user => user.active && user.email.toLowerCase() === email);
    const phoneLooksValid = phone ? validPhone(countryCode, phone) : false;
    const phoneAvailable = phoneLooksValid && !db.users.some(user => user.active && String(user.countryCode || "") === countryCode && String(user.phone || "") === phone);
    return json({
      email: { valid: emailLooksValid, available: emailAvailable, message: !email ? "" : !emailLooksValid ? "Invalid email format" : emailAvailable ? "Email looks valid and available" : "Email is already registered" },
      phone: { valid: phoneLooksValid, available: phoneAvailable, normalized: phone, message: !phone ? "" : !phoneLooksValid ? "Invalid phone number" : phoneAvailable ? "Phone looks valid and available" : "Phone is already registered" }
    });
  }

  if (method === "POST" && path.join("/") === "api/signup/email/start") {
    const body = await bodyJson(request);
    const db = await readDb(env);
    if (!body.name || !validEmail(body.email)) throw Object.assign(new Error("Name and valid email are required"), { status: 400 });
    if (db.users.some(user => user.active && user.email.toLowerCase() === body.email.toLowerCase())) throw Object.assign(new Error("Email already exists"), { status: 409 });
    const emailOtp = otpCode();
    const pending = { id: crypto.randomUUID(), name: body.name, email: body.email, emailOtp, emailVerified: false, expiresAt: otpExpiry(), createdAt: now() };
    db.pendingSignups = db.pendingSignups.filter(item => item.email.toLowerCase() !== body.email.toLowerCase());
    db.pendingSignups.push(pending);
    const delivered = await sendOtpEmail(env, pending.email, emailOtp, "Plasma Lab LIMS signup verification");
    addAudit(db, null, delivered ? "Sent signup email OTP" : "Generated signup OTP", "user", pending.id, `${body.name} requested email verification`);
    await writeDb(env, db);
    return json({ pendingId: pending.id, expiresAt: pending.expiresAt, deliveryConfigured: delivered });
  }

  if (method === "POST" && path.join("/") === "api/signup/email/verify") {
    const body = await bodyJson(request);
    const db = await readDb(env);
    const pending = db.pendingSignups.find(item => item.id === body.pendingId);
    if (!validOtp(pending, "emailOtp", body.emailOtp)) throw Object.assign(new Error("Invalid or expired email OTP"), { status: 400 });
    pending.emailVerified = true;
    pending.expiresAt = otpExpiry();
    await writeDb(env, db);
    return json({ pendingId: pending.id, ok: true });
  }

  if (method === "POST" && path.join("/") === "api/signup/phone/save") {
    const body = await bodyJson(request);
    const db = await readDb(env);
    const pending = db.pendingSignups.find(item => item.id === body.pendingId);
    if (!pending || !pending.emailVerified) throw Object.assign(new Error("Verify email first"), { status: 400 });
    if (!validPhone(body.countryCode, body.phone)) throw Object.assign(new Error("Enter a valid country code and phone number"), { status: 400 });
    if (db.users.some(user => user.active && String(user.countryCode || "") === String(body.countryCode) && String(user.phone || "") === String(body.phone).replace(/\D/g, ""))) throw Object.assign(new Error("Phone already exists"), { status: 409 });
    pending.countryCode = body.countryCode;
    pending.phone = String(body.phone).replace(/\D/g, "");
    pending.expiresAt = otpExpiry();
    await writeDb(env, db);
    return json({ pendingId: pending.id, ok: true });
  }

  if (method === "POST" && path.join("/") === "api/signup/complete") {
    const body = await bodyJson(request);
    const db = await readDb(env);
    const pending = db.pendingSignups.find(item => item.id === body.pendingId);
    if (!pending || !pending.emailVerified || !pending.phone) throw Object.assign(new Error("Verify email and enter phone before creating password"), { status: 400 });
    if (!body.password || String(body.password).length < 6) throw Object.assign(new Error("Password must be at least 6 characters"), { status: 400 });
    if (!body.password || body.password !== body.confirmPassword) throw Object.assign(new Error("Passwords do not match"), { status: 400 });
    db.users
      .filter(item => !item.active && item.email.toLowerCase() === pending.email.toLowerCase())
      .forEach(item => {
        item.replacedAt = now();
        item.replacedByEmail = pending.email;
      });
    const user = { id: crypto.randomUUID(), name: pending.name, email: pending.email, countryCode: pending.countryCode, phone: pending.phone, passwordHash: await hashPassword(body.password), role: "analyst", active: true, createdAt: now() };
    db.users.push(user);
    db.pendingSignups = db.pendingSignups.filter(item => item.id !== pending.id);
    addAudit(db, user, "Verified signup", "user", user.id, `${user.name} created a verified account`);
    await writeDb(env, db);
    return json({ user: publicUser(user) });
  }

  if (method === "POST" && path.join("/") === "api/signup/resend") {
    const body = await bodyJson(request);
    const db = await readDb(env);
    const pending = db.pendingSignups.find(item => item.id === body.pendingId);
    if (!pending) throw Object.assign(new Error("Signup request not found"), { status: 404 });
    pending.expiresAt = otpExpiry();
    pending.emailOtp = otpCode();
    const delivered = await sendOtpEmail(env, pending.email, pending.emailOtp, "Plasma Lab LIMS signup verification");
    addAudit(db, null, delivered ? "Resent signup OTP" : "Regenerated signup OTP", "user", pending.id, "email code refreshed");
    await writeDb(env, db);
    return json({ pendingId: pending.id, expiresAt: pending.expiresAt, deliveryConfigured: delivered });
  }

  if (method === "POST" && path.join("/") === "api/password-reset/start") {
    const body = await bodyJson(request);
    const db = await readDb(env);
    const identifier = String(body.identifier || "").trim().toLowerCase();
    const user = db.users.find(item => item.active && item.email.toLowerCase() === identifier);
    if (!user) throw Object.assign(new Error("No matching registered user found"), { status: 404 });
    db.passwordResets = db.passwordResets.filter(item => item.userId !== user.id);
    const reset = { id: crypto.randomUUID(), userId: user.id, emailOtp: otpCode(), expiresAt: otpExpiry(), createdAt: now() };
    db.passwordResets.push(reset);
    const delivered = await sendOtpEmail(env, user.email, reset.emailOtp, "Plasma Lab LIMS password reset");
    addAudit(db, user, delivered ? "Sent password reset OTP" : "Generated password reset OTP", "user", user.id, "Password reset OTP requested");
    await writeDb(env, db);
    return json({ resetId: reset.id, expiresAt: reset.expiresAt, deliveryConfigured: delivered });
  }

  if (method === "POST" && path.join("/") === "api/password-reset/confirm") {
    const body = await bodyJson(request);
    if (!body.password || String(body.password).length < 6) throw Object.assign(new Error("Password must be at least 6 characters"), { status: 400 });
    const db = await readDb(env);
    const reset = db.passwordResets.find(item => item.id === body.resetId);
    if (!validOtp(reset, "emailOtp", body.emailOtp)) throw Object.assign(new Error("Invalid or expired email OTP"), { status: 400 });
    const user = db.users.find(item => item.id === reset.userId && item.active);
    if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
    user.passwordHash = await hashPassword(body.password);
    db.passwordResets = db.passwordResets.filter(item => item.id !== reset.id);
    addAudit(db, user, "Reset password", "user", user.id, "Password changed after OTP verification");
    await writeDb(env, db);
    return json({ ok: true });
  }

  const { db, user } = await auth(request, env);

  if (method === "GET" && path.join("/") === "api/bootstrap") {
    const visibleSamples = db.samples.filter(sample => canReadSample(user, sample));
    return json({ user: publicUser(user), users: user.role === "admin" ? db.users.map(publicUser) : [], people: db.people, storageLocations: db.storageLocations, tests: db.tests, samples: visibleSamples, audit: user.role === "admin" ? db.audit.slice(0, 200) : [] });
  }

  if (method === "GET" && path.join("/") === "api/alerts") {
    const samples = db.samples.filter(sample => canReadSample(user, sample));
    return json({
      overdue: samples.filter(sample => sampleDueState(sample) === "overdue"),
      dueSoon: samples.filter(sample => sampleDueState(sample) === "due-soon"),
      waitingUpload: samples.filter(sample => !(sample.files || []).some(file => file.category?.includes("Written Record") || file.category?.includes("Book"))),
      waitingApproval: samples.filter(sample => sample.status === "Needs Review" || sample.status === "Results Entered"),
      disposalReady: samples.filter(sample => sample.status === "Approved" && sample.retentionStatus === "Active")
    });
  }

  if (method === "GET" && path.join("/") === "api/backup") {
    addAudit(db, user, "Exported backup", "system", "backup", "Readable HTML backup downloaded");
    await writeDb(env, db);
    return html(readableBackupHtml(db, user.name), { headers: { "content-disposition": `attachment; filename="plasma-lab-readable-backup-${new Date().toISOString().slice(0, 10)}.html"` } });
  }

  if (method === "GET" && path.join("/") === "api/exports") {
    requireRole(user, "admin");
    return json({ files: [], health: { database: "OK", samples: db.samples.length, users: db.users.length, auditEntries: db.audit.length, uploadedFiles: db.samples.reduce((t, s) => t + (s.files || []).length, 0), dbSize: JSON.stringify(db).length, lastWriteAt: db.meta?.lastWriteAt || "", writeCount: db.meta?.writeCount || 0, storage: "Neon PostgreSQL document store" } });
  }

  if (method === "POST" && path.join("/") === "api/exports/run") return json({ fileName: `online-export-${new Date().toISOString().slice(0, 10)}.html`, created: true });
  if (method === "GET" && path[0] === "api" && path[1] === "exports") return html(readableBackupHtml(db, user.name));

  if (method === "POST" && path.join("/") === "api/users") {
    requireRole(user, "admin");
    const body = await bodyJson(request);
    if (!["admin", "analyst"].includes(body.role)) throw Object.assign(new Error("Choose admin/manager or analyst"), { status: 400 });
    if (db.users.some(item => item.active && item.email.toLowerCase() === body.email.toLowerCase())) throw Object.assign(new Error("Email already exists"), { status: 409 });
    const created = { id: crypto.randomUUID(), name: body.name, email: body.email, phone: body.phone || "", countryCode: body.countryCode || "", passwordHash: await hashPassword(body.password), role: body.role, active: true, createdAt: now() };
    db.users.push(created);
    addAudit(db, user, "Created user", "user", created.id, `${created.name} added as ${created.role}`);
    await writeDb(env, db);
    return json(publicUser(created));
  }

  if (method === "PATCH" && path[0] === "api" && path[1] === "users") {
    requireRole(user, "admin");
    const target = db.users.find(item => item.id === path[2]);
    if (!target) throw Object.assign(new Error("User not found"), { status: 404 });
    const body = await bodyJson(request);
    if (body.role && ["admin", "analyst"].includes(body.role)) target.role = body.role;
    if (typeof body.active === "boolean") target.active = body.active;
    addAudit(db, user, "Modified user", "user", target.id, `${target.name}: role=${target.role}, active=${target.active}`);
    await writeDb(env, db);
    return json(publicUser(target));
  }

  if (method === "DELETE" && path[0] === "api" && path[1] === "users") {
    requireRole(user, "admin");
    const target = db.users.find(item => item.id === path[2]);
    if (!target) throw Object.assign(new Error("User not found"), { status: 404 });
    if (target.id === user.id) throw Object.assign(new Error("You cannot delete your own login"), { status: 400 });
    target.active = false;
    target.deletedAt = now();
    target.deletedBy = user.name;
    await writeDb(env, db);
    return json(publicUser(target));
  }

  const masterRoutes = { people: "people", "storage-locations": "storageLocations", tests: "tests" };
  if (path[0] === "api" && masterRoutes[path[1]]) {
    requireRole(user, "admin");
    const collection = db[masterRoutes[path[1]]];
    if (method === "POST") {
      const body = await bodyJson(request);
      const item = { id: crypto.randomUUID(), ...body, active: true };
      if (path[1] === "storage-locations") {
        item.type ||= "Storage";
        item.isFull = Boolean(item.isFull);
        item.capacityNote ||= "";
      }
      collection.push(item);
      addAudit(db, user, `Added ${path[1]}`, path[1], item.id, item.name || "");
      await writeDb(env, db);
      return json(item);
    }
    if (method === "PATCH") {
      const item = collection.find(entry => entry.id === path[2]);
      if (!item) throw Object.assign(new Error("Record not found"), { status: 404 });
      Object.assign(item, await bodyJson(request));
      await writeDb(env, db);
      return json(item);
    }
  }

  if (method === "POST" && path.join("/") === "api/samples") {
    requireRole(user, "admin");
    const body = await bodyJson(request);
    const error = validateSampleBody(body);
    if (error) throw Object.assign(new Error(error), { status: 400 });
    const sample = createSampleRecord(db, user, body);
    addAudit(db, user, "Prepared bottle label", "sample", sample.id, `${sample.sampleCode} created`);
    await writeDb(env, db);
    return json(sample);
  }

  if (method === "POST" && path.join("/") === "api/samples/bulk") {
    requireRole(user, "admin");
    const body = await bodyJson(request);
    const created = [];
    const errors = [];
    (Array.isArray(body.rows) ? body.rows : []).slice(0, 250).forEach((row, index) => {
      try {
        const error = validateSampleBody(row);
        if (error) throw new Error(error);
        created.push(createSampleRecord(db, user, row));
      } catch (error) {
        errors.push({ row: index + 1, error: error.message });
      }
    });
    if (!created.length) throw Object.assign(new Error("No samples could be created"), { status: 400, errors });
    addAudit(db, user, "Bulk created samples", "sample", "bulk", `${created.length} samples created`);
    await writeDb(env, db);
    return json({ created, errors });
  }

  if (method === "POST" && path.join("/") === "api/samples/bulk/excel") throw Object.assign(new Error("Excel sample import is not migrated yet. Use pasted bulk rows online."), { status: 400 });

  if (method === "PATCH" && path[0] === "api" && path[1] === "samples") {
    const sample = db.samples.find(item => item.id === path[2]);
    if (!sample) throw Object.assign(new Error("Sample not found"), { status: 404 });
    if (!canWorkOnSample(user, sample)) throw Object.assign(new Error("Not allowed for this sample"), { status: 403 });
    const body = await bodyJson(request);
    const previousStorageId = sample.storageLocationId || "";
    if ("storageLocationId" in body && !storageIsAvailable(db, body.storageLocationId, previousStorageId)) throw Object.assign(new Error("Selected storage is full or inactive"), { status: 400 });
    ["status", "assignedTo", "storageLocationId", "notes", "dueAt"].forEach(key => {
      if (key in body) sample[key] = body[key];
    });
    if ("storageLocationId" in body && previousStorageId !== body.storageLocationId) sample.chainOfCustody.unshift({ at: now(), by: user.name, action: "Storage moved", fromLocationId: previousStorageId, toLocationId: body.storageLocationId || "", locationId: body.storageLocationId || "", note: body.movementNote || body.notes || "" });
    if ("assignedTo" in body && body.assignedTo) sample.chainOfCustody.unshift({ at: now(), by: user.name, action: `Assigned to ${body.assignedTo}`, locationId: sample.storageLocationId || "" });
    if ("status" in body) sample.workflowStage = body.status;
    sample.updatedAt = now();
    await writeDb(env, db);
    return json(sample);
  }

  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "results") {
    const sample = db.samples.find(item => item.id === path[2]);
    if (!sample) throw Object.assign(new Error("Sample not found"), { status: 404 });
    if (!canWorkOnSample(user, sample)) throw Object.assign(new Error("Not allowed for this sample"), { status: 403 });
    const body = await bodyJson(request);
    let results = [];
    if (path[4] === "bulk") {
      results = String(body.rows || "").split(/\r?\n/).map(line => line.split(/,|\t/).map(c => c.trim())).filter(c => c[0] && c[1]).map(c => ({ parameter: c[0], value: c[1], unit: c[2] || "", limit: c[3] || "", method: c[4] || "", flag: c[5] || "OK" }));
    } else if (path[4] === "sheet") {
      results = (Array.isArray(body.rows) ? body.rows : []).filter(row => row.parameter && row.value);
    } else if (path[4] === "excel") {
      throw Object.assign(new Error("Excel result import is not migrated yet. Use Input Data sheet online."), { status: 400 });
    } else {
      results = [{ parameter: body.parameter, value: body.value, unit: body.unit || "", limit: body.limit || "", method: body.method || "", flag: body.flag || "OK" }];
    }
    results = results.map(result => ({ id: crypto.randomUUID(), ...result, analyst: user.name, enteredAt: now() }));
    if (!results.length) throw Object.assign(new Error("Enter at least one result row"), { status: 400 });
    sample.results.unshift(...results);
    sample.status = results.some(result => result.flag === "Alert") ? "Flagged" : "Results Entered";
    sample.workflowStage = sample.status;
    sample.updatedAt = now();
    await writeDb(env, db);
    return json(sample);
  }

  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "files") {
    const sample = db.samples.find(item => item.id === path[2]);
    if (!sample) throw Object.assign(new Error("Sample not found"), { status: 404 });
    if (!canWorkOnSample(user, sample)) throw Object.assign(new Error("Not allowed for this sample"), { status: 403 });
    const form = await request.formData();
    const category = String(form.get("category") || "Uploaded File");
    const files = [];
    for (const [, value] of form.entries()) {
      if (value instanceof File && value.size) {
        files.push({ id: crypto.randomUUID(), originalName: value.name, category, url: value.size <= 750000 ? await fileToDataUrl(value) : "", size: value.size, uploadedBy: user.name, uploadedAt: now() });
      }
    }
    sample.files.unshift(...files);
    sample.updatedAt = now();
    await writeDb(env, db);
    return json(sample);
  }

  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "approve") {
    requireRole(user, "admin");
    const sample = db.samples.find(item => item.id === path[2]);
    if (!sample) throw Object.assign(new Error("Sample not found"), { status: 404 });
    if (!sample.results.length) throw Object.assign(new Error("Enter results before approval"), { status: 400 });
    sample.status = "Approved";
    sample.workflowStage = "Approved";
    sample.reviewedBy = user.name;
    sample.reviewedAt = now();
    await writeDb(env, db);
    return json(sample);
  }

  if (method === "POST" && path[0] === "api" && path[1] === "samples" && path[3] === "lifecycle") {
    requireRole(user, "admin");
    const sample = db.samples.find(item => item.id === path[2]);
    if (!sample) throw Object.assign(new Error("Sample not found"), { status: 404 });
    const body = await bodyJson(request);
    if (!["Retained", "Disposed", "Active"].includes(body.action)) throw Object.assign(new Error("Invalid lifecycle action"), { status: 400 });
    sample.retentionStatus = body.action;
    if (body.action === "Disposed") {
      sample.status = "Disposed";
      sample.workflowStage = "Disposed";
      sample.disposal = { disposedAt: now(), disposedBy: user.name, reason: body.reason || "" };
    }
    sample.chainOfCustody.unshift({ at: now(), by: user.name, action: body.action, locationId: sample.storageLocationId || "" });
    await writeDb(env, db);
    return json(sample);
  }

  if (method === "GET" && path[0] === "api" && path[1] === "search-sample") {
    const code = decodeURIComponent(path.slice(2).join("/"));
    const sample = db.samples.find(item => item.sampleCode === code || item.id === code);
    if (!sample) throw Object.assign(new Error("Sample not found"), { status: 404 });
    if (!canReadSample(user, sample)) throw Object.assign(new Error("Not allowed for this sample"), { status: 403 });
    return json(sample);
  }

  if (method === "GET" && path[0] === "api" && path[1] === "samples") {
    if (path[3] === "qr.svg") {
      const sample = db.samples.find(item => item.id === path[2]);
      if (!sample || !canReadSample(user, sample)) throw Object.assign(new Error("Sample not found"), { status: 404 });
      return new Response(await QRCode.toString(sampleQrPayload(sample, env, request), { type: "svg", margin: 1, width: 240 }), { headers: { "content-type": "image/svg+xml" } });
    }
    if (path[3] === "tube-label") {
      const sample = db.samples.find(item => item.id === path[2]);
      if (!sample || !canReadSample(user, sample)) throw Object.assign(new Error("Sample not found"), { status: 404 });
      const qr = await QRCode.toDataURL(sampleQrPayload(sample, env, request), { margin: 0, width: 110, errorCorrectionLevel: "M" });
      return html(`<!doctype html><html><head><meta charset="utf-8"><title>${sample.sampleCode} label</title><style>body{font-family:Arial;margin:14px}.toolbar{margin-bottom:12px}.tube-label{width:38mm;height:18mm;border:1px solid #111;padding:1mm;display:grid;grid-template-columns:13mm 1fr;gap:1.5mm;align-items:center;overflow:hidden}.tube-label img{width:13mm;height:13mm}.tube-code{font-size:8px;font-weight:800}.tube-meta{font-size:6.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}@media print{.toolbar{display:none}body{margin:0}}</style></head><body><div class="toolbar"><button onclick="window.print()">Print QR Label</button></div><div class="tube-label"><img src="${qr}"><div><div class="tube-code">${sample.sampleCode}</div><div class="tube-meta">${sample.collectionSite || ""}</div></div></div></body></html>`);
    }
    if (path[2] === "bulk-tube-qr-labels") {
      const ids = String(url.searchParams.get("ids") || "").split(",").filter(Boolean);
      const samples = db.samples.filter(sample => ids.includes(sample.id) && canReadSample(user, sample));
      const labels = await Promise.all(samples.map(async sample => `<div class="tube-label"><img src="${await QRCode.toDataURL(sampleQrPayload(sample, env, request), { margin: 0, width: 92, errorCorrectionLevel: "M" })}"><div class="tube-code">${sample.sampleCode}</div><div class="tube-meta">${sample.collectionSite || ""}</div></div>`));
      return html(`<!doctype html><html><head><meta charset="utf-8"><title>QR Labels</title><style>body{font-family:Arial;margin:10px}.toolbar{margin-bottom:12px}.sheet{display:grid;grid-template-columns:repeat(4,38mm);gap:2mm}.tube-label{break-inside:avoid;width:38mm;height:18mm;border:1px solid #111;padding:1mm;display:grid;grid-template-columns:13mm 1fr;gap:1.5mm;align-items:center;overflow:hidden}.tube-label img{width:13mm;height:13mm}.tube-code{font-size:8px;font-weight:800}.tube-meta{font-size:6.5px}@media print{.toolbar{display:none}body{margin:0}.sheet{gap:0}}</style></head><body><div class="toolbar"><button onclick="window.print()">Print QR Labels</button></div><div class="sheet">${labels.join("")}</div></body></html>`);
    }
    if (path[3] === "report" || path[3] === "report.pdf") {
      const sample = db.samples.find(item => item.id === path[2]);
      if (!sample || !canReadSample(user, sample)) throw Object.assign(new Error("Sample not found"), { status: 404 });
      const rows = sample.results.map(r => `<tr><td>${r.parameter}</td><td>${r.value} ${r.unit}</td><td>${r.limit}</td><td>${r.method}</td><td>${r.flag}</td><td>${r.analyst}</td></tr>`).join("");
      return html(`<!doctype html><html><head><meta charset="utf-8"><title>${sample.sampleCode} report</title><style>body{font-family:Arial;margin:28px}table{border-collapse:collapse;width:100%;margin-top:14px}td,th{border:1px solid #999;padding:8px;text-align:left}@media print{button{display:none}}</style></head><body><button onclick="window.print()">Print Report</button><h1>${APP_NAME} - ${sample.sampleCode}</h1><p><b>Project:</b> ${sample.clientName}<br><b>Site:</b> ${sample.collectionSite}<br><b>Status:</b> ${sample.status}<br><b>Storage:</b> ${storageName(db, sample.storageLocationId)}</p><table><thead><tr><th>Parameter</th><th>Result</th><th>Limit</th><th>Method</th><th>Flag</th><th>Analyst</th></tr></thead><tbody>${rows || "<tr><td colspan='6'>No results entered</td></tr>"}</tbody></table></body></html>`);
    }
  }

  throw Object.assign(new Error("API route not found"), { status: 404 });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const response = await handle(request, env);
      const headers = new Headers(response.headers);
      Object.entries(cors).forEach(([key, value]) => headers.set(key, value));
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      return json({ error: error.message || "Worker error", errors: error.errors || undefined }, { status: error.status || 500, headers: cors });
    }
  }
};
