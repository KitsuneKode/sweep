---
"@kitsunekode/sweep": patch
---

Fix `--json` output being cut short when piped under Bun. Large results (over
roughly 64 KiB) could be truncated with a successful exit code because the
final flush trusted an empty write's callback, which Bun completes before
earlier bytes reach a slow reader. The flush now waits for the data itself.
