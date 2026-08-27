---
"@kitsunekode/sweep": patch
---

Fix a confirmation dialog that could under-report how much `sweep ui` deletes.

Queue totals were counted over the filtered view while apply acted on the whole
queue. Queuing artifacts and then narrowing the scope or the filter made the
confirmation offer to delete fewer items, and fewer bytes, than it actually
removed: queue three artifacts, narrow to one, and it read "1 item · 1000 bytes"
before deleting all three. The header, tally, and confirm dialog now count every
queued artifact, matching apply exactly, and the header names how much of the
queue the current view hides. Pressing `enter` also no longer does nothing when
the whole queue is filtered out of sight. The `--max-size` guardrail reads the
plan directly and was never affected.

Fix rows losing their identity during a live scan. Artifact and scope rows
carried ids derived from their position in the list. OpenTUI keys a parent's
children by renderable id, so those ids went stale whenever a sized batch
re-sorted a running scan: rows were dropped, drawn out of order, and the cursor
highlight landed on a row that was never placed. Rows now carry stable identity.

Fix `Ctrl+C` leaving `sweep ui` unquittable. The terminal runs in raw mode, so
no SIGINT is delivered and quitting depends on the keymap — but the filter
input, help overlay, confirm dialog, and scan-error dialog each swallowed the
key, leaving the process to be killed from another shell. Quit is now checked
before every other binding, with a stdin-level fallback that works even if the
render tree is wedged.

Stop the list re-sorting under the cursor mid-scan. Sizes arrive after
discovery, so results are held in the order they are found while a scan runs and
sorted once when it finishes. If the cursor was never moved it lands on the
largest artifact; if it was, that artifact is kept across the re-sort.

Improve navigation and readability. The cursor steps between artifacts instead
of stopping on group headings, the viewport scrolls only far enough to keep the
cursor in view rather than recentering on every keystroke, scopes render as a
folder tree that opens to the active scope, and the cursor, active scope, and
ancestor rows are now visually distinct. Scanning shows a dot-matrix loader, and
the statusline key hints follow the active pane and dialog.
