# Architecture

How Plasma Lab LIMS is wired together: what sits where, what talks to what,
and the invariants that keep lab data trustworthy.

> **One-liner:** a static ES-module frontend on GitHub Pages, a Cloudflare
> Worker API with D1 (SQLite) and R2 (photos), and a single JWT between
> them. Every state transition writes to both chain-of-custody and audit
> log in the same D1 batch — never one without the other.

---

## 1. Topology

```
         Browser                  Cloudflare edge                 Durable
┌────────────────────┐      ┌─────────────────────┐       ┌──────────────────┐
│                    │      │                     │       │                  │
│  public/index.html │──1──▶│  Worker (ESM):      │──3──▶ │  D1 database     │
│  public/app.js     │      │   fetch + scheduled │       │  (SQLite tables) │
│  (ES modules)      │◀─2───│                     │◀──4───│                  │
│                    │      │   router.js         │       └──────────────────┘
│  state singleton   │      │   routes/*.js       │       ┌──────────────────┐
│  api client        │      │   lib/*.js          │──5──▶ │  R2 bucket       │
└────────────────────┘      └─────────────────────┘       │  (photos, zips)  │
          │                                               └──────────────────┘
          │ GitHub Pages                                  ┌──────────────────┐
          └── public/* served as-is                       │  Email provider  │
                                                         ◀────────────── 6 ──│  Resend / Gmail │
                                                         │  (OTP delivery)  │
                                                         └──────────────────┘
```

1. Browser calls `${API_BASE}/api/...` (set in `public/config.js`).
2. Worker returns JSON (or HTML for QR / report / tube label endpoints).
3. Worker reads/writes D1 (`env.DB`) — Cloudflare's edge SQLite.
4. Worker streams D1 rows back as `rowToSample(...)` shapes the frontend expects.
5. Large sample photos stored in R2 (`env.MEDIA`); small ones ride base64 inline.
6. Signup/reset OTPs sent via Resend or a Gmail Apps Script relay.

---

## 2. Data model

Primary tables (full DDL in `worker/migrations/0001_initial_schema.sql`):

| Table                | What it holds                                                    |
| -------------------- | ---------------------------------------------------------------- |
| `users`              | Lab staff. `role` ∈ {`admin`, `analyst`}. `approval_status` gates login. |
| `pending_signups`    | Email OTP state during signup; one row until completion.         |
| `password_resets`    | Email OTP state during a reset; one row per in-flight reset.    |
| `samples`            | The sample itself: code, project, site, status, due, retention. |
| `sample_results`     | Analytical results. One row per parameter per run.               |
| `sample_files`       | Photos / written records. `data_url` inline OR `r2_key` in R2.  |
| `chain_of_custody`   | Append-only movements: labelled, collected, stored, assigned, approved, disposed. |
| `people`             | Admin-curated analyst roster (independent of `users`).           |
| `storage_locations`  | Freezers / racks. `is_full` + `active` flags.                   |
| `tests`              | Standard test methods and limits.                                |
| `audit_log`          | Append-only record of every write — login, approval, modify.    |
| `archive_batches`    | Export runs; records what range was exported and whether soft-archived. |
| `meta`               | Key/value for cron-written notes (`archive_reminder`).           |

### Sample lifecycle (status / workflow_stage)

```
Bottle Ready → Sample Collected → Stored → Assigned → In Analysis
                                                            │
                                             ┌──────────────┴─────────┐
                                             ▼                        ▼
                                     Results Entered              Flagged
                                             │
                                             ▼
                                       Needs Review
                                             │
                                             ▼
                                        Approved → Disposed
```

- `Flagged` is reached when any result row has `flag = Alert`. Admin can
  still move it to `Needs Review` → `Approved` by changing the flag.
- `Disposed` is lifecycle-only; the sample row stays in the DB.

### Permissions

| Action                      | admin | analyst (assigned) | analyst (not assigned) |
| --------------------------- | :---: | :----------------: | :-------------------:  |
| Read sample                 |  yes  |  yes (active+not archived)  |  yes (same filter)      |
| Create sample / bulk create |  yes  |         no         |          no            |
| Mark collected              |  yes  |  yes (if `collector == me`)      |          no            |
| Storage move                |  yes  |  yes               |          yes           |
| PATCH sample / enter results|  yes  |  yes               |          no            |
| Approve                     |  yes  |         no         |          no            |
| Archive export              |  yes  |         no         |          no            |
| User / master data admin    |  yes  |         no         |          no            |

Assignment supports **two analysts, comma-separated** (`"A, B"`) — the
lab's two-person replicate flow (two replicates by A, one by B). The
Worker rejects assignment of three or more.

---

## 3. Request flow

Everything the frontend does goes through `public/src/api/client.js`:

```js
api("/api/bootstrap")                      // GET
api("/api/samples", { method: "POST", body: JSON.stringify(sample) })
```

The client attaches the bearer token from `state.token`, parses the JSON
response, and surfaces server errors with the server's message. On 401 to
any route except `/api/login` it clears the session and the registered
`onSessionExpired` callback re-renders the auth view.

### Worker router (`worker/src/router.js`)

```
request → fetch handler → router.handle(request, env, ctx)
                               │
                               ▼
                     publicRoutes.try(…)   ← health, login, signup, reset,
                               │              validate/signup
                        matched? return response
                               │
                               ▼
                           auth()            ← verify JWT, load user
                               │
                               ▼
                   privateRoutes.try(…)      ← bootstrap, users, master,
                               │              samples, results, files,
                               │              archive, sign-out
                        matched? return response
                               │
                               ▼
                        throw 404
```

Each route group is a function `tryXxx(request, env, ctx, { url, path, method, user? })`
that returns `Response | null`. The router iterates them in order; the
first non-null wins.

### Permission checks

Every private route starts by calling one or more of:

- `requireRole(user, "admin")` — hard refusal for non-admin.
- `canReadSample(user, sample)` — admin reads all; analyst reads
  active+non-archived.
- `canWorkOnSample(user, sample)` — admin writes all; analyst writes only
  if their name is in `assignedTo`.

### Atomicity

Any state transition that spans multiple tables runs in a single
`env.DB.batch([…])` so chain-of-custody, audit, and the sample row either
all land or none do. In particular:

- `POST /api/samples/:id/approve` runs the UPDATE, custody row, and audit
  row as one batch — after re-verifying the signature password.
- `POST /api/samples/:id/results` runs the N result inserts, the sample
  status UPDATE, a custody row, and an audit row as one batch.

---

## 4. Frontend architecture

```
public/
├── index.html         The shell + every <dialog> markup inline. No framework.
├── config.js          window.PLASMA_LIMS_CONFIG = { API_BASE: "…" }
├── styles.css         One stylesheet.
├── app.js             ES module entry. Imports from src/*, renders views.
└── src/
    ├── config.js      API_BASE + status / lifecycle constants
    ├── state.js       Mutable state singleton
    ├── perms.js       Client-side role gates
    ├── api/client.js  fetch wrapper
    ├── components/notify.js   Toast + confirm dialog
    ├── data/
    │   ├── nav.js     Role-adaptive nav + icons + section titles
    │   └── panels.js  Per-project parameter panels (lab's workbook)
    └── utils/
        ├── dom.js     $, $$, h, esc, fmtDate
        ├── stats.js   Replicate avg/stddev
        └── image.js   Client-side JPEG recompression
```

### State

A single `state` singleton (`src/state.js`) holds server data, UI state,
and pending dialog resolvers. Mutations are plain assignments; a central
`render()` function in `app.js` redraws the current view by reading from
`state`. For a lab-sized app with one data owner (the Worker) this beats
a reactive store.

### Rendering

The `h(tag, attrs, ...children)` helper is a hyperscript element builder.
Children that are strings become `createTextNode()` (never
`innerHTML`); `html:` attribute opts into trusted markup (e.g. inline SVG
icons). This is the frontend's XSS boundary.

### Views

Views are plain functions (`renderDashboard`, `renderSamples`,
`renderSampleDetail`, etc.) that build a subtree and append it to the
view root. The top-level `switchView(view)` sets `state.view` and calls
`render()`.

### Session

Login writes the JWT to `sessionStorage` under
`STORAGE_KEYS.token` — closing the browser signs out. `clearSessionState()`
wipes every slice of `state` and both storage backends. "Remember me" on
the login form stores only the email in `localStorage` so the browser's
own password manager can fill the password.

---

## 5. Boundaries and invariants

These are the properties we rely on. Any PR that breaks one needs
discussion.

1. **No API path writes to a sample without also writing chain of custody**
   (except backfill scripts). Enforce by inspection in route PRs.
2. **No API path mutates `samples.status` without also writing audit.**
3. **Approval requires `signaturePassword` re-verification.** The approval
   batch is: `UPDATE samples … + chain_of_custody INSERT + audit INSERT`.
   The PATCH endpoint whitelists statuses to the intermediate lifecycle
   so the ceremony cannot be routed around — `"Approved"` only through
   `/approve`, `"Disposed"` only through `/lifecycle`.
4. **Sample data is never deleted.** `Disposed` is a status, not a delete.
   Archive export can soft-archive (`archived_at`, `retention_status`);
   hard delete is not exposed. The one exception is audit-log rotation
   (see §6): rows older than `AUDIT_RETENTION_DAYS` are copied to R2
   with a SHA-256 receipt before `AUDIT_PRUNE_D1` lets the D1 copies
   be dropped — and only in the same atomic batch as the archive-row
   insert.
5. **Media endpoints are ACL-gated** by sample ownership.
6. **The Worker refuses to boot without `JWT_SECRET` ≥ 32 chars.**
7. **CORS allowlist** is pinned by `env.ALLOWED_ORIGINS`.
8. **Frontend never renders user text with `innerHTML`.** Only trusted
   static markup (SVG icons) uses the `html:` attribute of `h()`.
9. **Reassignment is admin-only.** PATCH `/api/samples/:id` with an
   `assignedTo` field is refused for analyst callers; sample creation
   and `assignedTo` edits land only through admin.
10. **File uploads are size- and type-capped.** 20 MB per file, 60 MB
    per request, MIME in `{image/jpeg, image/png, image/webp,
    application/pdf}`. Enforced in `routes/files.js`.

---

## 5a. Audit log retention

Every write to the LIMS lands in `audit_log` (role: cross-cutting, one row
per state transition). Rows stay in D1 for `AUDIT_RETENTION_DAYS` (default
90) and then flow out through a monthly rotator:

- The scheduled handler (`0 3 1 * *`) calls `rotateAuditLog(env)` after the
  archive-reminder step.
- For each calendar month older than the retention window and not already
  archived, the rotator reads every row for that month in deterministic
  order, serializes to NDJSON, SHA-256-hashes the bytes, and uploads to R2
  at `audit/YYYY-MM.ndjson`.
- Only after R2 confirms the write, `audit_archive_batches` gets a row
  with the file key, SHA-256, row count, byte size, timestamps.
- With `env.AUDIT_PRUNE_D1 = "true"`, the archived rows are DELETE'd from
  `audit_log` in the same `env.DB.batch([...])` as the archive-row insert.
  With `AUDIT_PRUNE_D1` off (default), audit_log is left alone and R2 is
  a pure backup.

Admin reads an archive back through `GET /api/audit/archive` (list) and
`GET /api/audit/archive/:yearMonth` (stream the NDJSON with the sha256
in the response header for client-side verification). The rotator can be
run on demand with `POST /api/audit/archive/run`.

**What is NOT rotated:** `chain_of_custody` stays in D1 for the life of
the sample. It's small, queried per-sample, and the sample view relies
on it being warm.

## 6. Deployment

| Component | Where | How |
| --------- | ----- | --- |
| Frontend  | GitHub Pages | `git push origin main` → Pages auto-publishes `public/` |
| Worker    | Cloudflare   | `cd worker && npx wrangler deploy` |
| D1        | Cloudflare   | `wrangler d1 execute … --file=migrations/0001_initial_schema.sql` |
| R2        | Cloudflare   | `wrangler r2 bucket create plasma-lab-lims-media` |
| Secrets   | Cloudflare   | `wrangler secret put JWT_SECRET` (and optionally RESEND_API_KEY, SMTP_FROM) |

Cache-bust: `index.html` loads `styles.css?v=<tag>` and
`app.js?v=<tag>`. Bump the tag on changes to either so clients re-fetch
rather than hitting the GitHub Pages CDN cache.

---

## 7. What's intentionally missing

Documented in [`PRODUCT.md`](../PRODUCT.md) and the README's "Known
deferred items":

- No build step. ES modules load directly in the browser. If the file
  count grows, revisit — but today three network round-trips covers the
  whole app.
- No TypeScript. Not worth the ergonomic hit at this size.
- No automated tests. The next refactor cycle adds `vitest` on `worker/src/lib/*`
  (pure functions) and a Playwright smoke on the login + create-sample flow.
- No rate limiting. Added via Cloudflare's rate-limiting rules post-demo.
