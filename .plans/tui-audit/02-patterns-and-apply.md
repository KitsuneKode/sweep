# 02 — Patterns pane, streaming queue seeding, apply confirmation

Status: done
Scope: ui, engine
Created: 2026-09-29
Updated: 2026-09-29
Commit: uncommitted
Parent: [README.md](./README.md)

Three P1 defects in the review loop itself: the pattern editor renders one row,
streamed scans never queue anything, and `Enter` deletes without confirmation
when nothing is `dangerous`.

## 2a — Patterns `<select>` collapses to one row

### Evidence

- `packages/ui/src/ReviewPane.tsx:142-159`: the `<select>` is a direct child of
  the artifacts pane's column flex with **no `height`/`flexGrow`/`flexShrink`**
  props. OpenTUI resolves its height to 1.
- `SelectRenderable` computes `maxVisibleItems = floor(height / linesPerItem)`
  (`@opentui/core` SelectRenderable, constructor + `onResize`), so height 1 →
  `maxVisibleItems = 1` → exactly one option rendered.
- Headless capture of `p` at 120x34 shows `▶  ✓ build` and nothing else — the
  13 other patterns are invisible. Space/arrows still work, so it looks
  "half-broken" rather than fully dead.

### Fix

Give the select real height, matching how `ArtifactList` sizes its scrollbox:

```tsx
<box flexGrow={1} minHeight={0} width="100%" flexDirection="column">
  <select width="100%" height="100%" flexGrow={1} ... />
</box>
```

Also render a 1-row header line (`pattern · enabled/disabled · space toggles`)
above the list so the lone-row state is self-explanatory at short heights.

### Tests

- `app.test.tsx` frame test: press `p`, assert ≥ 5 `✓`/`·` pattern rows visible
  in the captured frame.
- `state.test.ts`: nothing new needed — toggle/ clamp logic already covered.

## 2b — Streaming scans end with an empty queue

### Evidence

- `apps/cli/src/handlers/ui.ts:145` always calls `runSweepUiStreaming`; the
  legacy non-streaming `runSweepUi` is not reachable from the CLI.
- `streaming.tsx:45-62` builds `emptyPlan` with `selectedCandidateIds: []`.
- `store.ts:265-279` `upsertCandidates` merges discoveries but never touches
  `selectedIds`.
- Result (captured frame): scan completes with `18 found`, footer says
  `nothing selected` even though 10 candidates carry `selectedByDefault`.
  The batch path seeds `createUiState` from `plan.selectedCandidateIds`
  (`store.ts:86`), so the two paths disagree and the default selection policy
  is dead code in practice.

### Fix sketch — seed on first insert only

In `upsertCandidates`, when a candidate id is **newly inserted** (not a sized
re-upsert of a known id) and `candidate.selectedByDefault` is true, add it to
`selectedIds`. Sized re-upserts (`existing !== undefined`) never re-add, which
preserves manual deselects during the scan and makes `u` sticky for entries
already seen.

Not seeded: anything arriving in a batch after the user pressed `u`/`a` during
the scan — decide deliberately: simplest consistent rule is "newly discovered
defaults keep queuing while scanning" (matches "the policy is running"), which
is also the least surprising when streams deliver thousands of entries.

Also apply `patternsDirty`-style care: `resetForRescan` already clears
`selectedIds` (`store.ts:393-407`) — the reseed just happens again on the new
generation, which is correct.

### Tests

- `state.test.ts`: `upsertCandidates` seeds `selectedByDefault` ids on insert,
  does not re-add after `toggleSelectionById` deselect, does not queue
  `blocked`/`dangerous`/workspace-stub candidates.
- `app.test.tsx` streaming test: after `onDone`, footer/header reflect a
  non-zero queued count matching the plan's default selection.

## 2c — `Enter` applies with no confirmation when nothing is `dangerous`

### Evidence

- `app.tsx:292-299` `requestApply`: `if (dangerousSelected > 0) → modal; else
finalize(apply)` — a safe/caution queue deletes on a single keypress.
- Captured run: `pressEnter` on a 10-item / 5.8 GB safe queue emitted
  `OUTCOME: "apply"` with no dialog.
- `.docs/ux-principles.md`: "Destructive behavior must never be automatic" and
  "dangerous selections require deliberate interaction and red confirmation" —
  a permanent delete with zero friction undercuts the trust-first positioning.
- `caution` items (symlinks, workspace stubs) currently bypass the confirm too.

### Fix sketch

Show `ConfirmOverlay` for **every** apply (count + bytes is already there; the
dangerous callout stays conditional). `y`/`n`/`esc` already work. This removes
the two-path branch entirely — simpler keymap (`pendingApply` becomes the only
apply path) and more predictable.

If speed matters, gate on `dryRun` (already labeled "Preview deletion of") or a
future `--no-confirm` flag; do not keep the implicit fast path.

### Tests

- `app.test.tsx`: update `"select-all then enter applies all visible
candidates"` and `"bulk select then enter applies without confirming merely
visible dangerous items"` — the second test name encodes the behavior being
  removed; rewrite it as "enter always opens confirm; y applies".
- Keep the dangerous-banner test (red title + warning line).

## 2d — Custom patterns invisible in the pattern editor

### Evidence

- `apps/cli/src/handlers/ui.ts:152-157`: `catalogPatterns: [...DEFAULT_PATTERNS]`,
  `extraPatterns` holds user/config patterns separately.
- `ReviewPane.tsx:51-59` maps only `catalogPatterns` → the `<select>` never lists
  `extraPatterns`; they are active but un-toggleable in the UI.

### Fix sketch

Union the lists in `patternOptions` with a visual tag (e.g. `✓ .venv  custom`),
ordered after catalog entries. `togglePattern` on an extra-pattern entry can
either (a) move it to `disabledPatterns` for the session — but `disabledPatterns`
only subtracts from `catalogPatterns` in `activePatterns` (`store.ts:119-122`),
so extras need their own `disabledExtraPatterns` set, or (b) simplest correct:
merge extras into `catalogPatterns` at init and drop the separate channel, since
`rescanConfigFromState` already exports `disabledPatterns` + `extraPatterns`
separately — recompute extras as `catalogPatterns − DEFAULT_PATTERNS` there.

### Tests

- `state.test.ts`: init with `extraPatterns`, assert they appear in the pattern
  list and toggling one removes it from `activePatterns`.

## Risk / effort

- 2a: S, pure layout. 2b: M, selection semantics need the deselect-during-scan
  matrix covered. 2c: S code, but it is a deliberate UX policy change — flag in
  commit message / changelog. 2d: S–M depending on which extra-pattern model is
  chosen.
- Run `bun run check` (full gate) when landing.
