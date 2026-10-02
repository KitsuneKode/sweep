---
"@kitsunekode/sweep": patch
---

fix(ui): meter shows real sizing progress instead of a pinned 100% bar

The sidebar bar measured queue coverage (selectedBytes / totalBytes), which
sits near 100% under default selection - even mid-scan or after a failed scan.
While scanning it now reports sized candidates against found candidates,
clamped under 100% so a full bar only ever means a finished scan. A failed or
partial scan replaces the bar with an explicit "scan incomplete" state and a
rescan hint instead of holding a stale full bar.

`scan_progress` events on both engines now carry `sizedCount` (protocol
field, optional for older producers). The Rust engine also re-emits progress
as sizing completes after the walk ends, so the meter keeps moving during a
sparse sizing tail instead of freezing until the terminal flush.
