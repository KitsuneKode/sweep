---
"@kitsunekode/sweep": patch
---

feat(cli): `--cold` / `SWEEP_COLD=1` for honest cold-start dev runs

Cold-start timing is the number real users feel and the one dev runs never
see - every measurement after the first rides a warm page cache and a
memoized engine probe. `--cold` (also `SWEEP_COLD=1`) does what cold can
honestly do in-process: the engine-availability probe respawns per
resolution instead of answering from the memo, and `/proc/sys/vm/drop_caches`
is written when the process is root so dentry/inode/page caches drop before
the scan.

When the drop is not permitted the run says so - a `note:` on stderr - so
warm numbers never pose as cold. `bun run bench -- --cold` drops before every
timed run and reports `drops:N/runs` per row. TUI rescans (`r`) honor the env
too, so a session started with `--cold` stays cold.

What it does not fake: JIT/module warmth needs a fresh process (spawn a new
CLI per iteration for that), and page-cache drops need root - anything less
is reported, not relabeled.
