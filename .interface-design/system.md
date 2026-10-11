# Sweep terminal interface

A compact review workspace for developers cleaning project artifacts. Keep the
reviewed path, queue scope and operation outcome readable before adding polish.

The current conventions are owned by
[UX principles](../.docs/ux-principles.md) and
[terminal controls](../docs/users/terminal-ui.md). This file routes design work;
it does not duplicate token values or keyboard tables.

- Use the terminal's fixed-width font and cell-aware layout helpers.
- Use touching bordered panes, one-cell row gaps and a visible cursor rail.
- Keep queue state and risk in separate glyphs. Color supports their meaning.
- Keep charcoal/sage dark mode and neutral light surfaces. Exact semantic colors
  and contrast checks live in [theme.ts](../packages/ui/src/theme.ts) and
  [theme tests](../packages/ui/src/theme.test.ts).
- Wrap inspection paths and reasons. Keep close/delete controls outside scrolling.
- Give narrow headers complete operation modes and values before optional facts.
- Apply keyboard movement instantly. Animate activity only during work, with a
  static alternative and a pause control. Pausing never cancels work.
- Keep confirmation scoped to the reviewed candidate ids. Show a final receipt
  only after the engine accounts for outcomes.

Use the [read-only preview](../packages/ui/benchmarks/review-preview.tsx) to check
Demo, Worst, Empty, One and Huge data in the native renderer. It has no apply
engine. The [testing guide](../.docs/testing.md#read-only-terminal-review-preview)
explains its controls and automated checks.
