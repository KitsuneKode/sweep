---
"@kitsunekode/sweep": patch
---

Worktrees read as part of their repository. Plans carry two optional fields for an artifact in a linked git worktree: `worktreeOf` (the repository it belongs to) and `worktreeState` (`merged` when the worktree is clean and its commits are proven merged into a verified default branch, or `upstream_gone` when its remote tracking branch is missing). In the projects view a worktree row says `app · merged` or `app · Tracking branch missing · check git` instead of `app/.worktrees`. Only proven merged, clean worktrees nobody has touched for a day are listed first under "Finished worktrees"; a missing tracking branch is never treated as finished. It is a hint about which build output you are done with; sweep still removes only build output.
