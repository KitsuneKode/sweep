---
"@kitsunekode/sweep": patch
---

Fix `sweep ui` in the standalone binaries (Homebrew and the install script):
it refused to start with "requires @opentui/core" although the terminal UI is
embedded in the binary.
