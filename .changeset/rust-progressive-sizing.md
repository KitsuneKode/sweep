---
"@kitsunekode/sweep": patch
---

Rust engine now sizes candidates progressively during the walk instead of in
a post-walk phase, so TUI size columns fill in live like the JS engine. A
bounded channel feeds a sizer thread that dispatches up to 4 concurrent `du`
chunks (or in-process exact sizing), with the same per-candidate fallback
coverage as before.
