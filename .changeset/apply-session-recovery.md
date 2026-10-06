---
"@kitsunekode/sweep": patch
---

Keep queued and single-artifact deletion in the terminal UI with preparation
progress, current-path feedback and cooperative cancellation. Preserve the scan
and queue for known size-limit and lock refusals; retain the rescan gate when an
apply outcome is uncertain.

Strengthen protected-root alias and direct-engine plan checks, share bounded
scan/sizing admission, and expose a low-memory resource profile. Record private
apply intent/outcome journals and actual trash destinations, with read-only
recovery, lock diagnostics and versioned schema export for automation. Fix
transitive build caching, native test coverage gates and terminal-control errors.
