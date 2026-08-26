---
"@kitsunekode/sweep": minor
---

Streaming TUI with live Rust scan progress, safer default selection, and ignore-glob / abort fixes.

The interactive review boots immediately and fills as the walk runs. Rust scans emit matches during traversal (`scan_progress` for dirs walked and items found), not after the walk finishes.

Selection is safe by default: `a` queues safe+caution, `s` queues safe only, and the confirm dialog appears only when queued items are dangerous. Search Esc clears the filter. `g` goes to the top of the list; Shift+g goes to the bottom.

Ignore globs like `*.cache` work, and ignore/pattern matching is case-insensitive on macOS and Windows. Scan abort cancels in-flight `du`. Nested apply no longer double-deletes. Windows junctions are treated as symlinks.

`sweep doctor` dry-scans and treats a missing `.sweeprc` as defaults rather than a warning.
