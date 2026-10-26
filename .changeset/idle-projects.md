---
"@kitsunekode/sweep": minor
---

Sweep now knows when each project was last worked on (git index and reflog,
plus the project's own files; never its build output) and uses it:

- `--idle 30d` (also `2w`, `3m`, `1y`) selects only artifacts in projects
  nobody has touched for that long.
- The scan report shows each project's idle time, warns when the selection
  includes projects worked on today, suggests clearing idle projects first,
  and shows free disk space before and after.
- Plans carry an optional `projectActiveMs` per candidate.
