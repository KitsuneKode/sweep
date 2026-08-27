---
"@kitsunekode/sweep": patch
---

Fix interactive review rendering, navigation, and a selection-count mismatch.

The confirm dialog could understate a deletion. Queue counts were measured over
the filtered view while apply acted on the whole queue, so queuing artifacts and
then narrowing the scope offered to delete fewer items than it removed. Queue
totals in the header, tally, and confirm dialog now match apply exactly.

Artifact and scope rows carried ids derived from their position in the list.
OpenTUI keys a parent's children by renderable id, so those ids went stale
whenever a sized batch re-sorted a live scan: rows were dropped, drawn out of
order, and the cursor highlight landed on a row that was never placed. Rows now
carry stable identity.

Ctrl+C is honoured in every mode. In raw mode no SIGINT is delivered, and the
filter input, help overlay, confirm dialog, and scan-error dialog each swallowed
the key, leaving no way to quit. There is also a stdin-level fallback so the
escape works even if the render tree is wedged.

The list no longer re-sorts underneath the cursor mid-scan. Sizes arrive after
discovery, so results are held in discovery order while a scan runs and sorted
once when it finishes.

Navigation and appearance: arrow keys move between artifacts instead of stopping
on group headings, the viewport scrolls only far enough to keep the cursor in
view rather than recentering, scopes render as a folder tree that opens to the
active scope, and cursor, active scope, and ancestor rows are visually distinct.
Scanning shows a dot-matrix loader, and the statusline key hints follow the
active pane and dialog.
