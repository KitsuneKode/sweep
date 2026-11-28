---
"@kitsunekode/sweep": patch
---

Align `sweep scan --json-stream` final candidate tiers with `sweep scan --json` and enrich `sweep apply --plan` confirmation prompts:

- Reconcile streamed candidates with the post-enrichment plan before emitting `scan_completed`, emitting final `candidate_updated` events carrying git-tracked blocks, tool-home/marker risk tiers, workspace-stub/symlink-alias reasons, project metadata, and worktree state so streamed consumers see the same final tiers as `sweep scan --json`.
- Share the confirmation prompt formatter between `sweep clean` and `sweep apply --plan` so `apply --plan` displays the target directory (including symlink resolution when applicable), item count, estimated size, and live-verified dangerous item count.
