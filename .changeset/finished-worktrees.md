---
"@kitsunekode/sweep": patch
---

Worktrees read as part of their repository. Plans carry two optional fields for an artifact in a linked git worktree: `worktreeOf` (the canonical repository path it belongs to) and `worktreeState` (`upstream_gone` when its remote tracking branch is missing, or `merged` when the worktree is clean and its own commits are proven merged into a verified default branch). In the projects view a worktree row says `app · merged`, `app · branch missing`, or `app · worktree` instead of `app/.worktrees`, and the details margin shows the full state (**Tracking branch missing · check git** for `upstream_gone`). Only proven merged, clean worktrees nobody has touched for a day are listed first under "Finished worktrees"; a missing tracking branch is evaluated first and is never treated as finished. It is a hint about which build output you are done with; sweep still removes only build output.
