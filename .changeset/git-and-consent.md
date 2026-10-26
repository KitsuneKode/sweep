---
"@kitsunekode/sweep": minor
---

Sweep now respects git: a folder holding any tracked or staged file is blocked,
since build output is never committed. Git is asked once per repository with
the repository's `core.fsmonitor` disabled, and again just before removal.
Unattended runs (`--yes`) refuse dangerous items unless `--allow-dangerous` is
passed, and every dangerous path is printed before it is removed.
