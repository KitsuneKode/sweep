---
"@kitsunekode/sweep": patch
---

Remove Linux's 32-directory deletion depth failure while keeping descriptor use
bounded. Older traversal frames reopen through the pinned candidate root with
fresh ancestor identities, symlink restrictions and mount boundaries. Frame
metadata stays logically bounded, and cancellation remains cooperative.

Qualify deep owned trees under a 32-descriptor process limit and preserve
unselected sentinels; add replacement-directory and symlink-swap regressions.
