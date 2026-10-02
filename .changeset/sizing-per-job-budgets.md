---
"@kitsunekode/sweep": patch
---

fix(scan): stop killing large scans on cumulative sizing budget charges

Sizing re-walked each candidate's subtree while charging the scan-wide
admission budgets, so a real project tree with many hardlink-heavy artifacts
(pnpm stores, shared git object dirs) could exceed `maxIdentities` or
`maxDirectories` mid-scan and fail outright. Sizing jobs now bound only their
own transient state: dedup sets cap at `maxIdentities` entries per job and the
job queue at `maxQueuedDirs`. Reaching a cap degrades honestly - hardlinks
count again (upper bound) or unsized directories flag `bytesKnown: false`
(shown as `~`) - instead of aborting the scan. Walk-level cycle protection
keeps the fatal budget and cannot be starved by sizing.
