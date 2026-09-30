---
"@kitsunekode/sweep": patch
---

- Shell completions are now generated from the live Commander program instead
  of hand-maintained lists - `plan` no longer offers `--json-stream`,
  `inspect` no longer offers apply-only flags, and `init` gains `--force`.
- The TUI header and `--verbose` scan output now name the scan engine
  (`engine:rust` / `engine:js`) so `--engine auto` is no longer invisible.
- Rust engine now lossy-decodes non-UTF8 filenames like the JS engine; both
  engines count undescendable dirs as skipped instead of diverging.
- `history.jsonl` rotates at 16 MiB (tail half kept, atomic rewrite).
