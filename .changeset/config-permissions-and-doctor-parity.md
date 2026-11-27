---
"@kitsunekode/sweep": patch
---

Write `.sweeprc` exclusively with mode `0644` in `sweep init` (with atomic sibling replacement for `--force`, clear refusal without suggesting `--force` for non-regular or other-owner targets, and POSIX fsync on publication), tighten updated `.sweeprc` permissions to `0644` (preserving stricter modes such as `0600`) when saving pattern changes, allow group-writable configs and config directories only when the group matches the user's primary group (supporting `umask 002` while still refusing other-group, world-writable, and other-user entries), and align `sweep doctor` with the same config-file and `config_dir` trust checks.
