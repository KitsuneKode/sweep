---
"@kitsunekode/sweep": minor
---

`sweep init` now looks before it writes: a read-only scan shows the built-in
artifacts it found and the opt-in names worth a decision, asks about each in a
terminal, and writes only those answers. It no longer writes placeholder
patterns. `--dry-run` prints the file instead of writing it.
