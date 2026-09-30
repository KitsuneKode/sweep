---
"@kitsunekode/sweep": patch
---

Harden the destructive and config paths: trash moves now verify the real destination stays inside the real trash dir (a preexisting symlink in the layout can no longer redirect a rename outside), `.sweeprc` must be a bounded regular file (a FIFO no longer hangs the scan, oversized configs are rejected), pattern strings and merged lists are length-bounded so a hostile repo config cannot burn scan CPU, `du` invocation uses `--` so dash-leading paths cannot be parsed as options on either engine, and the Rust engine subprocess output is byte-capped. Release binaries now ship `.sha256` sidecars and `install.sh` verifies the checksum before running.
