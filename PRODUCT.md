# Plasma Lab LIMS — Product truth

## What this is
A laboratory information management system (LIMS) for a university water-quality lab. Each water sample enters as a QR-labeled bottle, moves through collection → storage → analysis → review → approval → disposal, and leaves a complete regulated audit trail. Admins register samples and approve results; analysts enter replicate readings; collectors photograph bottles in the field with GPS and timestamp auto-captured.

## Who uses it
- **Lab admins** (Project Assistants, Rao sir's team at IISc CST). Desktop, long sessions, bulk operations. Register samples, assign analysts, approve results, run exports.
- **Analysts** (grad students, trained staff). Desktop + mobile. Open assigned samples via QR, enter 3 replicate readings per parameter, flag out-of-spec values. Two analysts per sample by convention (one runs R1/R2, one runs R3).
- **Sample collectors** (field staff, drivers, project assistants). Mobile, one-handed, in the field. Scan bottle, photograph it (GPS+timestamp auto-captured), log site and source type.

## Brand commitments
- **Plasma Lab identity** — the lab's own logo is the anchor: a deep navy circular badge with a plasma-arc lightning bolt striking into water. Colors live there: obsidian navy, plasma arc white-blue, water blue. (Earlier builds used IISc maroon; that was wrong — maroon belongs to the Institute, not this lab.)
- **CST / IISc byline** stays visible as the institutional parent, in a secondary role, never as the color anchor.
- **Approval ceremony** — the password re-sign at approval is a product mechanic, not just UI.
- **QR-driven workflow** — scan is the first action from mobile.
- **Intake photo = custody evidence** — not a side artifact; the photo auto-carries GPS and timestamp.
- **No deletion of sample data** — archival is soft, exports are off-system backups.
- **Multi-device sign-in allowed; session ends on browser close** (Remember Me only prefills the email).

## Platform
- Single-page web app (vanilla HTML/CSS/JS, no framework), delivered as GitHub Pages.
- Cloudflare Workers backend, D1 (SQLite) + R2 (photos).
- Must work on desktop (admin bulk) and mobile 375px (collector in the field, often slow network).
- No build step for the frontend — one HTML, one CSS, one JS file. Fonts load from Google Fonts.

## Competitive context
Not a commercial LIMS (LabWare, STARLIMS). Built for one lab's actual workflow, not a configurable platform. The product's claim: a bench-ledger that happens to live on screens, not an enterprise admin console.

## Non-goals
- Not a billing or client-portal system.
- Not a multi-tenant SaaS.
- Not an instrument-integration platform (readings are typed in, not auto-ingested).
- Not a general-purpose spreadsheet or docs tool.
