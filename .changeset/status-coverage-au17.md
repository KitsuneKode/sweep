---
"@kitsunekode/sweep": patch
---

Improve `sweep status` and `sweep status --json` coverage and parity:

- Surface scan and sizing completeness (`skippedDirs`, `bytesPartial`, `partialByteCount`, `complete`) in `StatusSummary` and warn clearly in human output (with `~` on partial totals) whenever folders were unreadable or items were partially sized.
- Preserve exact idle thresholds (`idle.windowMs`, `idle.windowLabel`) and per-project elapsed durations (`idleMs`) so sub-day flags like `--idle 12h` render accurately instead of rounding to days.
- Distinguish guarded-only trees from truly empty ones (`protectedBytes` added alongside `protectedCount`; human output reports "Nothing automatically reclaimable here." and lists guarded items instead of claiming "Nothing to free here.").
- Match Projects view worktree semantics (D5): expose `finishedWorktrees` (clean merged worktrees quiet >= 24h, excluded from `idle` to prevent double counting), `branchMissingWorktrees` (`upstream_gone`, never treated as finished), and `worktreeOf`/`worktreeState` on project entries.
