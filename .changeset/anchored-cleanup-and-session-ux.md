---
"@kitsunekode/sweep": patch
---

Anchor native Linux deletion to directory descriptors, refuse nested mount and
bind-mount crossings, bound retained directory handles, and check cancellation
within artifacts. JS checks Linux mount boundaries before recursive operations.
Interrupted directory removal reports possible partial contents removal.

Keep folder focus stable as streamed sizes reorder scopes, navigate to folder
parents with Left, clear the whole queue with `u` from either pane, and unqueue
only visible artifacts with `U`. Release UI caches at session/rescan boundaries,
pace native decoding, and keep startup errors recoverable in the UI.

Omit already-bundled Commander from published dependencies and qualify local
installed CLI/native packages without source workspace dependencies.
