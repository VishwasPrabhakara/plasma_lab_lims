# Plasma Lab LIMS

Laboratory information management system for the **Centre for Sustainable
Technologies, IISc Bengaluru**. Tracks water and soil samples from bottle
label through storage, analysis, approval, and retention — with chain of
custody and an append-only audit log on every state transition.

Built as a single-page static frontend hosted on GitHub Pages, backed by a
Cloudflare Worker API with D1 (SQLite at the edge) and R2 (sample photos).

- **Live app:** https://vishwasprabhakara.github.io/plasma_lab_lims/
- **API:** https://plasma-lab-lims-api.vishwas-borewellworkersdev.workers.dev
- **Architecture:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **API reference:** [`docs/API.md`](docs/API.md)
- **Product truth:** [`PRODUCT.md`](PRODUCT.md)

---

## Why this exists

The lab was running on an Excel workbook and a shared folder of
WhatsApp-forwarded photos. Mislabelled bottles, lost photos, no audit
trail, and no way to tell at a glance which samples were waiting on a
result or an approval. This replaces that with a sample lifecycle every
step of which is logged, timestamped, and attributable to a specific
analyst — the standard world-class lab informatics stacks (STARLIMS,
LabWare, Agilent) use. Smaller, but the same principles.

---

## Repository layout

```
Plasma_lab_lims/
├── public/                     # Static frontend (served by GitHub Pages)
│   ├── index.html              # Shell + every dialog markup inline
│   ├── config.js               # Environment config (API_BASE)
│   ├── styles.css              # All styles — no framework
│   ├── app.js                  # Entry module — views, dialogs, boot
│   └── src/                    # Importable modules
│       ├── config.js           # Runtime constants (STATUS_OPTIONS, etc.)
│       ├── state.js            # The one state singleton
│       ├── perms.js            # can/canWorkOn/canApprove — role gates
│       ├── api/
│       │   └── client.js       # fetch wrapper + 401 handling
│       ├── components/
│       │   └── notify.js       # Toast stack + confirm dialog
│       ├── data/
│       │   ├── nav.js          # NAV_ITEMS, ICONS, TITLES
│       │   └── panels.js       # Lab's parameter panels per project
│       └── utils/
│           ├── dom.js          # $, $$, h, esc, fmtDate
│           ├── stats.js        # replicate avg/stddev
│           └── image.js        # client-side JPEG recompression
│
├── worker/                     # Cloudflare Worker API
│   ├── wrangler.jsonc          # Worker config (D1, R2, cron, vars)
│   ├── package.json            # Only runtime dep: `qrcode`
│   ├── migrations/             # D1 schema + one-shot data migrations
│   │   └── 0001_initial_schema.sql
│   └── src/
│       ├── index.js            # fetch + scheduled entry
│       ├── router.js           # Dispatch to route modules
│       ├── middleware/
│       │   └── auth.js         # JWT verification
│       ├── lib/                # Pure helpers
│       │   ├── http.js         # json/html response, CORS, httpError
│       │   ├── crypto.js       # JWT sign/verify + PBKDF2
│       │   ├── validators.js   # email/phone format
│       │   ├── email.js        # Resend / Gmail Apps Script
│       │   ├── db.js           # row→shape adapters, loadSample(s)Full
│       │   ├── perms.js        # requireRole, canReadSample
│       │   └── zip.js          # store-only ZIP writer for archive
│       └── routes/             # Route modules — one subsystem each
│           ├── auth.js         # login/signup/reset
│           ├── bootstrap.js    # /api/bootstrap, /api/alerts
│           ├── users.js        # user admin
│           ├── master.js       # people/storage-locations/tests
│           ├── samples.js      # create/collect/storage/PATCH/approve
│           ├── results.js      # result entry
│           ├── files.js        # upload + R2 serve + delete
│           └── archive.js      # preview + export ZIP bundle
│
├── docs/
│   ├── ARCHITECTURE.md         # Data model, request flow, boundaries
│   ├── API.md                  # Every endpoint, with examples
│   └── surfaces/
│       └── app-shell.md        # Visual direction contract
├── PRODUCT.md                  # What this is, who it's for, what it's not
└── README.md                   # You are here
```

---

## Running it

### Frontend

The frontend is a static page. There is no build step — the browser loads
`index.html` and ES modules handle the rest.

**Serve locally:**
```bash
cd public
python3 -m http.server 8080
# then open http://localhost:8080
```

The frontend reads `window.PLASMA_LIMS_CONFIG.API_BASE` from
`public/config.js`. Point it at a local Worker (via `wrangler dev`) or the
deployed Worker URL. Example override for local dev:

```js
// public/config.js
window.PLASMA_LIMS_CONFIG = { API_BASE: "http://localhost:8787" };
```

### Worker

```bash
cd worker
npm install
npx wrangler dev            # local dev, uses the configured D1 + R2
npx wrangler deploy         # deploy to Cloudflare
```

### Secrets

The Worker refuses to start without a 32+ character `JWT_SECRET`.

```bash
cd worker
npx wrangler secret put JWT_SECRET
# optional (if you want outbound OTP email):
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put SMTP_FROM
# or the Gmail Apps Script relay URL instead:
npx wrangler secret put GMAIL_APPS_SCRIPT_URL
```

Non-secret vars live in `wrangler.jsonc` (ALLOWED_ORIGINS,
FRONTEND_PUBLIC_URL, SMTP_FROM_NAME).

### Database (D1)

Create and migrate the database once per environment:

```bash
npx wrangler d1 create plasma-lab-lims
# paste the returned database_id into wrangler.jsonc d1_databases[0].database_id
npx wrangler d1 execute plasma-lab-lims --remote --file=./migrations/0001_initial_schema.sql
```

### Media (R2)

```bash
npx wrangler r2 bucket create plasma-lab-lims-media
```

---

## First user

The first signed-up user is auto-approved as `admin` — no email delivery is
needed to bootstrap. Every subsequent signup lands in a pending queue and
needs admin approval before login.

Password requirements: minimum 6 characters. Passwords are hashed with
PBKDF2-SHA256, 100,000 iterations.

---

## Deploying

The frontend is served by GitHub Pages from the `public/` folder. Any push
to `main` publishes within a minute. Cache-bust is handled by `?v=<tag>`
query strings on `styles.css` and `app.js` — bump the tag when you want to
force clients to re-fetch.

The Worker is deployed with `wrangler deploy` from the `worker/` directory.

The Worker runs a monthly cron (`0 3 1 * *`) that counts samples older than
365 days with no `archived_at` and writes an `archive_reminder` row to the
`meta` table. **Nothing is auto-deleted.** Admins export + optionally soft-
archive from the Data Backup view.

---

## Testing credentials

For a demo environment, the first signup acts as admin. For an existing
deployment, ask the lab admin for a login or the one-off reset flow via
`/api/password-reset/start`.

---

## Security posture

- Passwords: PBKDF2-SHA256, 100k iterations, per-user salt.
- Sessions: HS256 JWT, 12-hour lifetime, kept in sessionStorage (clears on
  browser close). `/api/sign-out` bumps the user's `session_version` so a
  future enforcement toggle is a one-line change.
- Approval ceremony: approving a sample requires re-entering the admin's
  password. Approval, chain of custody, and audit log are written in one
  atomic D1 batch.
- Password-reset start returns the same shape whether the email exists or
  not (enumeration defense). An audit row is written for unknown emails.
- R2 media endpoints are ACL-gated: the Worker finds the file's parent
  sample and checks `canReadSample(user, sample)` before serving.
- No sample data is ever deleted. Lifecycle `Disposed` only sets state.
  Archive export can soft-archive (`archived_at`); hard delete is not an API.

Known deferred items (post-demo):
- Rate limiting on `/api/login` and OTP endpoints.
- PBKDF2 iterations → 600k.
- File upload size cap and MIME whitelist.
- Pagination beyond the 2000-sample bootstrap cap.
- Refresh token flow / shorter access token.

---

## License

Internal lab tool. Not currently open-sourced.
