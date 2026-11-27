---
"@kitsunekode/sweep": patch
---

Write `.sweeprc` exclusively with mode `0644` in `sweep init` (with atomic sibling replacement for `--force`), allow group-writable configs and `~/.config/sweep` only when the group matches the user's primary group (supporting `umask 002` while still refusing other-group, world-writable, and other-user entries), and align `sweep doctor` with the same ownership and permission checks.
