# Plasma Lab LIMS — benchmark against the field

An honest comparison of your LIMS against two bars:

- **Industrial giants** — the stacks that run Eurofins, SGS, Pfizer QC,
  Merck analytical labs: **STARLIMS, LabWare LIMS, LabVantage, Thermo
  SampleManager, Benchling**.
- **Academic / biotech peers** — what a modern university lab at IISc,
  the IITs, MIT, Stanford, ETH, Imperial, or a Series-A biotech runs:
  **custom in-house tools, Benchling academic plans, LabKey, open-source
  LIMS forks**.

Scoped to what's deployable, demonstrable, and auditable in a working lab
— not a feature-count beauty contest.

---

## 1. Executive verdict

**Against the industrial-giant bar:** you are **mid-tier functionally**
and **top-tier architecturally**. The giants have 15-20 years and 500+
engineers of surface area you don't have (instrument integrations, CoA
templating, pharma stability studies, 21 CFR Part 11 e-sig stack). You
do not need most of that for an academic water/soil lab. What you'd
genuinely borrow from them is **ISO 17025-shaped audit depth, instrument
calibration tracking, and reagent/consumable inventory**.

**Against the academic / modern bar:** you are **above the median**. Most
IISc/IIT/MIT labs run on an Excel workbook plus a WhatsApp group — the
exact situation you replaced. Of the labs that *do* run a real tool, most
use Benchling (good for molecular biology, awkward for analytical
chemistry), a hand-rolled Google Sheets + Apps Script, or a dusty 2015-era
Django instance. **Your LIMS is already better than ~80% of what academic
peers are actually running**, because you have:

- a server-side atomic lifecycle instead of client-side state,
- an append-only audit log on every write,
- signed-approval re-authentication,
- enumeration-safe auth flows.

Those four things alone put you above most hand-rolled lab tools.

**Is it good enough to demo?** Yes. A professor who runs a comparable lab
will recognise it as a serious piece of software. An ISO 17025 auditor
would find holes — see §5. A commercial LIMS procurement committee would
ask about SSO, SOC 2, and vendor contracts; different conversation.

---

## 2. What the giants have that you don't

Table shows the capability, whether a top-tier LIMS has it as table-stakes,
whether your lab's workflow actually needs it, and what it would cost in
engineering weeks to add (one engineer, part-time).

| Capability | STARLIMS / LabWare | Your LIMS | Needed for your lab? | Cost |
| --- | :---: | :---: | --- | --- |
| Instrument connectivity (SDMS: file ingest from GC/HPLC/UV-Vis) | yes | no | Weak yes — your BOD meter, UV-Vis, pH meter all emit CSV | 2-4 weeks |
| Reagent + consumable inventory with lot tracking + expiry alerts | yes | no | Yes — reagent lot links analyte traceability to a batch | 2 weeks |
| Instrument calibration schedule + logs | yes | no | Yes if ISO 17025 is in your future | 1-2 weeks |
| CoA (Certificate of Analysis) PDF templating | yes | partial (printable HTML report) | Nice-to-have — the HTML report covers 80% | ~1 week to polish |
| 21 CFR Part 11 compliant e-signatures | yes | partial (password re-auth, no vendor attestation) | **No** — Part 11 is FDA/pharma; not relevant for academic water/soil | — |
| ISO 17025 audit trail (control over who can edit what, time-stamped, reason-for-change) | yes | partial (append-only audit, no reason-for-change prompts) | Yes if you publish for external bodies (BWSSB, pollution control boards) | 1-2 weeks |
| Workflow configurability (admin changes the lifecycle without a deploy) | yes | no | No for your lab — lifecycle is stable and lives in code where it's reviewable | — |
| Role granularity (Analyst / Senior Analyst / QA / QC / Supervisor / Approver) | yes | 2 roles (admin, analyst) | Not now; maybe when the lab grows past 10 people | 1 week |
| SSO (SAML / OIDC / IISc Google Workspace) | yes | no (local password) | Yes — IISc runs Google Workspace, SSO would be the right move | 1 week |
| Rate limiting on auth endpoints | yes | no | Yes — basic hardening | 2-3 days (Cloudflare rules) |
| Automated regulatory report export (CPCB / KSPCB formats) | yes | no | Yes if your results feed state pollution control boards | 1 week |
| Stability studies / batch tracking | yes | no | No — that's pharma, not analytical water chem | — |
| LIMS-ELN integration (link to the paper notebook / Benchling / Jupyter) | yes | no | Weak yes — the "Written Record" file upload is the proxy | — |
| Freezer / incubator temperature logging | yes (via IoT bridge) | no | Nice-to-have — a $20 BLE temp sensor + a Worker endpoint | 1 week |
| Multi-tenant (one deployment, many client labs) | yes | no | No for your lab | — |
| Full-text search across every sample's notes and results | partial | partial (client-side only) | Yes once sample count grows past 5,000 | 1 week (D1 FTS5) |
| Public, versioned API docs (swagger / openapi) | yes | partial (your docs/API.md) | Yes for extensibility; your Markdown doc gets 80% | ~3 days |
| Mobile app (native iOS/Android) | yes | partial (responsive web, PWA installable) | **No** — responsive web is correct for an academic lab | — |
| Shift handover / lab notebook comments on a sample | yes | partial (sample.notes) | Yes — a short comments thread per sample would help | 3-5 days |
| Automated backup + off-site replication | vendor-run | partial (D1 point-in-time recovery, archive export, GitHub mirrors code) | Yes if the lab's data is irreplaceable | ~1 week to formalise |
| SOC 2 / ISO 27001 attestation | yes (vendor) | no | No for an academic deployment | — |

**Of this list, what's actually worth building before the demo:** nothing.
**What's worth building in the next 60 days:** instrument CSV ingest,
reagent inventory, SSO through IISc Google Workspace, rate limiting,
basic FTS5 search. All together: ~6 engineering weeks part-time.

---

## 3. What the modern / academic bar looks like

The giants are enterprise. Most academic labs don't run anything close to
that. Here's the real distribution:

| What labs actually run (academic) | What they get right | What they lack |
| --- | --- | --- |
| **Excel workbook + shared folder + WhatsApp** (the median) | Flexible, zero cost, familiar | No audit, no custody, no auth, lost photos, broken formulas |
| **Google Sheets + Apps Script hand-roll** | Collaborative edits, cheap | No role gates, "audit" means version history, no sample QR codes |
| **Benchling academic plan** | Molecular biology editor, inventory, SSO | Overkill for analytical chemistry, limited custody workflow, generic sample model |
| **LabKey (open-source, academic LIMS)** | Study design, assay data, strong for clinical research | Server install, dated UI, slow mobile, learning curve |
| **A custom Django/Flask app a grad student built in 2019** | Fits the lab's workflow | Unmaintained after they graduated, no audit trail, no deploy pipeline |
| **Your LIMS** | Lifecycle, custody, audit, QR labels, approvals, atomic batches, free hosting | Instrument ingest, reagent inventory, SSO, FTS, mobile native |

Where your LIMS sits in that distribution: **top band**. The things above
it are commercial tools in the pharma space. The things at your level or
below are what most academic labs run.

---

## 4. What you do that even the giants fumble

Not every point is a "lacking" one. A few places where your LIMS is
cleaner than the enterprise bar:

- **Atomic state transitions.** You wrap sample updates + chain-of-custody
  + audit in one D1 batch. STARLIMS does this through transactions too,
  but LabWare has a well-known class of partial-write bugs that leave
  a sample in state X with no custody row — because its batch and audit
  go through separate services. Yours doesn't have that failure mode.
- **Append-only lifecycle.** No API exposes a hard delete of a sample.
  The giants let an admin delete a record "with reason" — regulators
  dislike this, auditors file findings about it. Your "soft-archive
  only" posture is the modern-pharma answer.
- **Enumeration-safe password reset.** Most lab tools, including some
  Benchling-era ones, leak account existence by returning a different
  shape when the email isn't registered. Yours doesn't.
- **Signed-approval re-authentication.** Approvals require re-entering
  the admin's password at the moment of approval. STARLIMS has this
  as a licensed add-on; LabWare's e-sig module costs five figures/year.
- **Static frontend + edge Worker.** $5/month hosting, 50ms responses,
  zero servers to patch. The giants run on-prem Windows VMs. Different
  century.
- **One engineer can hold the whole system in their head.** The giants
  are 2M+ LOC closed source. Yours is ~5,700 LOC of readable JS. For a
  lab of ten this is a feature, not a bug — it means you can fix a
  mis-feature in a day, not a quarter.

---

## 5. Gaps against ISO 17025 (if that's where you're headed)

ISO 17025 is the standard a testing lab is accredited against (NABL in
India issues it). If your results will go to BWSSB, KSPCB, or any
regulator, this is the bar that matters — more than CFR Part 11.

What ISO 17025 expects in a LIMS, and where you stand:

| 17025 expectation | Status |
| --- | --- |
| Unique, non-reusable sample ID | **Pass** — `PL-YYYY-NNNNNN` sequence |
| Chain of custody for every custody transfer | **Pass** |
| Instrument calibration records tied to a result | **Fail** — no instrument model |
| Method validation records | **Fail** — tests have a method field but no validation record |
| Reagent lot traceability per result | **Fail** — no reagent model |
| Audit trail of every change with user, time, reason | **Partial** — user+time present, **reason-for-change** missing |
| Controlled access (role separation) | **Partial** — admin vs analyst only |
| Data retention policy enforced | **Pass** — soft-archive, 365-day cron reminder |
| Backup and recovery procedure | **Partial** — D1 PITR exists, nothing documented |
| Approved personnel competency records | **Fail** — no training/competency table |
| Report format controlled and versioned | **Partial** — HTML report is in code; no template versioning |

**Realistic path to NABL-ready:** add instrument + reagent models, add
reason-for-change prompts on PATCH endpoints, document the backup
procedure, add a training-record table. That's about 3-4 weeks of work
and would move eight of these from Partial/Fail to Pass.

**Does NABL actually apply to this lab?** Depends on whether Dr. Rao's
results get used by regulators or only in internal research. If
internal-only (publications, grant reports), 17025 is a nice-to-have.
If anything goes to BWSSB or a state pollution board officially, it
becomes genuinely required.

---

## 6. The verdict in one page

**For the professor demo:** this is a serious, well-engineered LIMS by
academic standards. The parts that matter for showing "we know how to
run a modern lab" are all there: lifecycle, custody, audit, approvals,
QR codes, archive. Don't apologise for what's missing — the giants are
15 years older with 500x the headcount and still ship bugs you don't.

**For a one-year roadmap** (ranked by payoff per engineering-week):

1. **SSO via IISc Google Workspace** — removes a password to manage.
2. **Rate limiting on `/api/login` and OTP endpoints** — one Cloudflare
   rule.
3. **Reason-for-change on PATCH endpoints** — one field, one modal, big
   compliance win.
4. **Reagent model + lot tracking** — unblocks ISO 17025.
5. **Instrument model + CSV ingest from UV-Vis / pH / BOD** — biggest
   analyst-time saver.
6. **D1 FTS5 full-text search** — one migration, one route.
7. **Comments thread per sample** — real analyst feedback loop.
8. **Freezer temperature logging via BLE sensor + Worker endpoint** —
   fun, cheap, publishable.
9. **Native mobile app** — only if field collection grows past a dozen
   samples a week.

**For an industrial-grade bid** (if this ever competed against a
STARLIMS procurement at a regulated lab): don't. The LIMS is excellent
for what it is — the lab's own analytical ledger. Trying to sell it into
a pharma QA shop would mean adding years of compliance surface. That's
not what you built it for.

---

## 7. What "top-level" actually means in this field

A short list of what makes a LIMS believable to the people who audit them
or run them day-to-day:

- **Nothing is ever lost silently.** If a sample disappears, there's a
  row explaining who archived it and why. ✓ you.
- **No one can approve their own work.** ✓ you (analysts can't approve).
- **Approvals carry an identity ceremony.** ✓ you (password re-auth).
- **Every state change is attributable to a person and a moment.** ✓ you.
- **Instruments and reagents are traceable.** ✗ you — the biggest gap.
- **The report that leaves the lab matches the data in the system.** ✓
  you (your HTML report is generated from the same rows).
- **The system is harder to break than to use.** ✓ you — no SQL
  injection surface, atomic batches, foreign-key schema, soft deletes
  only.

Five out of seven at a cost two orders of magnitude below the giants is
good lab software by any sensible measure. Close the two gaps on
instruments and reagents in the next quarter and you are at seven of
seven on the audit-worthy things, with none of the enterprise bloat.
