---
"@kitsunekode/sweep": patch
---

Re-verify the native engine's identity before apply. Apply now pins the engine file that passed its checks and refuses, with nothing removed, if that file is different when apply starts. On POSIX, an engine file or directory that other users can modify is no longer run; `--engine auto` falls back to the JS engine with a note.
