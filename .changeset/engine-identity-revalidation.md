---
"@kitsunekode/sweep": patch
---

Re-verify the native engine's identity before apply. The first native engine use in a process binds the engine file (real path, metadata and SHA-256); every later scan, tracked check, discovery, doctor or apply call in that process must run that same file, and apply re-reads its bytes before starting. A changed engine is refused with nothing removed. On POSIX, the engine file and its directories must be owned by you or root (or, under `sudo`, by the user in `SUDO_UID`) and must not be group- or world-writable; otherwise `--engine auto` falls back to the JS engine with a note and `--engine rust` refuses, with a message that says to use `--engine js` or reinstall the engine. Homebrew prefixes with group-writable folders fall back to JS until tightened. Script files at the engine path are refused.

The terminal UI's local size cache now loads with the same rules as the view preferences file: the config directory must be private to you, and the file is opened without blocking.

Worktree inspection during scans now runs `git` only from an absolute `PATH` entry, the same lookup the other git checks use.
