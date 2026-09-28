---
"@kitsunekode/sweep": minor
---

Overhaul the interactive TUI and harden scanning:

- The artifact list is windowed, so navigation and rendering stay fast on
  repositories with thousands of candidates; the mouse wheel moves the cursor
  instead of a detached viewport, and scrollbars are passive indicators.
- Every apply now opens a confirmation step — safe queues get a standard
  dialog, dangerous selections get the red confirmation.
- Streaming scans seed `selectedByDefault` candidates immediately and preserve
  manual toggles; the final enriched plan is reconciled on completion.
- `scan --json` and `scan_completed` events now report `skippedDirs` when
  directories could not be read; human output surfaces the same count in scan
  summaries, grouped plans, and `doctor`.
- Traversal is safer: device/inode cycle detection defeats bind-mount loops,
  unreadable roots fail loudly while nested unreadable directories are counted
  and reported, and `.GIT`-style VCS dirs are blocked case-insensitively.
- Group headers always render so rows can't drift under the wrong scope,
  narrow terminals shed chrome instead of truncating mid-word, modals clamp
  to the viewport instead of crashing, and dead keys explain why they no-oped.
