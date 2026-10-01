---
"@kitsunekode/sweep": patch
---

Rust engine now sizes candidates progressively during the walk instead of in a
post-walk phase, so TUI size columns fill in live like the JS engine. A bounded
channel feeds a fixed pool of in-process sizing workers (`du -sb`-equivalent
apparent size, or exact file sizes) with the same per-candidate fallback
coverage as before - no subprocesses are spawned. Stream output is buffered and
batched (`candidates_found`/`candidates_updated`) on a 16 ms heartbeat, and the
JS bridge validates stream events structurally so first paint no longer pays a
schema-compile delay.
