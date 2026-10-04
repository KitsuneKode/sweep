---
"@kitsunekode/sweep": patch
---

Pause JS traversal and the native scan pipe for slow JSON consumers. Bound output
buffers and drain waits, release stream listeners, and fix Bun stdout handling
that could truncate NDJSON while reporting success. Flush JSON dry-run and empty
selection responses before exiting.

Share broken-pipe handling between npm and standalone entrypoints. A broken
output sink during apply cancels new work while outcomes and history finish;
closed structured-output consumers receive a failure exit status.
