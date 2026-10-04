---
"@kitsunekode/sweep": patch
---

Preserve replacements and cancelled candidates before destructive operations,
keep native covered outcomes stable after parent deletion, and allow
cancellation during native size preflight. Prevent invalid filename bytes from
aliasing real Unicode paths and enforce native final-output limits in UTF-8
bytes. Replace nightly-only Windows identity APIs with stable owned handles.
Direct native apply now handles Unix SIGINT/SIGTERM cooperatively and flushes
an interrupted outcome report before exiting.
Trash moves also reject a trash root replaced by a new directory at the same
path before the move.
