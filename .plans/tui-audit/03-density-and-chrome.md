# 03 — Density, chrome, and legibility pass

Status: done
Scope: ui
Created: 2026-09-29
Updated: 2026-09-29
Commit: uncommitted
Parent: [README.md](./README.md)

Landed: 3a (single status cell — mark shape = queued, color = risk; the `R`
column is gone), 3b (every group emits a header), 3c (parent path only when it
differs from the group label), 3d (brand collapses to `◆` <44 cols; header
stats tier at <100/<84; compact footer hints <72), 3e (shortened scanning
strip), 3f (dead-key notices for exhausted esc / empty-queue enter / space on
blocked). Sticky group headers and a `░`/`█` scrollbar lane came along with
the windowed list rewrite.

## Why it "looks bad"

Captured frames at 120x34 show the mechanics work, but the information design
fights itself:

1. **Five glyph systems on one screen.** Rows carry `▌` (cursor rail) +
   `●`/`○` (selection) + `✓`/`!`/`✗`/`⊘` (risk column labeled only `R`) +
   `▾`/`▸` (group disclosure) + `›`/`▸` (sidebar). A row reads
   `▌ ● node_modules apps/web 1.7 GB ✓` — the `●` and the `✓` look like the
   same affordance and mean different things. Headers say `R` with no legend.
2. **Phantom group membership.** `vendor/legacy → target` renders inside the
   `apps/web/` group with no separator because 1-item groups drop their header
   (`rows.ts:105` `showHeader = groupCandidates.length !== 1`).
3. **Double location display.** Group header says `apps/web/`; the row's name
   cell repeats `apps/web`; the context line repeats the absolute path. Three
   renderings of the same answer.
4. **Chrome-to-content ratio.** Header band + 2 rounded borders + column
   header + rule + context line + statusline = ~7 rows of chrome on a 24-row
   terminal before a single artifact shows. OpenTUI guidance explicitly favors
   gap-free, low-chrome density.
5. **Truncation without priority.** At ≤44 cols the layout degrades by
   clipping the _hints_ mid-word (`· enter `) while the cryptic `R` header
   survives; at 30 cols the brand collides with stats (`◆ swe18 found`).

## Fix sketch (in dependency order)

### 3a — Merge selection + risk into one marker

Replace the two-glyph row format with a single status cell:

- `●` selected & safe · `◐`-style or colored `●` for selected caution ·
  `✗` dangerous · `⊘` blocked · `○` unselected.
- Drop the `R` column entirely; risk is the mark's color/shape.
- Rename the column header or remove it — the row reads `▌ ● node_modules
apps/web 1.7 GB` and nothing competes.

`buildArtifactRowContent` (`presentation.ts:96-132`) + `artifactRowWidths`
(`:43-50`) simplify; `RISK_COLUMN_WIDTH`/`GLYPH_GAP` go away. The context line
already restates the risk tier textually for the focused row — keep that.

### 3b — Fix phantom grouping

Two acceptable options; prefer the first:

- Always emit the header (`showHeader = true`). Costs ≤ a handful of rows in
  real projects; removes a whole class of "which group am I in" bugs. The
  1-item-header-is-chrome rationale (`rows.ts:101-105`) optimizes for a case
  that confuses every other case.
- Or: keep header suppression but give orphan rows a leading blank cell /
  different marker so they can't read as members of the group above.

While pinned (`order !== null`) the header is already always drawn — so this
is a one-line change in the unpinned path plus updated expectations in
`rows.test.ts` / `app.test.tsx`.

### 3c — Kill the redundant path column

The name cell renders `name  parent-path` — the parent duplicates the group
header 90% of the time. Show the parent segment **only when it differs from the
row's group label** (i.e., exactly the headerless-orphan case, where it's the
only place the location appears). Reclaims ~12-20 cols per row at wide widths.

`splitNameCell` (`presentation.ts:143-165`) gains a `groupLabel` arg; orphan
rows keep the current `name parent` rendering.

### 3d — Adaptive header + statusline

- `buildHeaderStats` (`presentation.ts:246-276`): at < 100 cols drop
  `found`; at < 84 drop `queued`-bytes; at < 60 keep only `◆ sweep` + `DRY RUN`.
- `buildFooterHints` (`:386-421`): two tiers — full hints ≥ ~72 cols, else
  compressed `↑↓ move · ? keys`. Never clip mid-hint.
- Below ~50 cols total, render a single-line `terminal too small —
resize to ≥ 50` fallback instead of a clipped pane.

### 3e — Scanning strip copy

`ScanningStrip` (`ReviewPane.tsx:238-276`) overflows at 120 already
(`…sorts by size whe`). Shorten to `scanning · N found · found order` and let
the completion re-sort speak for itself; put the long explanation in `?` help.

### 3f — Misc legibility

- `buildSidebarLine` (`presentation.ts:464-513`): top-level scope rows are
  indented 2 cols and look nested under the `▸` row above — reduce depth-0
  indent or draw a visible guide root.
- Confirm modal: the ⚠ line wraps mid-sentence at width 52 — pad content or
  shorten the copy (`1 dangerous item — cannot be undone`).
- `escapeStep` no-ops silently when unwound; flash the context line
  (`nothing to unwind`) so the key isn't dead.
- `requestApply` silently no-ops on empty selection — same treatment.

## Tests

- `app.test.tsx` frame asserts: no `R` column; every group has a header; the
  `vendor/legacy` orphan doesn't render under another group's heading.
- `presentation.test.ts` exists already — extend it for `splitNameCell`'s
  new group-aware path and the tiered header/footer strings.
- Narrow-width frame tests: 44x14 and 30x10 produce the fallback copy, not
  clipped panes.

## Risk / effort

M — pure presentation, no behavior changes, but it touches every row's pixel
layout so existing frame tests will churn. Do after 01/02 land so frames only
change once.
