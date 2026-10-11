# Surface brief — app shell

**Scope.** The chrome around every view: top header, desktop left-rail nav (new), mobile bottom tab bar, auth brand chrome, color + type tokens for both themes. Content views (dashboard, sample detail, result sheet, etc.) inherit the new tokens but their internal composition stays as it is.

**Visitor mode.** Operate.

**Audience / job / proof.** Admin, analyst, collector working through regulated sample lifecycle. Must give unmistakable sense of place, role, and system status; must never obscure the task. Earlier IISc-maroon identity is retired — Plasma Lab is its own lab with its own anchor.

## Direction contract

**THESIS.** This is a lab that measures water, so its shell reads as a hydrograph — a water-level trace that treats each sample as a reading on a continuous instrument. The category default is the dark-sidebar admin console; this one is a monitoring station. The nav, the status chips, and the sync indicator all admit they are watching a signal, not browsing a database.

**OWN-WORLD.** Deep navy ground (`#0a1628` dark theme / `#f3f6fb` light theme) sourced from the Plasma Lab logo badge. Primary accent is plasma arc white-blue (`#8fd3ff`) — the signal color, used on primary CTAs, active nav indicator, current lifecycle step, sync-live pulse. Secondary is water-blue (`#2b6bb3`) — used on link text, info chips, chart baseline strokes, secondary buttons. Status trio: emerald `#2fb97a` (approved / in spec), amber `#e6a23c` (needs review / near limit), coral `#e5604a` (flagged / out of spec). Hairline chart-line rules at `1px` separate zones; thicker `2px` strokes mark active ones. Typography: **Inter** for UI (already loaded), **JetBrains Mono** for codes, numbers, and chart labels — tabular lining numerals, consistent 0 slash. Fraunces is removed; display serif has no place on a monitoring station. The one signature material: wherever an active state meets a neutral surface, a 1px plasma-blue hairline + 1px inner glow — a "current reading" edge.

**STORY.** The visitor arrives and instantly reads: which station I'm at (header title + logo), who I am (role badge), what's live (sync pulse, pending-review counter as a hydrograph tick). The left rail is a run of monitoring tabs with hairline connectors between them — not a stack of boxes. Mobile replaces the rail with a 4-tab bar where Scan has a bespoke plasma-bolt glyph. Opening a sample feels like zooming into one well's reading.

**FIRST VIEWPORT.** Desktop (1440×900):
- 72px left rail (full), icon + 10px label, 6 nav items grouped by section with 1px hairline dividers. Active item: plasma-blue 2px left bar + inset glow. Collapsible to 56px icon-only.
- 56px top header: logo lockup (28px plasma-badge + "Plasma Lab" wordmark in Inter Semibold, "LIMS" in JetBrains Mono micro-caps), current-view title (24px Inter), stretched search field (hairline underline, no box), sync-pulse chip (shows live/syncing/offline with a 1Hz plasma-blue dot), account menu (initials in navy ring).
- Below header: 24px gutter; the view content lives in the remaining area.
- Right pane for the audit timeline collapses on <1280px.

Mobile (375×812):
- 56px top header: logo mark only + title + sync dot + account.
- 48px bottom tab bar: Scan (bespoke plasma-bolt), Samples, Home, Me — labels 12px, active tab lifted with 2px plasma-blue top edge + inner glow.
- The whole body between header and tab bar is content; no left rail.

**FORM.** Hydrograph (my own ranking #1, surfaced on the roll as IMPECCABLE'S PICK after assigned #7 Timetable was declined). Seed key: `490013b4`. Timetable's one donated discipline — tabular monospace for codes and timestamps — is adopted (sample codes and chain-of-custody times in JetBrains Mono). Canon exit was offered and declined.

**FINISH.** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
