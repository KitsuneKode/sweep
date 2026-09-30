---
"@kitsunekode/sweep": minor
---

Triage by age, in the TUI and in the plan format.

- Scan results now carry `modifiedMs`, the artifact's own last-modified time (optional in the plan schema, produced by both the JS and Rust engines). The list shows an Age column and a size bar, `o` cycles size, name and age (stalest first), and the cursor row says how long ago it changed. Anything touched in the last week is tinted as probably in use.
- The scope sidebar gains a risk breakdown and an "untouched 30d+" total, and its meter now reads "queued of found".
- Filter operators in `/`: `kind:target`, `risk:caution`, `path:crate`, `>100MB`, `<1GB`, `older:30d`, `newer:7d`, `is:queued`, `is:symlink`, and `!` to negate. Bare words still match as substrings, and every term must match.
- New keys: `v` queues a range of rows (never dangerous or blocked ones), `y` copies the row's path (OSC 52), `S` saves the queue as a plan file for `sweep apply --plan`, and `t` in the confirm dialog switches between deleting and moving to trash.
- Partly queued groups read "1 of 3 queued". Caution is now amber instead of an olive that was hard to tell from safe, dim text meets 4.5:1 contrast in both themes, the help screen wraps instead of clipping, and the panes no longer waste a row or a column.
