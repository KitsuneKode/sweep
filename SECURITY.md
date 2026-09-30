# Security policy

sweep deletes files, so the guardrails around that path are the security
surface: path containment, symlink handling, plan validation, and the apply
step's drift checks.

## Reporting a vulnerability

Please report privately through
[GitHub security advisories](https://github.com/KitsuneKode/sweep/security/advisories/new)
rather than a public issue. Include the sweep version, the OS, and a directory
layout or plan file that reproduces the problem.

Anything that makes sweep delete or move a path outside the scanned target, or
outside what the reviewed plan listed, is treated as urgent.

## Supported versions

Only the latest published `@kitsunekode/sweep` release receives fixes.
