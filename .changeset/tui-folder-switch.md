---
"@kitsunekode/sweep": minor
---

The terminal UI can switch folders without restarting: Ctrl+O fuzzy-finds the
folder above, folders you cleaned before, and projects inside and beside the
current one, or takes a typed path. Each switch runs the same guardrails and
`.sweeprc` lookup as `sweep ui <path>`, and refusals are shown in place.
Backspace steps the folder tree up one level, ncdu-style.
