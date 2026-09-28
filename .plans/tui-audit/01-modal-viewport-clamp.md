# 01 — Clamp modals to the viewport (segfault fix)

Status: done
Scope: ui
Created: 2026-09-29
Updated: 2026-09-29
Commit: uncommitted
Parent: [README.md](./README.md)

## Finding

`Modal` renders a centered child with a fixed `width` inside an absolute
full-screen scrim. When the terminal is **both narrower than the modal's width and
shorter than its content height**, the centered child receives negative offsets on
both axes and OpenTUI's native buffer write goes out of bounds → **SIGSEGV, the
process dies**.

## Evidence

- `packages/ui/src/widgets.tsx:24-49` — `Modal` is `position="absolute"` +
  `justifyContent="center"`/`alignItems="center"` around `<box width={width}>`;
  no `maxWidth`/`maxHeight`, no scroll container.
- Call sites with fixed widths: help `width={72}` and ~24 content rows
  (`app.tsx:117`), confirm `width={52}` (`app.tsx:170`), scan error `width={60}`
  (`app.tsx:459`).

### Reproduction matrix (bare `<Modal>`, 72 wide × ~24 tall)

| terminal                          | result       |
| --------------------------------- | ------------ |
| 44x14, 60x14, 44x16, 44x18, 60x18 | **segfault** |
| 80x14, 100x8 (wide enough)        | ok           |
| 40x24, 30x30, 20x50 (tall enough) | ok           |

Crash requires overflow on **both** axes; single-axis overflow renders degraded
but alive (e.g. confirm modal at 44x16 loses its borders but doesn't die).

Help (`?`) is the most exposed modal: 72x~24 means any split-pane terminal below
~74 cols and ~26 rows (extremely common: tmux pane, laptop half-screen) crashes on
the most harmless keypress in the app.

## Fix sketch

1. `Modal` reads `useTerminalDimensions()` and clamps:
   `width = Math.min(requested, dimensions.width - 2)` (keep ≥ 20 floor so a
   clipped terminal still shows _something_) and wraps children in a bounded box:
   `maxHeight = dimensions.height - 2` with `overflow="hidden"` (or a scrollbox
   for help).
2. Help overlay should additionally shrink gracefully: under ~80 cols drop the
   two-column `padEnd(20)` layout to single column; under ~24 rows show a compact
   essential-keys subset instead of the full list.
3. Optionally report the negative-offset crash upstream to OpenTUI — the library
   should clamp rather than segfault — but the app-side clamp is the fix that
   ships.

## Tests

- `app.test.tsx`: render at 44x14 and 30x10, press `?`, assert the process is
  alive and the frame contains the help title (previously: segfault).
- Same for the confirm modal at 44x10 and the scan-error modal at 50x8.
- Add a narrow-terminal smoke matrix (widths {30, 44, 60} × heights {8, 14, 20})
  asserting no crash for each of the three modals.

## Edge cases

- Terminal resized _while a modal is open_: `useTerminalDimensions` re-renders,
  the clamp follows — verify no crash crossing the threshold in both directions.
- Modal smaller than content: height-clamp must not produce zero/negative inner
  height for children (minHeight guard on the inner box too).
- `overlayBackdrop` scrim still covers the full screen under the clamp.

## Risk

Low — presentation-only; no state changes. The only product decision is how the
help modal degrades (truncate vs. scroll); truncation is simpler and adequate.

## Effort

S — one component change plus call-site cleanups and the test matrix.
