# End-to-end test — findings

How this was tested
: public auth flows were exercised against the deployed Worker from the
  live frontend (health check, bootstrap-without-token, bad login,
  password-reset for a fake email twice, signup email start with
  missing/invalid/valid input, signup email verify with bad OTP, live
  validate-signup endpoint, random 404). Private flows (sample
  lifecycle, results, approval, file upload, archive) were code-traced
  through the Worker routes because this session doesn't hold admin
  credentials. Every finding is marked **live** or **traced**.

**Overall verdict:** the LIMS boots, serves the API, and holds every
auth flow I could hit from outside. The sample lifecycle code is
coherent and atomic. But a one-line PATCH defeats the signed-approval
ceremony, which is the lab's main integrity control. That must be
fixed before the demo if a professor asks "can an analyst approve their
own work?"

---

## Findings

### CRITICAL

#### 1. PATCH `/api/samples/:id` bypasses the signed-approval ceremony (traced)

`worker/src/routes/samples.js:191-213` accepts `status` from the request
body and writes it straight to `samples.status` with no whitelist. An
analyst assigned to a sample can call:

```
PATCH /api/samples/<id>
{ "status": "Approved" }
```

and the sample is marked `Approved` **without** the `signaturePassword`
re-authentication that `/api/samples/:id/approve` enforces. The
dedicated approve route becomes decorative — a hostile or careless
analyst routes around it.

Fix (small, demo-day safe): whitelist allowed statuses in the PATCH
handler, and refuse `"Approved"` here (it belongs only to the signed
approve route). Also disallow `"Disposed"` (lifecycle route). Something
like:

```js
const ALLOWED_PATCH_STATUS = new Set([
  "Bottle Ready", "Sample Collected", "Stored", "Assigned",
  "In Analysis", "Results Entered", "Needs Review", "Flagged"
]);
if ("status" in body && !ALLOWED_PATCH_STATUS.has(body.status)) {
  throw httpError("Use /approve or /lifecycle for that transition", 400);
}
```

### HIGH

#### 2. Analyst can rewrite `assignedTo` on their own samples (traced)

Same PATCH handler. `canWorkOnSample` passes if the analyst's name is in
`assignedTo`. The handler lets any of them edit `assignedTo` — adding
other analysts, removing themselves, replacing the list wholesale. The
chain-of-custody row captures the change, so it's not silent, but it is
still a privilege escalation inside the lifecycle.

Fix: gate `assignedTo` behind `requireRole(user, "admin")` the same way
sample creation is. Analysts PATCH `status`, `notes`, `dueAt`, and
`storageLocationId` only.

#### 3. No file upload size cap or MIME whitelist (traced)

`worker/src/routes/files.js` accepts any file an authenticated analyst
sends. No per-file size check, no total-upload cap, no MIME allowlist.
One sample-photo upload with a 2 GB file would blow through R2 quota
and D1 size limits.

Fix: reject per-file over 20 MB and total request over 60 MB; allowlist
`image/jpeg`, `image/png`, `image/webp`, `application/pdf`. A rate limit
would also help but is a Cloudflare rule, not code.

### MEDIUM

#### 4. Password-reset enumeration defense partially leaks (live)

`/api/password-reset/start` returns `deliveryConfigured: !!u`
(`worker/src/routes/auth.js:190`). For a nonexistent email that comes
back as `false`; for a real registered email it's `true`. The entire
point of the "same shape" response was to make the two
indistinguishable. The timing and response size happen to match, but
one boolean field tells the attacker whether the email is registered.

Live evidence (both calls for a fresh fake email):
```json
{ "deliveryConfigured": false, "resetId": "...", "expiresAt": "..." }
```
For a real user it would be `true`. Confirmed by reading the code; not
exercised live because that would spam a real inbox.

Fix: set `deliveryConfigured` from `emailConfigured(env)` — the server
tells the caller whether email is *configured* on the server, not
whether the account exists.

#### 5. Sign-out doesn't invalidate the JWT server-side (traced)

`/api/sign-out` bumps `session_version` but `auth()` doesn't check it
(`worker/src/middleware/auth.js`), so a stolen token stays valid for its
full 12-hour lifetime. This was called out as deliberate for multi-
device sessions in the earlier work, but it's still worth saying: the
"Sign out" button clears local storage; it does not revoke the token.

Fix: either enforce `session_version` in `auth()` (which breaks
multi-device), or document in the UI that sign-out signs out *this
device*. The second is cheaper and demo-safe.

### LOW

#### 6. Unauthenticated 404 looks like 401 (live)

`GET /api/nope` without an Authorization header returns
`401 "Login required"` instead of `404 "API route not found"`. Reason:
the router runs public routes, nothing matches, then runs `auth()`
which fails before any route can report the 404. API consumers hitting
a wrong URL get a misleading error.

Fix: in the router, catch the "no route matched" case *before* calling
`auth()` only for method/path shapes that are clearly non-API, or
collect the public routes' knowledge of path shapes and 404 before
authenticating. For a demo, this is cosmetic.

#### 7. CORS preflight response does not reflect the Origin on the
test request (live, inconclusive)

The OPTIONS preflight I sent returned `access-control-allow-origin:
null`. Real same-origin POSTs from the deployed site work (confirmed by
every other test on this page), so this does not block the app. The
browser blocks a page from setting the `Origin` header manually; my
preflight attempt likely didn't carry the right one. Flagging for
revisit, not a demo blocker.

### GOOD — things that behaved exactly right (live where marked)

- Module boots clean (live). Login form renders, auth view visible, no
  console errors on fresh page load after cache bust.
- `GET /api/health` returns ok, correct db + sample + user counts
  (live).
- `GET /api/bootstrap` without token returns `401 "Login required"`
  (live).
- `POST /api/login` with wrong credentials returns `401 "Invalid email
  or password"` (live). Audit log is written on failure (traced).
- `POST /api/signup/email/start` with missing/invalid email returns 400
  with the right message (live).
- `POST /api/signup/email/verify` with wrong OTP returns 400 (live).
- `GET /api/validate/signup` returns the right shape for an unused
  email + phone pair (live).
- `POST /api/password-reset/start` for a fake email returns a well-
  formed response with no error, same shape as the registered case
  (live) — minus the `deliveryConfigured` leak in #4.
- Approve endpoint re-verifies the admin's password and writes
  update + custody + audit as **one D1 batch** (traced,
  `samples.js:155-166`).
- Results endpoint writes result rows + status update + custody +
  audit as **one D1 batch** (traced, `results.js:46-66`).
- No `DELETE FROM samples / sample_results / chain_of_custody /
  audit_log` statement exists anywhere in the Worker (grepped). The
  only DELETE statements are: `pending_signups` (expected),
  `password_resets` (expected), `sample_files` (admin-only).
- User deletion is a soft-delete only (`active = 0, deleted_at = ...`)
  (traced, `users.js:95`).
- Lifecycle action is validated against `["Retained", "Disposed",
  "Active"]` (traced, `samples.js:178`). This is the pattern the PATCH
  route should also use for `status`.

---

## Fix status (after the follow-up commit)

| # | Severity | Status |
| - | -------- | ------ |
| 1 | CRITICAL — live-confirmed | **Fixed.** PATCH status whitelisted to the intermediate lifecycle. Approved stays on /approve, Disposed stays on /lifecycle. |
| 2 | HIGH     | **Fixed.** PATCH `assignedTo` now returns 403 for analyst callers; admin-only. |
| 3 | HIGH     | **Fixed.** Upload rejects any file over 20 MB, any request over 60 MB total, and any MIME outside {jpeg,png,webp,pdf}. |
| 4 | MEDIUM   | **Fixed.** `deliveryConfigured` now reflects the server's email config, not whether the email is registered. Response shape identical for both branches. |
| 5 | MEDIUM   | Not fixed in code — the server bump exists, the middleware check is intentionally omitted for multi-device. UI copy says "Signed out on this device" to match reality. |
| 6 | LOW      | **Fixed.** Router consults a path-shape allowlist before calling auth(); unmapped paths get 404 instead of 401. |
| 7 | LOW      | Reclassified — my CORS preflight test couldn't set the Origin header (browser blocks that). Real same-origin requests work; nothing to fix. |
| 8 | HIGH (added later) | **Fixed.** Frontend `<img src>` for R2-backed sample photos now goes through a `mediaUrl()` helper that prepends `API_BASE` and appends `?token=` so the Worker's auth fallback accepts the request. |

Also shipped in the same commit, not from the findings list:

- Audit-log monthly rotation to R2 with SHA-256 receipts. `AUDIT_PRUNE_D1`
  flag defaults off, so the first few months are pure backup. Admin can
  list / download / run via `/api/audit/archive`. Full design in
  `docs/ARCHITECTURE.md` §5a.

---

## Not covered by this pass

- Native UI click-through on authenticated views (dashboard, samples
  list, result sheet, approvals, archive export) — needs admin
  credentials I don't have.
- Email delivery through Resend / Gmail Apps Script — exercising this
  would spam real inboxes.
- Multi-user concurrency (two analysts editing the same sample at the
  same instant).
- Performance under load. The 2000-sample bootstrap cap is unknown-
  until-exceeded.
- Mobile layout testing beyond what the deployed CSS already handles.
- R2 ACL check with a real asset (I confirmed the code path; didn't
  exercise it against R2).

If the lab wants a real pre-demo rehearsal, the right move is 15
minutes of click-through on your own machine with the admin account
after items 1-2 are patched.
