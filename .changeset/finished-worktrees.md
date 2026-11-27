---
"@kitsunekode/sweep": patch
---

Worktrees read as part of their repository. Plans carry two optional fields for an artifact in a linked git worktree: `worktreeOf` (the repository it belongs to) and `worktreeState` (`merged`, or `upstream_gone` when its remote branch was deleted, as a merged pull request leaves it). In the projects view a worktree row says `app · merged` instead of `app/.worktrees`, and finished worktrees nobody has touched for a day are listed first under "Finished worktrees". It is a hint about which build output you are done with; sweep still removes only build output.
