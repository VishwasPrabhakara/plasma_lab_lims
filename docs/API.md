# API reference

Every endpoint the Worker exposes, with request shape, response shape, and
auth / role requirements. All responses are JSON unless noted
(QR / tube-label / archive export return `image/svg+xml`, `text/html`, or
`application/zip`).

- **Base URL:** `https://plasma-lab-lims-api.vishwas-borewellworkersdev.workers.dev`
- **Auth:** send `Authorization: Bearer <jwt>` on every route marked
  **(auth)**. Tokens come from `POST /api/login` or the first-user signup.
- **Errors:** `{ "error": "message" }` with the appropriate HTTP status.
  401 clears the client session; 403 means role or ownership mismatch; 409
  for duplicate email/phone; 400 for validation failures.

---

## Table of contents

- [Health & bootstrap](#health--bootstrap)
- [Auth](#auth)
- [Signup](#signup)
- [Password reset](#password-reset)
- [Users (admin)](#users-admin)
- [Master data (admin)](#master-data-admin)
- [Samples](#samples)
- [Results](#results)
- [Files](#files)
- [Archive](#archive)
- [Alerts](#alerts)
- [QR / label / report (HTML)](#qr--label--report-html)

---

## Health & bootstrap

### `GET /api/health`

Public, no auth. Returns a liveness payload including table counts.

```json
{
  "ok": true,
  "service": "Plasma Lab LIMS Worker API",
  "database": "Cloudflare D1",
  "samples": 142,
  "users": 7
}
```

### `GET /api/bootstrap` (auth)

Single aggregated payload the frontend calls on load. Admin-only fields
(`users`, `audit`, `health`) are empty for analyst callers.

```json
{
  "user":   { "id": "...", "name": "...", "role": "admin", ... },
  "users":  [{"id": "...", "name": "...", "role": "admin", ...}],
  "people": [{"id": "...", "name": "...", "role": "Analyst", "active": true}],
  "storageLocations": [...],
  "tests":   [...],
  "samples": [...],            // Full samples, hydrated with results/files/custody
  "audit":   [...],            // Last 200 entries (admin only)
  "alerts":  { "overdue": [], "dueSoon": [], "waitingUpload": [], "waitingApproval": [], "disposalReady": [] },
  "files":   [],               // Reserved
  "health":  { "database": "Cloudflare D1", ... }    // Admin only
}
```

Analysts see only non-archived, active samples.

---

## Auth

### `POST /api/login`

Public. Audits every attempt (success or failure) by email.

```json
{ "email": "you@example.com", "password": "••••••" }
```

**Response (200):**
```json
{
  "token": "<jwt>",
  "user":  { "id": "...", "name": "...", "role": "admin", ... }
}
```

**Errors:** 401 invalid credentials, 403 pending/rejected/deactivated.

### `POST /api/sign-out` (auth)

Bumps the user's `session_version` and audits. No request body.

```json
{ "ok": true }
```

---

## Signup

Four-step flow: email start → email verify → phone save → complete.

### `POST /api/signup/email/start`

```json
{ "name": "Priya", "email": "priya@iisc.ac.in" }
```

**Response:** `{ "pendingId": "...", "expiresAt": "ISO", "deliveryConfigured": true }`

### `POST /api/signup/email/verify`

```json
{ "pendingId": "...", "emailOtp": "123456" }
```

**Response:** `{ "pendingId": "...", "ok": true }`

### `POST /api/signup/phone/save`

```json
{ "pendingId": "...", "countryCode": "+91", "phone": "9876543210" }
```

**Response:** `{ "pendingId": "...", "ok": true }`

### `POST /api/signup/complete`

```json
{ "pendingId": "...", "password": "secret!", "confirmPassword": "secret!" }
```

**Response:**
- If first user ever: `{ "token": "<jwt>", "user": {...}, "approvalStatus": "approved" }`
- Otherwise: `{ "approvalStatus": "pending", "user": {...}, "message": "..." }`

### `POST /api/signup/resend`

```json
{ "pendingId": "..." }
```

**Response:** same shape as `/api/signup/email/start`.

### `GET /api/validate/signup?email=…&countryCode=…&phone=…`

Live availability check for the signup form.

```json
{
  "email": { "valid": true, "available": true, "message": "..." },
  "phone": { "valid": true, "available": true, "normalized": "...", "message": "..." }
}
```

---

## Password reset

**Enumeration defense:** `/start` returns the same shape whether the email
exists or not. OTP is only emailed to real users.

### `POST /api/password-reset/start`

```json
{ "identifier": "you@example.com" }
```

**Response:** `{ "resetId": "...", "expiresAt": "ISO", "deliveryConfigured": true|false }`

### `POST /api/password-reset/confirm`

```json
{ "resetId": "...", "emailOtp": "123456", "password": "newpass" }
```

**Response:** `{ "ok": true }`

---

## Users (admin)

All require `role = admin`.

| Method   | Path                             | Purpose                       |
| -------- | -------------------------------- | ----------------------------- |
| `POST`   | `/api/users`                     | Create a new user directly    |
| `POST`   | `/api/users/:id/approve`         | Approve a pending signup      |
| `POST`   | `/api/users/:id/reject`          | Reject a pending signup       |
| `PATCH`  | `/api/users/:id`                 | Update `role` or `active`     |
| `DELETE` | `/api/users/:id`                 | Soft-delete (sets `active=0`) |

### `POST /api/users`

```json
{
  "name": "Priya", "email": "priya@iisc.ac.in",
  "phone": "9876543210", "countryCode": "+91",
  "password": "temporary", "role": "analyst"
}
```

### `POST /api/users/:id/approve`

```json
{ "role": "analyst" }    // optional; defaults to the user's current role
```

### `POST /api/users/:id/reject`

```json
{ "reason": "optional, ≤500 chars" }
```

### `PATCH /api/users/:id`

```json
{ "role": "admin", "active": true }    // any subset
```

### Response (every user route)

```json
{
  "id": "...", "name": "...", "email": "...",
  "phone": "...", "countryCode": "...",
  "role": "analyst", "active": true,
  "approvalStatus": "approved",
  "signedUpAt": "...", "approvedAt": "...", "approvedBy": "...",
  "rejectedAt": null, "rejectedBy": null, "rejectionReason": null,
  "createdAt": "..."
}
```

---

## Master data (admin)

Three resource types sharing one adapter: `people`, `storage-locations`, `tests`.
All require admin.

| Method  | Path                                 | Purpose    |
| ------- | ------------------------------------ | ---------- |
| `POST`  | `/api/people`                        | Create     |
| `POST`  | `/api/storage-locations`             | Create     |
| `POST`  | `/api/tests`                         | Create     |
| `PATCH` | `/api/{resource}/:id`                | Update     |

### Create bodies

```json
// POST /api/people
{ "name": "Anshika M", "role": "Analyst" }

// POST /api/storage-locations
{ "name": "Freezer A", "type": "Freezer", "isFull": false, "capacityNote": "" }

// POST /api/tests
{ "name": "BOD", "unit": "mg/L", "limit": "3", "method": "APHA 5210 B" }
```

### PATCH body

Keys in `{name, role, active, type, isFull, capacityNote, unit, limit, method}`
map to their snake_case columns. Any key outside the whitelist is ignored.

---

## Samples

### `POST /api/samples` (admin)

```json
{
  "clientName": "V Valley", "collectionSite": "Hoskote lake",
  "sourceType": "Water", "collector": "Anshika M",
  "assignedTo": "Amrutha Shanbhag, Anshika M",
  "requestedTests": ["pH", "BOD", "COD"],
  "storageLocationId": "...", "notes": "", "status": "Bottle Ready",
  "plannedSamplingDate": "2026-10-20",
  "dueAt": "2026-10-22T18:00:00Z"
}
```

**Response:** the full sample, hydrated with `results[]`, `files[]`, `chainOfCustody[]`.

Validation:
- `clientName`, `collectionSite`, `sourceType`, `collector` required
- `requestedTests` must be a non-empty array
- `assignedTo` normalized and capped at 2 names
- `storageLocationId` must not point to a full/inactive location

### `POST /api/samples/bulk` (admin)

Create up to 250 samples in one call.

```json
{ "rows": [ {...sample fields...}, ... ] }
```

**Response:**
```json
{ "created": [...], "errors": [ { "row": 3, "error": "..." }, ... ] }
```

If no rows succeed, status 400 with `errors` on the error object.

### `POST /api/samples/:id/collect`

Mark a bottle as collected in the field. Caller must be an admin or the
named `collector`.

```json
{
  "collectionSite": "Hoskote lake, outlet 3",
  "collectedAt": "2026-10-18T07:34:00Z",
  "collectionLat": "13.07", "collectionLng": "77.80"
}
```

Only allowed when `status ∈ {Bottle Ready, Sample Collected}`.

### `POST /api/samples/:id/storage`

Move the sample to a new storage location. Any authenticated analyst can
call. First move after `Sample Collected` transitions to `Stored`.

```json
{ "storageLocationId": "...", "reason": "optional note" }
```

### `PATCH /api/samples/:id`

Mutate status, assignedTo, storageLocationId, notes, or dueAt. Caller
must satisfy `canWorkOnSample` (admin, or analyst listed in `assignedTo`).

```json
{ "status": "In Analysis", "assignedTo": "Anshika M", "notes": "..." }
```

### `POST /api/samples/:id/approve` (admin)

Signed approval — requires the admin's own password in `signaturePassword`.
Writes sample update + chain-of-custody + audit as one D1 batch.

```json
{ "signaturePassword": "••••••", "reason": "optional note" }
```

Pre-conditions:
- At least one `sample_results` row exists.
- Caller is admin.

**Response:** the full sample with new `status = "Approved"`.

### `POST /api/samples/:id/lifecycle` (admin)

```json
{ "action": "Retained" }
// or
{ "action": "Disposed", "reason": "stored >6mo, no further analysis" }
// or
{ "action": "Active" }
```

`"Disposed"` also sets `status = "Disposed"`.

### `GET /api/search-sample/:code`

Find a sample by `sample_code` or `id`. Used by the Scan view.

---

## Results

### `POST /api/samples/:id/results`

Single row (default), or bulk/sheet via `/results/bulk` or `/results/sheet`.

**Single:**
```json
{
  "parameter": "pH", "value": "7.4",
  "unit": "", "limit": "", "method": "", "flag": "OK"
}
```

**Bulk (plain text CSV/TSV):** `POST /api/samples/:id/results/bulk`
```json
{ "rows": "pH,7.4,,,,,OK\nBOD,2.9,mg/L,3,APHA,OK" }
```

**Sheet (structured):** `POST /api/samples/:id/results/sheet`
```json
{ "rows": [
  { "parameter": "pH", "value": "7.4", "flag": "OK",
    "replicates": [7.4, 7.5, 7.3], "avg": 7.4, "stddev": 0.08 }
] }
```

The Worker writes all rows + updates `samples.status` (`Flagged` if any
row has `flag = Alert`, else `Results Entered`) + a chain-of-custody row
+ an audit row — all in one D1 batch.

**Response:** the full sample, hydrated.

---

## Files

### `POST /api/samples/:id/files`

Multipart form upload. Each file < 300 KB rides base64 inline in D1.
Larger files go to R2 if `env.MEDIA` is bound. Caller must be admin, the
sample's collector, or an assigned analyst.

Form fields:
- Any number of file parts (each becomes one `sample_files` row).
- `category` (default `"Uploaded File"`).
- `lat`, `lng`, `takenAt` (optional metadata).

**Response:** the full sample.

### `GET /api/media/:key` (auth)

Serves an R2-backed file. ACL-gated: the Worker finds the parent sample
and refuses unless `canReadSample(user, sample)` passes.

Returns the file bytes with its original `content-type` and a `Cache-Control: private, max-age=3600`.

### `DELETE /api/samples/:id/files/:fileId` (admin)

Deletes the file from R2 (if applicable) and from D1. Audited.

---

## Archive

Both routes are admin-only.

### `GET /api/archive/preview?from=YYYY-MM-DD&to=YYYY-MM-DD`

Count-only preview.

```json
{ "count": 42, "photoCount": 118 }
```

### `GET /api/archive/export?from=…&to=…&soft=1`

Returns a `application/zip` download with a `manifest.json` and
`photos/<sampleId>/<fileId>-<name>` entries. `soft=1` also sets
`archived_at` + `retention_status = "Archived"` on each sample (never
deletes). Writes an `archive_batches` row and an audit entry.

Response: binary ZIP, filename `plasma-lab-archive-<from>_to_<to>.zip`.

---

## Alerts

### `GET /api/alerts` (auth)

Freshly computed slices for the dashboard:

```json
{
  "overdue":        [...samples past dueAt and not Approved/Disposed...],
  "dueSoon":        [...samples due in < 24h and not Approved/Disposed...],
  "waitingUpload":  [...samples with no "Written Record"/"Book" file...],
  "waitingApproval":[...samples in Needs Review or Results Entered...],
  "disposalReady":  [...Approved + retentionStatus = Active...]
}
```

---

## QR / label / report (HTML)

All require auth and `canReadSample(user, sample)`.

### `GET /api/samples/:id/qr.svg`

Returns `image/svg+xml` — a QR code that points at
`${FRONTEND_PUBLIC_URL}/?sample=<sample_code>`.

### `GET /api/samples/:id/tube-label`

Returns an `text/html` print-ready 38mm × 18mm tube label.

### `GET /api/samples/:id/report` (or `/report.pdf`)

Returns `text/html` — the printable results report for the sample.

---

## Shapes

For reference, these are the response shapes the frontend relies on.

### Sample

```json
{
  "id": "uuid", "sampleCode": "PL-2026-000042",
  "status": "Approved", "workflowStage": "Approved",
  "clientName": "V Valley", "sourceType": "Water",
  "collectionSite": "Hoskote lake", "collector": "Anshika M",
  "receivedBy": "Priya", "receivedAt": "ISO",
  "storageLocationId": "...", "assignedTo": "Anshika M, Amrutha Shanbhag",
  "requestedTests": ["pH", "BOD"],
  "notes": "", "plannedSamplingDate": "2026-10-20",
  "collectedAt": "ISO", "collectionLat": "13.07", "collectionLng": "77.80",
  "dueAt": "ISO",
  "retentionStatus": "Active", "disposal": null,
  "reviewedBy": "Vishwas", "reviewedAt": "ISO", "archivedAt": null,
  "active": true, "createdAt": "ISO", "updatedAt": "ISO",
  "results": [ /* Result */ ],
  "files":   [ /* File   */ ],
  "chainOfCustody": [ /* Custody entry */ ]
}
```

### Result

```json
{
  "id": "uuid", "parameter": "BOD", "value": "2.9",
  "unit": "mg/L", "limit": "3", "method": "APHA 5210 B",
  "flag": "OK", "analyst": "Anshika M",
  "replicates": [2.8, 2.9, 3.0], "avg": 2.9, "stddev": 0.08,
  "msg": "OK", "enteredAt": "ISO"
}
```

### File

```json
{
  "id": "uuid", "originalName": "bottle.jpg", "category": "Sample Photo",
  "url": "/api/media/<key>",    // or "data:...base64" for inline
  "size": 212390, "mimeType": "image/jpeg",
  "lat": "13.07", "lng": "77.80", "takenAt": "ISO",
  "uploadedBy": "Anshika M", "uploadedAt": "ISO"
}
```

### Custody entry

```json
{
  "at": "ISO", "by": "Anshika M", "action": "Approved (signed)",
  "fromLocationId": null, "toLocationId": null, "locationId": "...",
  "note": ""
}
```
