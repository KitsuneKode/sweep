# TUI + core audit (2026-09-29)

Status: implemented
Scope: ui, engine, cli
Created: 2026-09-29
Updated: 2026-09-29
Commit: uncommitted
Parent: [daily-driver-overhaul/master.md](../daily-driver-overhaul/master.md)

## Why

A live headless-render audit of `sweep ui` (OpenTUI `testRender` harness driving the
real `SweepApp` at 30–120 cols) plus a line-level review of `packages/ui`,
`packages/core`, and `apps/cli`. The result: the TUI is structurally sound — abort
handling, escape ladder, streaming order-pinning, selection accounting are all
correct — but there is one hard crash, one broken pane, and one silent behavior
regression in the primary entrypoint, plus a stack of density/legibility issues
that explain why it reads as cluttered.

## Confirmed defects (evidence-ranked)

| #   | Severity                | Finding                                                                                                                                                                                                                                              | Evidence                                                                                                                                         |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **P0 crash**            | Modals segfault when the terminal is narrower than the fixed `width` _and_ shorter than the modal's content height (centered absolute box gets negative offsets on both axes → native OOB). `?` (72-wide help) kills `sweep ui` at e.g. 60x14, 44x18 | `packages/ui/src/widgets.tsx:24-49`; reproduced on a bare `<Modal>` — crash matrix in [01-modal-viewport-clamp.md](./01-modal-viewport-clamp.md) |
| 2   | **P1 broken pane**      | Patterns `<select>` renders exactly **one row**: it is a column-flex child with no `flexGrow`/`height`, so OpenTUI computes `maxVisibleItems = 1`. Users cannot see the pattern list                                                                 | `packages/ui/src/ReviewPane.tsx:142-159` vs `ArtifactList.tsx:75-83`; frame captures in [02-patterns-and-apply.md](./02-patterns-and-apply.md)   |
| 3   | **P1 empty queue**      | `sweep ui` always boots `emptyPlan` and `upsertCandidates` never honors `selectedByDefault` — the scan finishes with **"nothing selected"**, every time, on the only UI entrypoint                                                                   | `packages/ui/src/streaming.tsx:45-62,146-151`, `packages/ui/src/state/store.ts:265-279`                                                          |
| 4   | **P1 no confirm**       | `Enter` on a safe/caution-only queue applies **immediately** — one keystroke permanently deletes multi-GB. Only `dangerous` triggers the modal; `caution` bypasses it                                                                                | `packages/ui/src/app.tsx:292-299`; captured `OUTCOME: "apply"` with no dialog                                                                    |
| 5   | **P1 blind editor**     | Custom patterns (`--pattern`, config) live in `extraPatterns`, which is not part of `catalogPatterns` — the pattern editor cannot show or toggle them; they are silently active                                                                      | `apps/cli/src/handlers/ui.ts:151-157`, `packages/ui/src/ReviewPane.tsx:51-59`                                                                    |
| 6   | **P1 lost candidates**  | Rust engine: `candidate_found` events are emitted to hooks but never stored — only `candidate_updated` lands in `entriesByPath`. A found-but-unsized candidate displays in the UI yet is missing from the final plan                                 | `packages/core/src/rust-engine.ts:278-283`                                                                                                       |
| 7   | **P2 phantom grouping** | Single-candidate scope groups get no header (`groupCandidates.length !== 1`), so an orphan row renders visually inside the group above it — e.g. `vendor/legacy → target` inside `apps/web/`                                                         | `packages/ui/src/rows.ts:101-117`                                                                                                                |
| 8   | **P2 enrichment gap**   | Streaming path calls `candidateFromEntry` per entry → `enrichCandidates([single])` can never detect workspace stubs or symlink aliases (both need siblings). Batch path gets them; `sweep ui` doesn't                                                | `packages/core/src/planner.ts:108-112`, `candidate-insights.ts:76-98`                                                                            |

## Priorities

The visual "it looks bad" is mostly **glyph/pane chrome density**, not layout bugs:
every row carries a rail + selection mark + name + parent path + size + risk glyph,
every group carries a disclosure triangle + label + three stats, the sidebar adds a
meter bar and tree guides, and the whole thing sits inside two bordered panes with
two extra chrome lines above and below. [03-density-and-chrome.md](./03-density-and-chrome.md)
has the concrete de-chroming moves.

Edge cases and engine/guardrail hardening (silent `readdir` failures, bind-mount
cycles, `.GIT` case-sensitivity on macOS/Windows, dead exports, undocumented keys)
live in [04-edge-cases.md](./04-edge-cases.md).

## Execution order

```
01-modal-viewport-clamp   (P0 — do first, tiny diff, crashes real users)
02-patterns-and-apply     (P1 — broken pane + empty queue + confirm policy)
04-edge-cases             (P1/P3 — correctness, independent of UI work)
03-density-and-chrome     (P2 — visual pass; do after behavior lands)
```

01 and 02 are safe to land together; 03 is pure presentation and lowest risk;
04 touches core semantics — land after 02's streaming-queue change so enrichment
and selection seeding settle in one pass.

## Verification

```bash
bun run check
bun run rust:check   # only when crates/ changes — no Rust changes in these plans
```

For the harness-driven checks, `packages/ui/src/app.test.tsx` already uses
`@opentui/react` `testRender`; new tests should follow that pattern (see plan
files for specifics). Note: `mockInput.pressEscape()` needs a ~25 ms real-time
wait before assertions — OpenTUI's `StdinParser` holds a bare ESC for 20 ms
(`DEFAULT_TIMEOUT_MS`) disambiguation before emitting `escape`.
