---
"@kitsunekode/sweep": patch
---

The git-tracked check is about ten times faster on trees with many
repositories: the native engine reads each repository's index directly and in
parallel instead of running `git` once per repository. On a 4,000-candidate
tree the check drops from about 240 ms to 22 ms. Split and sparse indexes, and
installs without the engine, still use the hardened `git ls-files` path.
