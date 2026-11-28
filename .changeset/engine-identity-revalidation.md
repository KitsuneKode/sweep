---
"@kitsunekode/sweep": patch
---

Re-verify the native engine's identity before apply. Apply now pins the engine file that passed its checks and refuses, with nothing removed, if that file is different when apply starts. On POSIX, an engine file or directory that other users can modify is no longer run; `--engine auto` falls back to the JS engine with a note.

The terminal UI's local size cache now loads with the same rules as the view preferences file: the config directory must be private to you, and the file is opened without blocking.

Worktree inspection during scans now runs `git` only from an absolute `PATH` entry, the same lookup the other git checks use.
