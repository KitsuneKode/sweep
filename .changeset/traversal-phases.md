---
"@kitsunekode/sweep": minor
---

Traversal engine hardening and honesty:

- `bytesKnown` is new on scan candidates: `false` means the subtree could not
  be fully read, so `estimatedBytes` is a partial lower bound rather than the
  real figure. TUI rows show a `~` marker and the detail pane calls it out;
  `summary.exact` demotes whenever any candidate's size is unknown, so totals
  are never presented as byte-accurate when they are not.
- Glob matching is now a linear two-pointer `*`/`?` matcher with an exact-set
  fast path on both engines - hostile patterns can no longer trigger regex
  backtracking, and pattern length is capped at 128 chars on every trust
  boundary (JS config load, Rust engine stdin, library entry).
- Rust discovery runs on a bounded depth-first work queue (stealing, cap 8)
  instead of a `par_iter` per directory, and the JS walker uses a single
  shared 16-worker queue with an indexed cursor instead of nested pools per
  directory level - directory concurrency is now actually bounded at scale.
- Rust apply resolves selected candidate ids through a `HashSet` instead of
  `Vec::contains`.
- Hardlinked files count once in apparent mode (GNU `du` semantics); exact
  mode still counts every link, matching the JS `exactSize` contract.
