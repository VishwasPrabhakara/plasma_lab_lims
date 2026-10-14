# Plasma Lab LIMS ↔ plasmalabiisc.com

Alignment plan: pull the LIMS visually and verbally into the orbit of the
lab's public site so a visitor who sees both recognises one lab. Plus a
list of what each side has that the other does not (the "not relating"
list).

> **Scope.** This is a design and content alignment plan, not a technical
> refactor. No API or data-model changes; only `public/styles.css`,
> `public/index.html`, `public/src/data/*`, `public/assets/*`, and the
> auth-view copy inside `public/app.js`.

---

## 1. What the lab's site actually stands for

Read from plasmalabiisc.com directly:

- **Identity.** "Plasma Lab" / "PLASMALAB" wordmark, rendered with a
  **neon-glow effect** on the mark (filename `PLASMALAB_NEONEFFECT`). The
  **IISc Master Seal** (black) and the **CST logo** flank the wordmark —
  institutional first, lab second.
- **Mission in their words.** "Cold plasma for energy, wastewater, and
  medicine." The only headline on the home page is "Focus of the LAB";
  the one-liner follow-up is "Wastewater treatment, quality analysis and
  recycling." A second sentence frames the stance: "Our research attempts
  answering the fundamental questions without neglecting the field
  implementation."
- **Imagery.** Scientific-apparatus photography only — dielectric barrier
  discharge, rotating gliding arc, plasma-activated water. No people
  photography. No abstract decorative visuals. Captions carry the names
  of the setups.
- **Tone.** Academic, technical, declarative. No marketing-speak. Short
  sentences. Mission-driven on sustainability without flourish. "Reserach
  Verticles" (sic) — this is a working lab's site, not an agency site;
  craft is accurate but not fussy.
- **Information architecture.** Home, People, Research, Courses,
  Publications, Facilities, News & Events, Gallery, Contact. The lab is
  defined by its people, projects, publications, and apparatus.
- **Copyright.** © 2022. The site hasn't been actively redesigned
  recently; whatever the LIMS commits to borrowing needs to be stable
  under their site, not chasing a moving target.

The one brand asset the lab visibly treasures is the **neon-glow
wordmark**. That is what carries the "plasma" of Plasma Lab.

## 2. What the LIMS currently signals

Read from the deployed LIMS:

- **Logo.** `plasma-lab-icon.png` — our own badge (deep navy, water
  waves, plasma arc). Not the lab's wordmark.
- **Theme.** Deep navy `#0a1628`, plasma-arc accent `#8fd3ff` (signal
  only), water blue `#4a8bc9` (primary action). Warm off-white body
  `#fbf9f5` in light mode.
- **Title.** "Plasma Lab LIMS." Subhead "Centre for Sustainable
  Technologies · IISc Bengaluru." Headline "Welcome back / Sign in to
  your lab."
- **Taglines in use.** "A monitoring station for every bottle." "Every
  sample is a reading on a continuous instrument."
- **Hero feature strip.** Four tiles: SCAN · SIGN · LOG · SYNC. These
  describe the product, not the lab.
- **Nav.** Dashboard, Samples, Scan, Approvals, People & Storage, Users,
  Data Backup, Activity Log.

The LIMS **has already picked a serious lab-informatics register** —
hairline chrome, muted palette, "signal" plasma colour, nothing flashy.
That's good; the lab's site is also serious. The gap is not tone; it's
**identity attachment**: nothing in the LIMS says "this is Plasma Lab"
except the subhead text.

## 3. Alignment plan — concrete work items

Grouped by surface, from highest payoff to lowest. Each item is a single
PR's worth of work, 30 minutes to a couple of hours. No order dependency
unless noted.

### 3.1 Shared identity assets (highest payoff)

1. **Place the real wordmark in the auth header.** Add
   `public/assets/plasmalab-wordmark.svg` (or `.png` — see §4), the
   neon-glow mark the public site uses. Put it above the "Welcome back"
   card so the sign-in screen opens with the lab's own identity, not an
   invented icon. Keep our water-badge as the favicon and the collapsed
   sidebar glyph — it still earns its place at the small sizes where a
   wordmark would be unreadable.
2. **Flank it with the institutional seals.** Below the wordmark, show
   the IISc Master Seal (black) and the CST logo at ~24 px tall,
   separated by a thin divider. This is exactly how plasmalabiisc.com
   stacks its header — institution first, lab second. In the app, keep
   only the lab's wordmark in the sidebar.
3. **Link the seals out.** Each seal links to its origin
   (`iisc.ac.in`, `cst.iisc.ac.in`). On the signed-in surface this
   becomes a one-line footer link, not a header element.

### 3.2 Verbal alignment

4. **Replace the invented tagline with the lab's own.** "Cold plasma for
   energy, wastewater, and medicine" is the headline the lab chose for
   itself. Use it, verbatim, under the wordmark on the auth screen as
   the orienting line. Keep "A monitoring station for every bottle" as
   a smaller product tagline below.
5. **Keep "lab-first" copy.** Change "Sign in to your lab" to "Sign in
   to Plasma Lab's sample ledger" — a visitor who recognises the lab
   name grounds immediately. Replace "lab" with "Plasma Lab" wherever
   the LIMS currently generic-ises.
6. **Match their vocabulary.** Their site says "research verticals,"
   "projects," "facilities." The LIMS says "Samples," "Approvals,"
   "People & Storage." Those are correct for a LIMS and don't need to
   change — but **when the LIMS refers to the lab's work**, mirror
   their terms. Example: the empty-samples state should say "No samples
   yet from your current projects" rather than "No samples yet."

### 3.3 Visual alignment

7. **Audit the plasma-arc accent against their neon glow.** Their
   wordmark glow is a bright cyan-white on dark; our current
   `--plasma-signal #8fd3ff` is close but reads cooler. Nudge toward the
   actual glow color sampled from the wordmark SVG so the two feel
   related. One CSS token change.
8. **Add a hairline process photo band on auth, optional.** The lab's
   site is dominated by apparatus photography. Reserve a 72 px band on
   the right of the auth screen (desktop only, hidden on narrow) for one
   quiet apparatus photo (dielectric barrier discharge or plasma-
   activated water) with a `brightness(0.6) saturate(0.7)` filter so it
   recedes behind the form. Caption it with the setup name, mirroring
   their caption discipline. If the photo doesn't land politely, leave
   it out — do not add it just for decoration.
9. **Remove the SCAN / SIGN / LOG / SYNC tile strip from auth.** Four
   features of a product don't belong on the sign-in screen of a tool
   you already decided to use. The lab's own homepage has nothing like
   this. Keep the tiles on the authenticated empty-state of Dashboard,
   where a new admin hasn't created a sample yet.

### 3.4 Structural touches

10. **Add a one-line footer across the app.** Mirror the lab footer:
    "Plasma Lab · Centre for Sustainable Technologies · Indian Institute
    of Science · Bengaluru." Links from each proper noun to its page on
    the lab's site. Keep the LIMS version number at the right end so
    debug reports from analysts always carry build info.
11. **Add an "About this tool" link in the sidebar footer.** One click
    opens a small modal: who built it (you, under Dr. Rao), what it
    tracks, link to the lab's site. Costs 60 lines. Grounds the LIMS as
    the lab's instrument, not a floating app.
12. **Match tab titles.** Their tabs read "Plasma Lab | Home,"
    "Plasma Lab | Research." Ours read "Plasma Lab LIMS — IISc CST."
    Change to "Plasma Lab LIMS · Dashboard" and friends so a visitor
    moving between the lab site and the LIMS sees the same leading
    phrase.

### 3.5 Not doing (and why)

- **Not re-skinning the LIMS to look like the lab's site.** The lab's
  site is content-first with a lot of apparatus photography; a LIMS is a
  dense data surface. Dressing one as the other hurts both. Alignment is
  shared identity (wordmark, seals, copy), not a shared layout.
- **Not matching their navigation.** "People," "Research," "Courses"
  belong to a public site and have no counterpart in a sample ledger.
- **Not adopting the (sic) typos.** Keep the LIMS copy clean.

---

## 4. Asset acquisition

Items 1 and 2 need actual files, not links. The lab's site does not
publish an asset kit, so:

- **Wordmark.** Save the live asset from plasmalabiisc.com's homepage
  (filename contains `PLASMALAB_NEONEFFECT`) as
  `public/assets/plasmalab-wordmark.png` and also an SVG re-render if
  one is available. Keep the original as the master. Confirm with Dr.
  Rao that we may use it in the LIMS before publishing. If no SVG, keep
  the PNG and serve 1× and 2× variants.
- **IISc Master Seal.** Use the official seal from iisc.ac.in brand
  assets. Do not reconstruct it.
- **CST logo.** Use the one on cst.iisc.ac.in.
- **Apparatus photo (if item 8 lands).** Use one of the three they
  publish; attribute in the alt text; do not scrape silently.

Where any single asset isn't cleanly reusable, fall back to a textual
treatment (wordmark set in a condensed serif with the plasma-arc color
on `o`, for example) rather than redrawing their mark.

---

## 5. "Not relating between the two" — the gap list

### Things the lab website has that the LIMS has no counterpart to

| Element on the public site                     | Why it isn't in the LIMS                          | Should it be?                             |
| ---------------------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| People directory (PI, postdocs, PhDs, alumni)  | LIMS has `users` + `people` but no public bios    | **No.** LIMS is operational, not a profile. |
| Research verticals                             | LIMS tracks samples, not research framing         | **No**, but see item 6 — mirror vocabulary. |
| Courses (ST214, UES314, ST228, ST224, CCE224)  | LIMS is not a teaching tool                       | **No.** |
| Publications (journal, conference, patents)    | LIMS has `sample_results` and reports, not papers | **No**, but a future "Linked publications" field on a Sample row would make the lab's output traceable back to its raw data. |
| Facilities / Resources                         | LIMS tracks storage locations but not instruments | **Weak yes.** Adding an `instruments` master-data table parallel to `storage_locations` would let a result cite the apparatus (e.g. "APHA 5210 B on BOD incubator A2"). Post-demo. |
| News & Events                                  | LIMS has no newsroom                              | **No.** |
| Gallery                                        | LIMS has `sample_files` photos, scoped per sample | **No.** The audit log is the LIMS's gallery. |
| Contact page                                   | LIMS has no public surface                        | **No**, but the footer in §3.4 covers the equivalent for internal users. |
| Scientific apparatus photography               | LIMS currently has no photography at all          | **Optional yes** — see item 8. One quiet photo, not a slideshow. |
| PLASMALAB neon-glow wordmark                   | LIMS uses an invented icon badge                  | **Yes.** This is item 1 and the highest-payoff change. |

### Things the LIMS has that the lab website has no counterpart to

| Element in the LIMS                                            | Lab-site counterpart           | Note                                                               |
| -------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| Role-gated sign in                                             | None                           | Expected — the lab's site is public, the LIMS is internal.         |
| Sample lifecycle (Bottle Ready → Approved → Disposed)          | None                           | This is the LIMS's whole reason for existing.                      |
| QR tube labels                                                 | None                           | Keep. Not a brand surface.                                         |
| Chain of custody + audit log                                   | None                           | Keep. Not a brand surface.                                         |
| "A monitoring station for every bottle" tagline                | None                           | **Demote**, don't remove — see item 4.                              |
| SCAN · SIGN · LOG · SYNC feature tiles                         | None                           | **Move** off the auth screen (item 9).                              |
| Approvals queue + password-reauthentication ceremony           | None                           | Keep. The lab's site has no reason to describe this.                |
| Analyst assignment ("two analysts, comma-separated")           | None                           | Keep. Lab-informatics specific.                                     |
| Monthly cron archive reminder                                  | None                           | Keep. Operational only.                                             |
| Our water-badge icon (`plasma-lab-icon.png`)                   | None (they have a wordmark)    | **Demote** to favicon + collapsed-sidebar glyph (item 1 covers this). |

### Mismatches of flavour, not of structure

- The lab's site **has a date on it** — © 2022. The LIMS has a build SHA
  footer. These two "last-updated" signals should look like they belong
  to the same lab; the LIMS footer should say "Plasma Lab · built
  <date>" using the shared footer line from item 10.
- The lab's site has **one headline** on home ("Focus of the LAB"). The
  LIMS currently stacks a title, a subhead, a tagline, a second tagline,
  and a feature strip on auth. **Remove the second tagline and the
  feature strip** (item 9) so the LIMS auth also lands on one headline.
- The lab's site has **(sic) typos** ("Reserach Verticles"). We **do
  not** mirror that — but we also do not fix it on their side without
  being asked.

---

## 6. Sequencing

For a sane week:

1. **Day 1 (demo-safe):** items 1, 2, 4, 5, 10, 12. Visual lift, no
   risk, one commit each. The wordmark is the single change a professor
   will see from across the room.
2. **Day 2:** items 3, 7, 9. CSS token tune + remove the auth tile
   strip. Minor file moves.
3. **Later:** items 8, 11. Both are nice-to-have and need a design
   call.

If anything on this list fights the time budget before the demo, cut
items 7, 8, 11, 12 first. Items 1, 4, and 9 are the three that most
change what a visitor feels.

---

## 7. What this does not do

- Not a redesign of the LIMS. It is already in the right register.
- Not a backend change. All items touch `public/*` only.
- Not a copy change on plasmalabiisc.com. We adapt to the lab's site,
  not the other way around.
- Not an asset-pack buildout. The lab doesn't have one; we borrow their
  live assets with permission and keep the LIMS lean.
