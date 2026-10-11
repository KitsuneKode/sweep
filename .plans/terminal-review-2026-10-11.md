# Terminal review and accessibility

Status: done
Scope: ui
Created: 2026-10-11
Updated: 2026-10-11
Commit: accompanying terminal-review change

This pass covers the artifact list, inspector, confirmation and active apply
flow in the OpenTUI app. It uses the requested interface skills with terminal
cells and native input, rather than browser layout or motion recipes.

## Direction

A developer needs to identify an artifact, review its risk and approve an exact
selection. Paths and selection scope lead; byte totals and age support them.
Keep the existing charcoal/sage palette, terminal font and touching panels.
Use borders for focus, one-cell spacing in rows, and compact scrollable dialogs.
Keyboard movement and confirmation stay instant. Activity may animate only while
work runs, with a visible pause control and a static alternative.

## Verified leads

1. Some text tokens fail 4.5:1 on hover and soft-selection backgrounds. Light
   accent text fails even on the main surface. Measure every actual text pair,
   including blocked rows and focus markers, before changing values.
2. Queue shape and risk color share one glyph; focused rows turn it white, so
   caution and danger become indistinguishable. Give risk a separate shape.
3. Loaders run at 60 ms with no reduced-motion preference or pause key.
4. Inspector reasons and action hints use non-wrapping lines. Exercise realistic
   long paths and reasons at 30, 40, 72, 120 and 180 columns in the native renderer.

## Work

- Correct semantic token values and support NO_COLOR without losing risk cues.
- Add a reduced-motion preference and a session-local pause toggle; keep activity
  counts, elapsed time and cancellation independent of decorative frames.
- Keep inspector actions visible while details scroll; wrap unbroken paths.
- Add dev-only Demo / Worst / Empty / One / Huge fixtures at the plan boundary.
  This harness must never connect to an apply engine or mutate files.
- Run native render and keyboard regressions, contrast checks, bun run check,
  then the full verification ladder and hosted CI for the committed source.

## Separate work

Default native paging still needs aggregate/scope/ordering/retirement support
before the current all-candidate reducers can be replaced. A page must never
stand in for the whole queue. Concurrent mount replacement and allocated
200–600 GiB qualification remain separate gates; UI polish does not close them.

## Interface review

Scope: the OpenTUI artifact-review flow, inspection, confirmation and active
apply overlay. Conventions inspected: AGENTS.md, `.docs/ux-principles.md`,
`.interface-design/system.md`, the current theme and native renderer tests.
The stale design record now links to those owning documents instead of mirroring
an unused palette. Browser layouts and the docs website are outside this pass.

| Domain        | Evidence inspected                                                  | Result                                                  |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| Accessibility | Focus/risk glyphs, stop input, paused activity, contrast checks     | Corrected color-only risk and continuous motion         |
| Layout        | Native 30/40/72/120/180-column renders; scrollable inspection       | Corrected clipping and pinned actions                   |
| Writing       | Inspect/apply hints, progress warning, terminal guide               | Explicit stop, pause and scope language                 |
| Typography    | Cell-width helpers; CJK, combining and emoji paths; size cells      | Units stay complete; paths remain inspectable           |
| Color         | Dark/light text on normal, hover and soft selection; NO_COLOR       | Measured contrast tests pass; neutral mode keeps shapes |
| UI            | Instant navigation, active-work animation, empty/one/10k-row states | Bounded rendered rows and pausable activity             |

| Severity | Domain        | Location                              | Before                                                                | After                                                                  | Why                                                    |
| -------- | ------------- | ------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| HIGH     | Color         | `packages/ui/src/theme.ts:34`         | Dim/blocked text and light accent fail their actual background checks | Adjust semantic tokens; test text at 4.5:1 and focus rails at 3:1      | Real information must stay readable                    |
| HIGH     | Accessibility | `packages/ui/src/presentation.ts:154` | One glyph combines queue shape and risk hue                           | Separate queue and risk glyphs, including focused and neutral rows     | Consent review cannot depend on color                  |
| HIGH     | Layout        | `packages/ui/src/app.tsx:490`         | Long reasons/actions clip or move beyond inspection                   | Wrap root/path/reasons; keep actions outside scroll                    | Users need the full path and an exit                   |
| MEDIUM   | UI            | `packages/ui/src/widgets.tsx:116`     | Activity ticks at 60 ms without pause                                 | Tick at 160 ms only while active; support environment preference and m | Reduce distraction and idle timers without hiding work |
| MEDIUM   | Typography    | `packages/ui/src/presentation.ts:266` | A partial 600 GiB estimate clips its unit                             | Compact the label before padding                                       | A number with a cut unit is ambiguous                  |
| MEDIUM   | Writing       | `packages/ui/src/presentation.ts:464` | Pattern/group context can print `[object Object]`                     | Compose StyledText without string coercion                             | Context must describe the actual review state          |

All findings in this table are fixed in the accompanying change.

### Verification

- `bun run check`: passed after native input, scrollbar and cancellation regressions.
- `bun run verify -- --all`: eight pre-commit steps passed, including Rust,
  installed-package and standalone smoke. Preflight requires committed source;
  rerun the complete ladder on the clean commit before pushing.
- Native render tests: Demo/Worst/Empty/One/Huge at five widths; Huge reaches its
  last ordered item with fewer than 500 mounted renderables. This bounds mounted
  UI elements, not total process memory or candidate storage.
- Narrow inspection: paging reaches the long path tail and full reason while
  close/delete actions stay visible.
- Activity: pausing releases its interval; resume owns one; unmount releases it.
  Same-drain pause/resume preserves the active apply's ids and cancellation.
- Input: m remains filter text; scrollbar click/drag still seeks the correct row.
- Linux PTY preview: switch Worst/Empty/Huge/One, confirm a dry run, then quit.
  Exit 0 and the alternate-screen restoration sequence were observed. No files
  were created or deleted by the preview.
- `python3 scripts/smoke-focused-ui.py`: the compiled production CLI inspected
  bravo, removed only that confirmed owned artifact, preserved alpha in the
  queue, and exited via q with its receipt and terminal restoration.

Not verified here: physical-terminal/font differences, assistive technology,
live macOS/Windows interactive sessions, production paging, total UI retained
memory at 50k+, concurrent mount replacement, allocated 200–600 GiB deletion.

Verdict: Approve the inspected terminal flow. This is a scoped interface review,
not a release or large-tree safety qualification.
