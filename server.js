const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const QRCode = require("qrcode");
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");
const readXlsxFile = require("read-excel-file/node");
const { Pool } = require("pg");
const { randomUUID: uuid } = require("crypto");

const app = express();
const PORT = process.env.PORT || 4317;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-before-production";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "true") === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "no-reply@lab.local";
const DATABASE_URL = process.env.DATABASE_URL || "";
const APP_NAME = "Plasma Lab LIMS";
const FRONTEND_PUBLIC_URL = process.env.FRONTEND_PUBLIC_URL || process.env.APP_PUBLIC_URL || "";
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || FRONTEND_PUBLIC_URL || "")
  .split(",")
  .map(item => item.trim())
  .filter(Boolean);
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || APP_NAME;
const root = __dirname;
const dataDir = path.join(root, "data");
const uploadDir = path.join(root, "uploads");
const exportDir = path.join(dataDir, "exports");
const dbPath = path.join(dataDir, "db.json");
let dbCache = null;
let pgPool = null;

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(exportDir, { recursive: true });

app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(root, "public")));
app.use("/uploads", express.static(uploadDir));

const upload = multer({
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 12
  },
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\- ]+/g, "_")}`)
  })
});

function now() {
  return new Date().toISOString();
}

function newDb() {
  const adminId = uuid();
  return {
    pendingSignups: [],
    passwordResets: [],
    users: [
      {
        id: adminId,
        name: "Lab Admin",
        email: "admin@lab.local",
        phone: "0000000000",
        passwordHash: bcrypt.hashSync("admin123", 10),
        role: "admin",
        active: true,
        createdAt: now()
      }
    ],
    people: [
      { id: uuid(), name: "Priya Nair", role: "Analyst", active: true },
      { id: uuid(), name: "Rahul Menon", role: "Analyst", active: true },
      { id: uuid(), name: "Mina Paul", role: "Sample Reception", active: true }
    ],
    storageLocations: [
      { id: uuid(), name: "Fridge 1 / Shelf A / Rack 01", type: "Fridge", active: true, isFull: false, capacityNote: "" },
      { id: uuid(), name: "Fridge 2 / Shelf C / Box 04", type: "Fridge", active: true, isFull: false, capacityNote: "" },
      { id: uuid(), name: "Quarantine Shelf / Tray Q1", type: "Quarantine", active: true, isFull: false, capacityNote: "" }
    ],
    tests: [
      { id: uuid(), name: "pH", unit: "pH", limit: "6.5-8.5", method: "Electrometric" },
      { id: uuid(), name: "TDS", unit: "mg/L", limit: "<500", method: "Conductivity calculation" },
      { id: uuid(), name: "Turbidity", unit: "NTU", limit: "<1", method: "Nephelometric" },
      { id: uuid(), name: "Nitrate", unit: "mg/L", limit: "<45", method: "UV screening" },
      { id: uuid(), name: "E. coli", unit: "/100 mL", limit: "Absent", method: "Membrane filtration" }
    ],
    samples: [],
    audit: []
  };
}

function readDb() {
  if (DATABASE_URL) {
    if (!dbCache) throw new Error("Database is still starting");
    normalizeDb(dbCache);
    return dbCache;
  }
  if (!fs.existsSync(dbPath)) {
    const seeded = newDb();
    writeDb(seeded);
    return seeded;
  }
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  normalizeDb(db);
  return db;
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
  db.users.forEach(user => {
    user.phone ||= "";
    if (user.role === "manager") user.role = "admin";
    if (user.role === "intake" || user.role === "viewer") user.role = "analyst";
  });
  db.samples.forEach(sample => {
    sample.dueAt ||= addDays(sample.createdAt || sample.receivedAt || now(), 3);
    sample.retentionStatus ||= "Active";
    sample.disposal ||= null;
    if (sample.status === "Received") sample.status = sample.storageLocationId ? "Stored" : "Sample Collected";
    sample.workflowStage ||= sample.status || "Bottle Ready";
  });
  db.storageLocations.forEach(location => {
    location.isFull = Boolean(location.isFull);
    location.capacityNote ||= "";
    location.active = location.active !== false;
  });
}

function writeDb(db) {
  db.meta ||= {};
  db.meta.lastWriteAt = now();
  db.meta.writeCount = Number(db.meta.writeCount || 0) + 1;
  if (DATABASE_URL) {
    dbCache = db;
    persistPostgres(db).catch(error => console.error("PostgreSQL write failed:", error.message));
    return;
  }
  const backupDir = path.join(dataDir, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(dbPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(dbPath, path.join(backupDir, `db-${stamp}.json`));
    const backups = fs.readdirSync(backupDir).filter(file => file.endsWith(".json")).sort();
    while (backups.length > 30) {
      fs.unlinkSync(path.join(backupDir, backups.shift()));
    }
  }
  const tempPath = `${dbPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(db, null, 2));
  fs.renameSync(tempPath, dbPath);
}

async function initDatabase() {
  if (!DATABASE_URL) return;
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
  });
  await pgPool.query(`
    create table if not exists lims_store (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
  const result = await pgPool.query("select data from lims_store where id = $1", ["primary"]);
  if (result.rows[0]?.data) {
    dbCache = result.rows[0].data;
    normalizeDb(dbCache);
    return;
  }
  dbCache = newDb();
  normalizeDb(dbCache);
  await persistPostgres(dbCache);
}

async function persistPostgres(db) {
  if (!pgPool) return;
  await pgPool.query(
    `insert into lims_store (id, data, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (id) do update set data = excluded.data, updated_at = now()`,
    ["primary", JSON.stringify(db)]
  );
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readableBackupHtml(db, exportedBy = "System", period = "manual") {
  const rows = db.samples.map(sample => `
    <tr>
      <td>${htmlEscape(sample.sampleCode)}</td>
      <td>${htmlEscape(sample.status)}</td>
      <td>${htmlEscape(sample.clientName)}</td>
      <td>${htmlEscape(sample.collectionSite)}</td>
      <td>${htmlEscape(sample.sourceType)}</td>
      <td>${htmlEscape(sample.assignedTo)}</td>
      <td>${htmlEscape(storageName(db, sample.storageLocationId))}</td>
      <td>${htmlEscape(sample.createdAt ? new Date(sample.createdAt).toLocaleString() : "")}</td>
      <td>${htmlEscape((sample.requestedTests || []).join(", "))}</td>
      <td>${htmlEscape((sample.results || []).map(result => `${result.parameter}: ${result.value} ${result.unit}`).join("; "))}</td>
      <td>${htmlEscape((sample.files || []).map(file => file.originalName).join("; "))}</td>
    </tr>`).join("");
  const auditRows = db.audit.slice(0, 250).map(item => `
    <tr><td>${htmlEscape(new Date(item.at).toLocaleString())}</td><td>${htmlEscape(item.userName)}</td><td>${htmlEscape(item.action)}</td><td>${htmlEscape(item.entity)}</td><td>${htmlEscape(item.detail)}</td></tr>
  `).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME} Backup</title>
  <style>body{font-family:Arial,sans-serif;margin:24px;color:#111}h1{font-size:24px}h2{margin-top:28px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #999;padding:6px;text-align:left;vertical-align:top}th{background:#eef2f5}.summary{display:flex;gap:12px;flex-wrap:wrap}.summary div{border:1px solid #bbb;padding:10px;min-width:130px}</style>
  </head><body><h1>${APP_NAME} Readable Backup</h1><p>Type: ${htmlEscape(period)}<br>Exported ${new Date().toLocaleString()} by ${htmlEscape(exportedBy)}</p>
  <div class="summary"><div><b>Samples</b><br>${db.samples.length}</div><div><b>Users</b><br>${db.users.length}</div><div><b>Storage locations</b><br>${db.storageLocations.length}</div><div><b>Tests</b><br>${db.tests.length}</div></div>
  <h2>Samples</h2><table><thead><tr><th>Sample ID</th><th>Status</th><th>Client</th><th>Site</th><th>Source</th><th>Analyst</th><th>Storage</th><th>Created</th><th>Tests</th><th>Results</th><th>Files</th></tr></thead><tbody>${rows || "<tr><td colspan='11'>No samples</td></tr>"}</tbody></table>
  <h2>Recent Activity Log</h2><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead><tbody>${auditRows || "<tr><td colspan='5'>No activity</td></tr>"}</tbody></table></body></html>`;
}

function exportFileName(period, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  if (period === "weekly") return `weekly-${weekKey(date)}.html`;
  return `daily-${day}.html`;
}

function weekKey(date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function createReadableExport(period = "daily", exportedBy = "System", overwrite = false) {
  const fileName = exportFileName(period);
  const filePath = path.join(exportDir, fileName);
  if (!overwrite && fs.existsSync(filePath)) return { fileName, created: false };
  fs.writeFileSync(filePath, readableBackupHtml(readDb(), exportedBy, period));
  return { fileName, created: true };
}

function runScheduledExports() {
  createReadableExport("daily", "Automatic scheduler", false);
  createReadableExport("weekly", "Automatic scheduler", false);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || "",
    role: user.role,
    active: user.active,
    createdAt: user.createdAt
  };
}

function otpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function otpExpiry() {
  return new Date(Date.now() + 10 * 60 * 1000).toISOString();
}

function validOtp(record, emailOtp) {
  return record &&
    new Date(record.expiresAt).getTime() > Date.now() &&
    record.emailOtp === String(emailOtp || "").trim();
}

function validSingleOtp(record, field, code) {
  return record &&
    new Date(record.expiresAt).getTime() > Date.now() &&
    record[field] === String(code || "").trim();
}

async function sendEmailOtp(email, code) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.log(`[LOCAL OTP] ${email}: ${code}`);
    return { sent: false, provider: "local-console" };
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  await transporter.sendMail({
    from: `"${SMTP_FROM_NAME}" <${SMTP_FROM}>`,
    to: email,
    subject: `${APP_NAME} email verification`,
    html: `<p>Your ${APP_NAME} email OTP is <b>${code}</b>.</p><p>This code expires in 10 minutes.</p>`
  });
  return { sent: true, provider: "gmail-smtp" };
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || "").trim());
}

function validPhone(countryCode, phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return /^\+\d{1,4}$/.test(String(countryCode || "")) && digits.length >= 6 && digits.length <= 15;
}

function addAudit(db, user, action, entity, entityId, detail) {
  db.audit.unshift({
    id: uuid(),
    at: now(),
    userId: user?.id || "system",
    userName: user?.name || "System",
    action,
    entity,
    entityId,
    detail
  });
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

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result.toISOString();
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

function frontendOrigin(req) {
  if (FRONTEND_PUBLIC_URL) return FRONTEND_PUBLIC_URL.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function sampleQrPayload(sample, req) {
  return `${frontendOrigin(req)}/?sample=${encodeURIComponent(sample.sampleCode)}`;
}

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "") || req.query.token;
  if (!token) return res.status(401).json({ error: "Login required" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = readDb();
    const user = db.users.find(item => item.id === decoded.id && item.active);
    if (!user) return res.status(401).json({ error: "Invalid user" });
    req.user = user;
    req.db = db;
    next();
  } catch {
    res.status(401).json({ error: "Invalid session" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Not allowed" });
    next();
  };
}

function canReadSample(user, sample) {
  if (user.role === "admin") return true;
  if (user.role === "analyst") return !sample.assignedTo || sample.assignedTo === user.name;
  return false;
}

function canWorkOnSample(user, sample) {
  if (user.role === "admin") return true;
  if (user.role === "analyst") return !sample.assignedTo || sample.assignedTo === user.name;
  return false;
}

function nextSampleId(db) {
  const year = new Date().getFullYear();
  const nums = db.samples
    .map(sample => sample.sampleCode)
    .filter(code => code && code.includes(`PL-${year}-`))
    .map(code => Number(code.split("-").pop()))
    .filter(Boolean);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `PL-${year}-${String(next).padStart(6, "0")}`;
}

function createSampleRecord(db, user, body) {
  if (!storageIsAvailable(db, body.storageLocationId)) throw new Error("Selected storage is full or inactive");
  const sample = {
    id: uuid(),
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
    requestedTests: body.requestedTests || [],
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
  if (!body.clientName || !body.collectionSite || !body.sourceType || !body.collector) {
    return "Project/client, site, source type, and brought by are required";
  }
  if (!Array.isArray(body.requestedTests) || body.requestedTests.length === 0) return "Choose at least one requested test";
  return "";
}

function excelRows(raw) {
  const rows = Array.isArray(raw) && raw[0]?.data ? raw[0].data : raw;
  return (Array.isArray(rows) ? rows : [])
    .filter(row => Array.isArray(row))
    .filter(row => row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== ""));
}

function safeDateIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

app.post("/api/signup/email/start", async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: "Name and email are required" });
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address" });
  const db = readDb();
  if (db.users.some(user => user.active && user.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: "Email already exists" });
  }
  db.pendingSignups = db.pendingSignups.filter(item => item.email.toLowerCase() !== email.toLowerCase());
  const emailOtp = otpCode();
  const pending = {
    id: uuid(),
    name,
    email,
    countryCode: "",
    phone: "",
    passwordHash: "",
    emailOtp,
    emailVerified: false,
    expiresAt: otpExpiry(),
    createdAt: now()
  };
  db.pendingSignups.push(pending);
  await sendEmailOtp(email, emailOtp);
  addAudit(db, null, "Sent signup email OTP", "user", pending.id, `${name} requested email verification`);
  writeDb(db);
  res.json({
    pendingId: pending.id,
    expiresAt: pending.expiresAt
  });
});

app.post("/api/signup/email/verify", (req, res) => {
  const { pendingId, emailOtp } = req.body;
  const db = readDb();
  const pending = db.pendingSignups.find(item => item.id === pendingId);
  if (!validSingleOtp(pending, "emailOtp", emailOtp)) return res.status(400).json({ error: "Invalid or expired email OTP" });
  pending.emailVerified = true;
  pending.expiresAt = otpExpiry();
  addAudit(db, null, "Verified signup email", "user", pending.id, pending.email);
  writeDb(db);
  res.json({ pendingId: pending.id, ok: true });
});

app.post("/api/signup/phone/save", (req, res) => {
  const { pendingId, countryCode, phone } = req.body;
  if (!validPhone(countryCode, phone)) return res.status(400).json({ error: "Enter a valid country code and phone number" });
  const db = readDb();
  const pending = db.pendingSignups.find(item => item.id === pendingId);
  if (!pending || !pending.emailVerified) return res.status(400).json({ error: "Verify email first" });
  if (db.users.some(user => user.active && String(user.countryCode || "") === String(countryCode) && String(user.phone || "") === String(phone))) return res.status(409).json({ error: "Phone already exists" });
  pending.countryCode = countryCode;
  pending.phone = String(phone).replace(/\D/g, "");
  pending.expiresAt = otpExpiry();
  addAudit(db, null, "Saved signup phone", "user", pending.id, `${countryCode} ${pending.phone}`);
  writeDb(db);
  res.json({ pendingId: pending.id, ok: true });
});

app.post("/api/signup/complete", async (req, res) => {
  const { pendingId, password, confirmPassword } = req.body;
  if (!password || String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  if (password !== confirmPassword) return res.status(400).json({ error: "Passwords do not match" });
  const db = readDb();
  const pending = db.pendingSignups.find(item => item.id === pendingId);
  if (!pending || !pending.emailVerified || !pending.phone) return res.status(400).json({ error: "Verify email and enter phone before creating password" });
  const role = db.users.length === 0 ? "admin" : "analyst";
  db.users
    .filter(item => !item.active && item.email.toLowerCase() === pending.email.toLowerCase())
    .forEach(item => {
      item.replacedAt = now();
      item.replacedByEmail = pending.email;
    });
  const user = {
    id: uuid(),
    name: pending.name,
    email: pending.email,
    countryCode: pending.countryCode,
    phone: pending.phone,
    passwordHash: await bcrypt.hash(password, 10),
    role,
    active: true,
    createdAt: now()
  };
  db.users.push(user);
  db.pendingSignups = db.pendingSignups.filter(item => item.id !== pendingId);
  addAudit(db, user, "Verified signup", "user", user.id, `${user.name} created a verified account`);
  writeDb(db);
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "12h" });
  res.json({ token, user: publicUser(user) });
});

app.post("/api/signup/resend", async (req, res) => {
  const db = readDb();
  const pending = db.pendingSignups.find(item => item.id === req.body.pendingId);
  if (!pending) return res.status(404).json({ error: "Signup request not found" });
  pending.expiresAt = otpExpiry();
  pending.emailOtp = otpCode();
  await sendEmailOtp(pending.email, pending.emailOtp);
  addAudit(db, null, "Resent signup OTP", "user", pending.id, "email code refreshed");
  writeDb(db);
  res.json({
    pendingId: pending.id,
    expiresAt: pending.expiresAt
  });
});

app.post("/api/password-reset/start", (req, res) => {
  const db = readDb();
  const identifier = String(req.body.identifier || "").toLowerCase();
  const user = db.users.find(item => item.active && item.email.toLowerCase() === identifier);
  if (!user) return res.status(404).json({ error: "No matching registered user found" });
  db.passwordResets = db.passwordResets.filter(item => item.userId !== user.id);
  const reset = { id: uuid(), userId: user.id, emailOtp: otpCode(), expiresAt: otpExpiry(), createdAt: now() };
  db.passwordResets.push(reset);
  addAudit(db, user, "Started password reset", "user", user.id, "Password reset OTP generated");
  writeDb(db);
  sendEmailOtp(user.email, reset.emailOtp)
    .then(() => res.json({
      resetId: reset.id,
      expiresAt: reset.expiresAt
    }))
    .catch(error => res.status(502).json({ error: error.message }));
});

app.post("/api/password-reset/confirm", async (req, res) => {
  const { resetId, emailOtp, password } = req.body;
  if (!password || String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const db = readDb();
  const reset = db.passwordResets.find(item => item.id === resetId);
  if (!validOtp(reset, emailOtp)) return res.status(400).json({ error: "Invalid or expired email OTP" });
  const user = db.users.find(item => item.id === reset.userId && item.active);
  if (!user) return res.status(404).json({ error: "User not found" });
  user.passwordHash = await bcrypt.hash(password, 10);
  db.passwordResets = db.passwordResets.filter(item => item.id !== resetId);
  addAudit(db, user, "Reset password", "user", user.id, "Password changed after OTP verification");
  writeDb(db);
  res.json({ ok: true });
});

app.post("/api/login", async (req, res) => {
  const { email, password, rememberMe } = req.body;
  const db = readDb();
  const user = db.users.find(item => item.email.toLowerCase() === String(email || "").toLowerCase() && item.active);
  if (!user || !(await bcrypt.compare(password || "", user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  addAudit(db, user, "Logged in", "user", user.id, "User session started");
  writeDb(db);
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: rememberMe ? "30d" : "12h" });
  res.json({ token, user: publicUser(user) });
});

app.get("/api/bootstrap", auth, (req, res) => {
  const db = req.db;
  const isAdmin = req.user.role === "admin";
  const visibleSamples = db.samples.filter(sample => {
    if (isAdmin) return true;
    if (req.user.role === "analyst") return !sample.assignedTo || sample.assignedTo === req.user.name;
    return false;
  });
  res.json({
    user: publicUser(req.user),
    users: isAdmin ? db.users.map(publicUser) : [],
    people: db.people,
    storageLocations: db.storageLocations,
    tests: db.tests,
    samples: visibleSamples,
    audit: isAdmin ? db.audit.slice(0, 200) : []
  });
});

app.get("/api/validate/signup", (req, res) => {
  const db = readDb();
  const email = String(req.query.email || "").trim().toLowerCase();
  const countryCode = String(req.query.countryCode || "").trim();
  const phone = String(req.query.phone || "").replace(/\D/g, "");
  const emailLooksValid = validEmail(email);
  const emailAvailable = emailLooksValid && !db.users.some(user => user.active && user.email.toLowerCase() === email);
  const phoneLooksValid = phone ? validPhone(countryCode, phone) : false;
  const phoneAvailable = phoneLooksValid && !db.users.some(user => user.active && String(user.countryCode || "") === countryCode && String(user.phone || "") === phone);
  res.json({
    email: {
      valid: emailLooksValid,
      available: emailAvailable,
      message: !email ? "" : !emailLooksValid ? "Invalid email format" : emailAvailable ? "Email looks valid and available" : "Email is already registered"
    },
    phone: {
      valid: phoneLooksValid,
      available: phoneAvailable,
      normalized: phone,
      message: !phone ? "" : !phoneLooksValid ? "Invalid phone number" : phoneAvailable ? "Phone looks valid and available" : "Phone is already registered"
    }
  });
});

app.get("/api/alerts", auth, (req, res) => {
  const samples = req.db.samples.filter(sample => canReadSample(req.user, sample));
  res.json({
    overdue: samples.filter(sample => sampleDueState(sample) === "overdue"),
    dueSoon: samples.filter(sample => sampleDueState(sample) === "due-soon"),
    waitingUpload: samples.filter(sample => !(sample.files || []).some(file => file.category.includes("Book") || file.category.includes("Written Record"))),
    waitingApproval: samples.filter(sample => sample.status === "Needs Review" || sample.status === "Results Entered"),
    disposalReady: samples.filter(sample => sample.status === "Approved" && sample.retentionStatus === "Active")
  });
});

app.get("/api/backup", auth, requireRole("admin"), (req, res) => {
  const db = req.db;
  addAudit(db, req.user, "Exported backup", "system", "backup", "Readable HTML backup downloaded");
  writeDb(db);
  res.setHeader("Content-Disposition", `attachment; filename="plasma-lab-readable-backup-${new Date().toISOString().slice(0, 10)}.html"`);
  res.type("text/html").send(readableBackupHtml(db, req.user.name, "manual"));
});

app.get("/api/exports", auth, requireRole("admin"), (req, res) => {
  runScheduledExports();
  const files = fs.readdirSync(exportDir)
    .filter(file => file.endsWith(".html"))
    .map(file => {
      const stat = fs.statSync(path.join(exportDir, file));
      return {
        file,
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
        type: file.startsWith("weekly") ? "weekly" : "daily"
      };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const db = req.db;
  const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  res.json({
    files,
    health: {
      database: "OK",
      samples: db.samples.length,
      users: db.users.length,
      auditEntries: db.audit.length,
      uploadedFiles: db.samples.reduce((total, sample) => total + (sample.files || []).length, 0),
      dbSize,
      lastWriteAt: db.meta?.lastWriteAt || "",
      writeCount: db.meta?.writeCount || 0,
      storage: "Local JSON with atomic write, rotating raw backups, and scheduled readable exports"
    }
  });
});

app.post("/api/exports/run", auth, requireRole("admin"), (req, res) => {
  const period = req.body.period === "weekly" ? "weekly" : "daily";
  const result = createReadableExport(period, req.user.name, true);
  addAudit(req.db, req.user, `Created ${period} export`, "system", result.fileName, "Readable export generated");
  writeDb(req.db);
  res.json(result);
});

app.get("/api/exports/:file", auth, requireRole("admin"), (req, res) => {
  const file = path.basename(req.params.file);
  if (!/^(daily|weekly)-[\w-]+\.html$/.test(file)) return res.status(400).send("Invalid export file");
  const filePath = path.join(exportDir, file);
  if (!fs.existsSync(filePath)) return res.status(404).send("Export not found");
  res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
  res.type("text/html").send(fs.readFileSync(filePath, "utf8"));
});

app.post("/api/users", auth, requireRole("admin"), async (req, res) => {
  const { name, email, phone, password, role } = req.body;
  if (!name || !email || !phone || !password || !role) return res.status(400).json({ error: "All fields are required" });
  if (!["admin", "analyst"].includes(role)) return res.status(400).json({ error: "Choose admin/manager or analyst" });
  const db = req.db;
  if (db.users.some(user => user.active && user.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: "Email already exists" });
  db.users
    .filter(user => !user.active && user.email.toLowerCase() === email.toLowerCase())
    .forEach(user => {
      user.replacedAt = now();
      user.replacedByEmail = email;
    });
  const user = { id: uuid(), name, email, phone, passwordHash: await bcrypt.hash(password, 10), role, active: true, createdAt: now() };
  db.users.push(user);
  addAudit(db, req.user, "Created user", "user", user.id, `${name} added as ${role}`);
  writeDb(db);
  res.json(publicUser(user));
});

app.patch("/api/users/:id", auth, requireRole("admin"), (req, res) => {
  const db = req.db;
  const user = db.users.find(item => item.id === req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const before = { role: user.role, active: user.active };
  if (req.body.role) {
    if (!["admin", "analyst"].includes(req.body.role)) return res.status(400).json({ error: "Choose admin/manager or analyst" });
    user.role = req.body.role;
  }
  if (typeof req.body.active === "boolean") user.active = req.body.active;
  addAudit(db, req.user, "Modified user", "user", user.id, `${user.name}: ${JSON.stringify(before)} -> role=${user.role}, active=${user.active}`);
  writeDb(db);
  res.json(publicUser(user));
});

app.delete("/api/users/:id", auth, requireRole("admin"), (req, res) => {
  const db = req.db;
  const user = db.users.find(item => item.id === req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.id === req.user.id) return res.status(400).json({ error: "You cannot delete your own login" });
  user.active = false;
  user.deletedAt = now();
  user.deletedBy = req.user.name;
  addAudit(db, req.user, "Deleted user login", "user", user.id, `${user.name} was deactivated and can no longer login`);
  writeDb(db);
  res.json(publicUser(user));
});

app.post("/api/people", auth, requireRole("admin"), (req, res) => {
  const db = req.db;
  const item = { id: uuid(), name: req.body.name, role: req.body.role || "Analyst", active: true };
  if (!item.name) return res.status(400).json({ error: "Person name is required" });
  db.people.push(item);
  addAudit(db, req.user, "Added person", "person", item.id, `${item.name} (${item.role})`);
  writeDb(db);
  res.json(item);
});

app.patch("/api/people/:id", auth, requireRole("admin"), (req, res) => {
  const db = req.db;
  const item = db.people.find(person => person.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Person not found" });
  if (req.body.name) item.name = req.body.name;
  if (req.body.role) item.role = req.body.role;
  if (typeof req.body.active === "boolean") item.active = req.body.active;
  addAudit(db, req.user, "Modified person", "person", item.id, `${item.name} (${item.role}) active=${item.active}`);
  writeDb(db);
  res.json(item);
});

app.post("/api/storage-locations", auth, requireRole("admin"), (req, res) => {
  const db = req.db;
  const item = { id: uuid(), name: req.body.name, type: req.body.type || "Storage", active: true, isFull: Boolean(req.body.isFull), capacityNote: req.body.capacityNote || "" };
  if (!item.name) return res.status(400).json({ error: "Storage name is required" });
  db.storageLocations.push(item);
  addAudit(db, req.user, "Added storage", "storage", item.id, `${item.name} (${item.type})`);
  writeDb(db);
  res.json(item);
});

app.patch("/api/storage-locations/:id", auth, requireRole("admin"), (req, res) => {
  const db = req.db;
  const item = db.storageLocations.find(location => location.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Storage location not found" });
  if (req.body.name) item.name = req.body.name;
  if (req.body.type) item.type = req.body.type;
  if (typeof req.body.isFull === "boolean") item.isFull = req.body.isFull;
  if ("capacityNote" in req.body) item.capacityNote = req.body.capacityNote || "";
  if (typeof req.body.active === "boolean") item.active = req.body.active;
  addAudit(db, req.user, "Modified storage", "storage", item.id, `${item.name} (${item.type}) active=${item.active} full=${item.isFull}`);
  writeDb(db);
  res.json(item);
});

app.post("/api/tests", auth, requireRole("admin"), (req, res) => {
  const db = req.db;
  const item = { id: uuid(), name: req.body.name, unit: req.body.unit || "", limit: req.body.limit || "", method: req.body.method || "" };
  if (!item.name) return res.status(400).json({ error: "Test name is required" });
  db.tests.push(item);
  addAudit(db, req.user, "Added test", "test", item.id, `${item.name}`);
  writeDb(db);
  res.json(item);
});

app.patch("/api/tests/:id", auth, requireRole("admin"), (req, res) => {
  const db = req.db;
  const item = db.tests.find(test => test.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Test not found" });
  if (req.body.name) item.name = req.body.name;
  item.unit = req.body.unit ?? item.unit;
  item.limit = req.body.limit ?? item.limit;
  item.method = req.body.method ?? item.method;
  item.active = req.body.active ?? item.active ?? true;
  addAudit(db, req.user, "Modified test", "test", item.id, `${item.name} ${item.unit} ${item.limit}`);
  writeDb(db);
  res.json(item);
});

app.post("/api/samples", auth, requireRole("admin"), (req, res) => {
  const db = req.db;
  const error = validateSampleBody(req.body);
  if (error) return res.status(400).json({ error });
  let sample;
  try {
    sample = createSampleRecord(db, req.user, req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  addAudit(db, req.user, "Prepared bottle label", "sample", sample.id, `${sample.sampleCode} created`);
  writeDb(db);
  res.json(sample);
});

app.post("/api/samples/bulk", auth, requireRole("admin"), (req, res) => {
  const db = req.db;
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: "Add at least one sample row" });
  const created = [];
  const errors = [];
  rows.slice(0, 250).forEach((row, index) => {
    const body = {
      clientName: row.clientName,
      sourceType: row.sourceType,
      collectionSite: row.collectionSite,
      collector: row.collector,
      storageLocationId: row.storageLocationId || req.body.storageLocationId,
      assignedTo: row.assignedTo || req.body.assignedTo || "",
      requestedTests: Array.isArray(row.requestedTests) ? row.requestedTests : String(row.requestedTests || req.body.requestedTests || "").split(/[,;]/).map(item => item.trim()).filter(Boolean),
      notes: row.notes || "",
      dueAt: row.dueAt || req.body.dueAt || ""
    };
    const error = validateSampleBody(body);
    if (error) {
      errors.push({ row: index + 1, error });
      return;
    }
    try {
      const sample = createSampleRecord(db, req.user, body);
      created.push(sample);
    } catch (error) {
      errors.push({ row: index + 1, error: error.message });
    }
  });
  if (!created.length) return res.status(400).json({ error: "No samples could be created", errors });
  addAudit(db, req.user, "Bulk created samples", "sample", "bulk", `${created.length} samples created`);
  writeDb(db);
  res.json({ created, errors });
});

app.post("/api/samples/bulk/excel", auth, requireRole("admin"), upload.single("file"), async (req, res) => {
  const db = req.db;
  if (!req.file) return res.status(400).json({ error: "Upload an Excel file" });
  const dataRows = excelRows(await readXlsxFile(req.file.path));
  if (!dataRows.length) return res.status(400).json({ error: "Excel file is empty" });
  const header = dataRows[0].map(cell => String(cell || "").toLowerCase().trim());
  const indexOf = names => {
    for (const name of names) {
      const index = header.indexOf(name);
      if (index >= 0) return index;
    }
    return -1;
  };
  const indexes = {
    clientName: indexOf(["client", "client name", "project"]),
    sourceType: indexOf(["source", "source type", "type"]),
    collectionSite: indexOf(["site", "collection site", "location"]),
    collector: indexOf(["collector", "collected by"]),
    storageLocation: indexOf(["storage", "storage location"]),
    analyst: indexOf(["analyst", "assigned to"]),
    requestedTests: indexOf(["tests", "requested tests"]),
    dueAt: indexOf(["due", "due at", "target completion"]),
    notes: indexOf(["notes", "remarks"])
  };
  const resolveStorage = value => db.storageLocations.find(item => item.id === value || item.name.toLowerCase() === String(value || "").toLowerCase())?.id || req.body.storageLocationId || "";
  const cell = (row, key) => indexes[key] >= 0 ? String(row[indexes[key]] ?? "").trim() : "";
  const created = [];
  const errors = [];
  dataRows.slice(1, 251).forEach((row, index) => {
    const body = {
      clientName: cell(row, "clientName"),
      sourceType: cell(row, "sourceType"),
      collectionSite: cell(row, "collectionSite"),
      collector: cell(row, "collector"),
      storageLocationId: resolveStorage(cell(row, "storageLocation")),
      assignedTo: cell(row, "analyst"),
      requestedTests: cell(row, "requestedTests").split(/[,;]/).map(item => item.trim()).filter(Boolean),
      dueAt: safeDateIso(cell(row, "dueAt")),
      notes: cell(row, "notes")
    };
    const error = validateSampleBody(body);
    if (error) {
      errors.push({ row: index + 2, error });
      return;
    }
    try {
      created.push(createSampleRecord(db, req.user, body));
    } catch (error) {
      errors.push({ row: index + 2, error: error.message });
    }
  });
  if (!created.length) return res.status(400).json({ error: "No samples could be created", errors });
  addAudit(db, req.user, "Bulk imported samples", "sample", "bulk", `${created.length} samples from ${req.file.originalname}`);
  writeDb(db);
  res.json({ created, errors });
});

app.patch("/api/samples/:id", auth, requireRole("admin", "analyst"), (req, res) => {
  const db = req.db;
  const sample = db.samples.find(item => item.id === req.params.id);
  if (!sample) return res.status(404).json({ error: "Sample not found" });
  if (!canWorkOnSample(req.user, sample)) return res.status(403).json({ error: "Not allowed for this sample" });
  const previousStorageId = sample.storageLocationId || "";
  if ("storageLocationId" in req.body && !storageIsAvailable(db, req.body.storageLocationId, previousStorageId)) {
    return res.status(400).json({ error: "Selected storage is full or inactive" });
  }
  const allowed = ["status", "assignedTo", "storageLocationId", "notes", "dueAt"];
  const changed = [];
  for (const key of allowed) {
    if (key in req.body) {
      sample[key] = req.body[key];
      changed.push(key);
    }
  }
  if ("storageLocationId" in req.body && previousStorageId !== req.body.storageLocationId) {
    sample.chainOfCustody.unshift({
      at: now(),
      by: req.user.name,
      action: "Storage moved",
      fromLocationId: previousStorageId,
      toLocationId: req.body.storageLocationId || "",
      locationId: req.body.storageLocationId || "",
      note: req.body.movementNote || req.body.notes || ""
    });
  }
  if ("assignedTo" in req.body && req.body.assignedTo) {
    sample.chainOfCustody.unshift({ at: now(), by: req.user.name, action: `Assigned to ${req.body.assignedTo}`, locationId: sample.storageLocationId || "" });
  }
  if ("status" in req.body) {
    sample.workflowStage = req.body.status;
  }
  sample.updatedAt = now();
  addAudit(db, req.user, "Modified sample", "sample", sample.id, `${sample.sampleCode}: ${changed.join(", ")}`);
  writeDb(db);
  res.json(sample);
});

app.post("/api/samples/:id/results", auth, requireRole("admin", "analyst"), (req, res) => {
  const db = req.db;
  const sample = db.samples.find(item => item.id === req.params.id);
  if (!sample) return res.status(404).json({ error: "Sample not found" });
  if (!canWorkOnSample(req.user, sample)) return res.status(403).json({ error: "Not allowed for this sample" });
  const result = {
    id: uuid(),
    parameter: req.body.parameter,
    value: req.body.value,
    unit: req.body.unit || "",
    limit: req.body.limit || "",
    method: req.body.method || "",
    analyst: req.user.name,
    flag: req.body.flag || "OK",
    bookPage: req.body.bookPage || "",
    enteredAt: now()
  };
  if (!result.parameter || !result.value) return res.status(400).json({ error: "Parameter and value are required" });
  sample.results.unshift(result);
  sample.status = result.flag === "Alert" ? "Flagged" : "Results Entered";
  sample.workflowStage = sample.status;
  sample.updatedAt = now();
  addAudit(db, req.user, "Entered result", "sample", sample.id, `${sample.sampleCode}: ${result.parameter} = ${result.value} ${result.unit}`);
  writeDb(db);
  res.json(sample);
});

app.post("/api/samples/:id/results/bulk", auth, requireRole("admin", "analyst"), (req, res) => {
  const db = req.db;
  const sample = db.samples.find(item => item.id === req.params.id);
  if (!sample) return res.status(404).json({ error: "Sample not found" });
  if (!canWorkOnSample(req.user, sample)) return res.status(403).json({ error: "Not allowed for this sample" });
  const rows = String(req.body.rows || "")
    .split(/\r?\n/)
    .map(row => row.trim())
    .filter(Boolean)
    .map(row => row.split(/,|\t/).map(cell => cell.trim()));
  const results = rows.map(row => ({
    id: uuid(),
    parameter: row[0],
    value: row[1],
    unit: row[2] || "",
    limit: row[3] || "",
    method: row[4] || "",
    analyst: req.user.name,
    flag: row[5] || "OK",
    bookPage: req.body.bookPage || "",
    enteredAt: now()
  })).filter(result => result.parameter && result.value);
  sample.results.unshift(...results);
  sample.status = results.some(result => result.flag === "Alert") ? "Flagged" : "Results Entered";
  sample.workflowStage = sample.status;
  sample.updatedAt = now();
  addAudit(db, req.user, "Bulk entered results", "sample", sample.id, `${sample.sampleCode}: ${results.length} rows`);
  writeDb(db);
  res.json(sample);
});

app.post("/api/samples/:id/results/sheet", auth, requireRole("admin", "analyst"), (req, res) => {
  const db = req.db;
  const sample = db.samples.find(item => item.id === req.params.id);
  if (!sample) return res.status(404).json({ error: "Sample not found" });
  if (!canWorkOnSample(req.user, sample)) return res.status(403).json({ error: "Not allowed for this sample" });
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const results = rows.map(row => ({
    id: uuid(),
    parameter: row.parameter,
    value: row.value,
    unit: row.unit || "",
    limit: row.limit || "",
    method: row.method || "",
    analyst: req.user.name,
    flag: row.flag || "OK",
    bookPage: row.bookPage || req.body.bookPage || "",
    enteredAt: now()
  })).filter(result => result.parameter && result.value);
  if (!results.length) return res.status(400).json({ error: "Enter at least one result row" });
  sample.results.unshift(...results);
  sample.status = results.some(result => result.flag === "Alert") ? "Flagged" : "Results Entered";
  sample.workflowStage = sample.status;
  sample.updatedAt = now();
  addAudit(db, req.user, "Entered sheet results", "sample", sample.id, `${sample.sampleCode}: ${results.length} sheet rows`);
  writeDb(db);
  res.json(sample);
});

app.post("/api/samples/:id/results/excel", auth, requireRole("admin", "analyst"), upload.single("file"), async (req, res) => {
  const db = req.db;
  const sample = db.samples.find(item => item.id === req.params.id);
  if (!sample) return res.status(404).json({ error: "Sample not found" });
  if (!canWorkOnSample(req.user, sample)) return res.status(403).json({ error: "Not allowed for this sample" });
  if (!req.file) return res.status(400).json({ error: "Upload an Excel file" });
  const dataRows = excelRows(await readXlsxFile(req.file.path));
  if (!dataRows.length) return res.status(400).json({ error: "Excel file is empty" });
  const header = dataRows[0].map(cell => String(cell || "").toLowerCase().trim());
  const hasHeader = header.includes("parameter") || header.includes("value") || header.includes("result");
  const bodyRows = hasHeader ? dataRows.slice(1) : dataRows;
  const indexOf = names => {
    for (const name of names) {
      const index = header.indexOf(name);
      if (index >= 0) return index;
    }
    return -1;
  };
  const indexes = {
    parameter: hasHeader ? indexOf(["parameter", "test", "analysis"]) : 0,
    value: hasHeader ? indexOf(["value", "result", "reading"]) : 1,
    unit: hasHeader ? indexOf(["unit", "units"]) : 2,
    limit: hasHeader ? indexOf(["limit", "standard", "acceptable limit"]) : 3,
    method: hasHeader ? indexOf(["method", "test method"]) : 4,
    flag: hasHeader ? indexOf(["flag", "status"]) : 5
  };
  const cell = (row, key) => indexes[key] >= 0 ? String(row[indexes[key]] ?? "").trim() : "";
  const results = bodyRows.map(row => ({
    id: uuid(),
    parameter: cell(row, "parameter"),
    value: cell(row, "value"),
    unit: cell(row, "unit"),
    limit: cell(row, "limit"),
    method: cell(row, "method"),
    analyst: req.user.name,
    flag: cell(row, "flag") || "OK",
    bookPage: "",
    enteredAt: now()
  })).filter(result => result.parameter && result.value);
  if (!results.length) return res.status(400).json({ error: "No valid result rows found" });
  sample.results.unshift(...results);
  sample.files.unshift({
    id: uuid(),
    originalName: req.file.originalname,
    storedName: req.file.filename,
    url: `/uploads/${req.file.filename}`,
    category: "Excel Result Import",
    uploadedBy: req.user.name,
    uploadedAt: now()
  });
  sample.status = results.some(result => result.flag === "Alert") ? "Flagged" : "Results Entered";
  sample.workflowStage = sample.status;
  sample.updatedAt = now();
  addAudit(db, req.user, "Imported Excel results", "sample", sample.id, `${sample.sampleCode}: ${results.length} rows from ${req.file.originalname}`);
  writeDb(db);
  res.json(sample);
});

app.post("/api/samples/:id/files", auth, requireRole("admin", "analyst"), upload.array("files", 12), (req, res) => {
  const db = req.db;
  const sample = db.samples.find(item => item.id === req.params.id);
  if (!sample) return res.status(404).json({ error: "Sample not found" });
  if (!canWorkOnSample(req.user, sample)) return res.status(403).json({ error: "Not allowed for this sample" });
  const category = req.body.category || "Analysis Upload";
  const files = (req.files || []).map(file => ({
    id: uuid(),
    originalName: file.originalname,
    storedName: file.filename,
    url: `/uploads/${file.filename}`,
    category,
    uploadedBy: req.user.name,
    uploadedAt: now()
  }));
  sample.files.unshift(...files);
  sample.updatedAt = now();
  addAudit(db, req.user, "Uploaded files", "sample", sample.id, `${sample.sampleCode}: ${files.map(file => file.originalName).join(", ")}`);
  writeDb(db);
  res.json(sample);
});

app.post("/api/samples/:id/approve", auth, requireRole("admin"), (req, res) => {
  const db = req.db;
  const sample = db.samples.find(item => item.id === req.params.id);
  if (!sample) return res.status(404).json({ error: "Sample not found" });
  if (!sample.results || sample.results.length === 0) return res.status(400).json({ error: "Enter results before approval" });
  if (!(sample.files || []).some(file => file.category.includes("Written Record") || file.category.includes("Book"))) {
    return res.status(400).json({ error: "Upload written record before approval" });
  }
  sample.status = "Approved";
  sample.workflowStage = "Approved";
  sample.reviewedBy = req.user.name;
  sample.reviewedAt = now();
  sample.updatedAt = now();
  addAudit(db, req.user, "Approved sample", "sample", sample.id, `${sample.sampleCode} approved`);
  writeDb(db);
  res.json(sample);
});

app.post("/api/samples/:id/lifecycle", auth, requireRole("admin"), (req, res) => {
  const db = req.db;
  const sample = db.samples.find(item => item.id === req.params.id);
  if (!sample) return res.status(404).json({ error: "Sample not found" });
  if (!canWorkOnSample(req.user, sample)) return res.status(403).json({ error: "Not allowed for this sample" });
  const action = req.body.action;
  if (!["Retained", "Disposed", "Active"].includes(action)) return res.status(400).json({ error: "Invalid lifecycle action" });
  sample.retentionStatus = action;
  if (action === "Disposed") {
    sample.status = "Disposed";
    sample.workflowStage = "Disposed";
  }
  sample.disposal = action === "Disposed" ? {
    disposedAt: now(),
    disposedBy: req.user.name,
    reason: req.body.reason || "Routine disposal"
  } : sample.disposal;
  sample.updatedAt = now();
  sample.chainOfCustody.unshift({ at: now(), by: req.user.name, action, locationId: sample.storageLocationId || "" });
  addAudit(db, req.user, `${action} sample`, "sample", sample.id, `${sample.sampleCode} lifecycle set to ${action}`);
  writeDb(db);
  res.json(sample);
});

app.get("/api/samples/bulk-labels", auth, async (req, res) => {
  const ids = String(req.query.ids || "").split(",").map(id => id.trim()).filter(Boolean);
  const samples = req.db.samples.filter(sample => ids.includes(sample.id) && canReadSample(req.user, sample));
  if (!samples.length) return res.status(404).send("No samples found");
  const labels = await Promise.all(samples.map(async sample => {
    const qr = await QRCode.toDataURL(sampleQrPayload(sample, req), { margin: 1, width: 260 });
    return `<div class="label">
      <img src="${qr}" alt="QR">
      <div>
        <div class="code">${sample.sampleCode}</div>
        <div class="small">${APP_NAME}</div>
        <div><b>Site:</b> ${sample.collectionSite || "-"}</div>
        <div><b>Client:</b> ${sample.clientName || "-"}</div>
        <div><b>Storage:</b> ${storageName(req.db, sample.storageLocationId)}</div>
        <div><b>Received:</b> ${new Date(sample.receivedAt).toLocaleString()}</div>
      </div>
    </div>`;
  }));
  if (req.query.download === "1") {
    res.setHeader("Content-Disposition", `attachment; filename="big-qr-labels-${new Date().toISOString().slice(0, 10)}.html"`);
  }
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Batch QR Labels</title>
  <style>body{font-family:Arial,sans-serif;margin:16px;color:#111}.toolbar{margin-bottom:14px}.labels{display:grid;grid-template-columns:repeat(2,90mm);gap:6mm}.label{break-inside:avoid;width:90mm;min-height:54mm;border:1px solid #111;padding:4mm;display:grid;grid-template-columns:30mm 1fr;gap:4mm;align-items:start}img{width:30mm;height:30mm}.code{font-size:17px;font-weight:800}.small{font-size:10px;margin:2px 0 5px}@media print{.toolbar{display:none}body{margin:0}.labels{gap:0}.label{border:1px solid #111}}</style>
  </head><body><div class="toolbar"><button onclick="window.print()">Print All QR Labels</button></div><div class="labels">${labels.join("")}</div></body></html>`);
});

app.get("/api/samples/bulk-tube-qr-labels", auth, async (req, res) => {
  const ids = String(req.query.ids || "").split(",").map(id => id.trim()).filter(Boolean);
  const samples = req.db.samples.filter(sample => ids.includes(sample.id) && canReadSample(req.user, sample));
  if (!samples.length) return res.status(404).send("No samples found");
  const labels = await Promise.all(samples.map(async sample => {
    const qr = await QRCode.toDataURL(sampleQrPayload(sample, req), { margin: 0, width: 92, errorCorrectionLevel: "M" });
    return `<div class="tube-label">
      <img src="${qr}" alt="Tube QR">
      <div class="tube-code">${sample.sampleCode}</div>
      <div class="tube-meta">${sample.collectionSite || ""}</div>
    </div>`;
  }));
  if (req.query.download === "1") {
    res.setHeader("Content-Disposition", `attachment; filename="small-tube-qr-labels-${new Date().toISOString().slice(0, 10)}.html"`);
  }
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Tube QR Labels</title>
  <style>body{font-family:Arial,sans-serif;margin:10px;color:#111}.toolbar{margin-bottom:12px}.sheet{display:grid;grid-template-columns:repeat(4,38mm);gap:2mm}.tube-label{break-inside:avoid;width:38mm;height:18mm;border:1px solid #111;padding:1mm;display:grid;grid-template-columns:13mm 1fr;gap:1.5mm;align-items:center;overflow:hidden}.tube-label img{width:13mm;height:13mm;object-fit:contain}.tube-code{font-size:8px;font-weight:800;letter-spacing:.2px}.tube-meta{font-size:6.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}@media print{.toolbar{display:none}body{margin:0}.sheet{gap:0}.tube-label{border:1px solid #111}}</style>
  </head><body><div class="toolbar"><button onclick="window.print()">Print Tube QR Labels</button></div><div class="sheet">${labels.join("")}</div></body></html>`);
});

app.get("/api/samples/:id/tube-label", auth, async (req, res) => {
  const sample = req.db.samples.find(item => item.id === req.params.id);
  if (!sample) return res.status(404).send("Sample not found");
  if (!canReadSample(req.user, sample)) return res.status(403).send("Not allowed");
  const qr = await QRCode.toDataURL(sampleQrPayload(sample, req), { margin: 0, width: 110, errorCorrectionLevel: "M" });
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>${sample.sampleCode} tube label</title>
  <style>body{font-family:Arial,sans-serif;margin:14px;color:#111}.toolbar{margin-bottom:12px}.tube-label{width:38mm;height:18mm;border:1px solid #111;padding:1mm;display:grid;grid-template-columns:13mm 1fr;gap:1.5mm;align-items:center;overflow:hidden}.tube-label img{width:13mm;height:13mm;object-fit:contain}.tube-code{font-size:8px;font-weight:800;letter-spacing:.2px}.tube-meta{font-size:6.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}@media print{.toolbar{display:none}body{margin:0}.tube-label{border:1px solid #111}}</style>
  </head><body><div class="toolbar"><button onclick="window.print()">Print Tube QR Label</button></div><div class="tube-label"><img src="${qr}" alt="Tube QR"><div><div class="tube-code">${sample.sampleCode}</div><div class="tube-meta">${sample.collectionSite || ""}</div></div></div></body></html>`);
});

app.get("/api/samples/:id/qr.svg", auth, async (req, res) => {
  const sample = req.db.samples.find(item => item.id === req.params.id);
  if (!sample) return res.status(404).send("Sample not found");
  if (!canReadSample(req.user, sample)) return res.status(403).send("Not allowed");
  const payload = sampleQrPayload(sample, req);
  const svg = await QRCode.toString(payload, { type: "svg", margin: 1, width: 240 });
  res.type("image/svg+xml").send(svg);
});

app.get("/api/samples/:id/qr.png", auth, async (req, res) => {
  const sample = req.db.samples.find(item => item.id === req.params.id);
  if (!sample) return res.status(404).send("Sample not found");
  if (!canReadSample(req.user, sample)) return res.status(403).send("Not allowed");
  const png = await QRCode.toBuffer(sampleQrPayload(sample, req), { type: "png", margin: 1, width: 640 });
  res.setHeader("Content-Disposition", `attachment; filename="${sample.sampleCode}-qr.png"`);
  res.type("image/png").send(png);
});

app.get("/api/samples/:id/label", auth, async (req, res) => {
  const sample = req.db.samples.find(item => item.id === req.params.id);
  if (!sample) return res.status(404).send("Sample not found");
  if (!canReadSample(req.user, sample)) return res.status(403).send("Not allowed");
  const qr = await QRCode.toDataURL(sampleQrPayload(sample, req), { margin: 1, width: 280 });
  res.send(`<!doctype html>
  <html><head><meta charset="utf-8"><title>${sample.sampleCode} label</title>
  <style>
    body{font-family:Arial,sans-serif;margin:18px;color:#111}
    .label{width:90mm;min-height:54mm;border:1px solid #111;padding:4mm;display:grid;grid-template-columns:32mm 1fr;gap:4mm;align-items:start}
    img{width:32mm;height:32mm}.code{font-size:18px;font-weight:800}.small{font-size:11px;margin-top:3px}.row{margin-top:5px}
    button{margin-bottom:14px;padding:8px 12px}@media print{button{display:none}body{margin:0}.label{border:1px solid #111}}
  </style></head><body>
  <button onclick="window.print()">Print</button>
  <div class="label">
    <img src="${qr}" alt="QR">
    <div>
      <div class="code">${sample.sampleCode}</div>
      <div class="small">${APP_NAME}</div>
      <div class="row"><b>Site:</b> ${sample.collectionSite || "-"}</div>
      <div class="row"><b>Client:</b> ${sample.clientName || "-"}</div>
      <div class="row"><b>Storage:</b> ${storageName(req.db, sample.storageLocationId)}</div>
      <div class="row"><b>Received:</b> ${new Date(sample.receivedAt).toLocaleString()}</div>
    </div>
  </div></body></html>`);
});

app.get("/api/samples/:id/report", auth, (req, res) => {
  const sample = req.db.samples.find(item => item.id === req.params.id);
  if (!sample) return res.status(404).send("Sample not found");
  if (!canReadSample(req.user, sample)) return res.status(403).send("Not allowed");
  const results = (sample.results || []).map(result => `<tr><td>${result.parameter}</td><td>${result.value} ${result.unit}</td><td>${result.limit}</td><td>${result.method}</td><td>${result.flag}</td><td>${result.analyst}</td></tr>`).join("");
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>${sample.sampleCode} report</title>
  <style>body{font-family:Arial,sans-serif;margin:28px;color:#111}h1{font-size:22px}table{border-collapse:collapse;width:100%;margin-top:14px}td,th{border:1px solid #999;padding:8px;text-align:left}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}button{margin-bottom:14px;padding:8px 12px}@media print{button{display:none}}</style>
  </head><body><button onclick="window.print()">Print Report</button><h1>${APP_NAME} - ${sample.sampleCode}</h1>
  <div class="grid"><div><b>Client:</b> ${sample.clientName}</div><div><b>Site:</b> ${sample.collectionSite}</div><div><b>Source:</b> ${sample.sourceType}</div><div><b>Status:</b> ${sample.status}</div><div><b>Analyst:</b> ${sample.assignedTo || "-"}</div><div><b>Storage:</b> ${storageName(req.db, sample.storageLocationId)}</div></div>
  <table><thead><tr><th>Parameter</th><th>Result</th><th>Limit</th><th>Method</th><th>Flag</th><th>Analyst</th></tr></thead><tbody>${results || "<tr><td colspan='6'>No results entered</td></tr>"}</tbody></table>
  <p><b>Reviewed by:</b> ${sample.reviewedBy || "-"} ${sample.reviewedAt ? new Date(sample.reviewedAt).toLocaleString() : ""}</p></body></html>`);
});

app.get("/api/samples/:id/report.pdf", auth, (req, res) => {
  const sample = req.db.samples.find(item => item.id === req.params.id);
  if (!sample) return res.status(404).send("Sample not found");
  if (!canReadSample(req.user, sample)) return res.status(403).send("Not allowed");
  const doc = new PDFDocument({ size: "A4", margin: 42 });
  res.setHeader("Content-Disposition", `attachment; filename="${sample.sampleCode}-final-report.pdf"`);
  res.type("application/pdf");
  doc.pipe(res);

  doc.fontSize(18).fillColor("#17212b").text(APP_NAME, { continued: false });
  doc.fontSize(11).fillColor("#627180").text(`Final Analysis Report: ${sample.sampleCode}`);
  doc.moveDown();
  doc.fontSize(10).fillColor("#17212b");
  const summary = [
    ["Client", sample.clientName],
    ["Site", sample.collectionSite],
    ["Source", sample.sourceType],
    ["Status", sample.status],
    ["Created", new Date(sample.createdAt || sample.receivedAt).toLocaleString()],
    ["Due", sample.dueAt ? new Date(sample.dueAt).toLocaleString() : "-"],
    ["Analyst", sample.assignedTo || "-"],
    ["Storage", storageName(req.db, sample.storageLocationId)],
    ["Retention", sample.retentionStatus || "Active"],
    ["Reviewed by", sample.reviewedBy || "-"]
  ];
  summary.forEach(([label, value]) => doc.text(`${label}: ${value || "-"}`));
  doc.moveDown();
  doc.fontSize(12).text("Results", { underline: true });
  doc.moveDown(0.4);
  doc.fontSize(9);
  doc.text("Parameter", 42, doc.y, { continued: true, width: 110 });
  doc.text("Result", 152, doc.y, { continued: true, width: 90 });
  doc.text("Limit", 242, doc.y, { continued: true, width: 90 });
  doc.text("Method", 332, doc.y, { continued: true, width: 100 });
  doc.text("Flag", 432, doc.y, { width: 70 });
  doc.moveTo(42, doc.y + 3).lineTo(552, doc.y + 3).strokeColor("#d8e0e6").stroke();
  doc.moveDown();
  (sample.results || []).forEach(result => {
    if (doc.y > 760) doc.addPage();
    const y = doc.y;
    doc.text(result.parameter || "-", 42, y, { width: 105 });
    doc.text(`${result.value || "-"} ${result.unit || ""}`, 152, y, { width: 85 });
    doc.text(result.limit || "-", 242, y, { width: 85 });
    doc.text(result.method || "-", 332, y, { width: 95 });
    doc.text(result.flag || "OK", 432, y, { width: 70 });
    doc.moveDown(1.1);
  });
  if (!(sample.results || []).length) doc.text("No results entered.");
  doc.moveDown();
  doc.fontSize(9).fillColor("#627180").text(`Generated ${new Date().toLocaleString()} by ${req.user.name}. Activity history and uploaded records remain in the LIMS.`);
  doc.end();
});

app.get("/api/search-sample/:code", auth, (req, res) => {
  const code = decodeURIComponent(req.params.code);
  const sample = req.db.samples.find(item => item.sampleCode === code || item.id === code);
  if (!sample) return res.status(404).json({ error: "Sample not found" });
  if (!canReadSample(req.user, sample)) return res.status(403).json({ error: "Not allowed for this sample" });
  res.json(sample);
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found" });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Server error" });
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      runScheduledExports();
      setInterval(runScheduledExports, 60 * 60 * 1000);
      console.log(`${APP_NAME} running on http://localhost:${PORT}${DATABASE_URL ? " with PostgreSQL" : ""}`);
    });
  })
  .catch(error => {
    console.error("Database startup failed:", error);
    process.exit(1);
  });
