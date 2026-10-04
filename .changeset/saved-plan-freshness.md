---
"@kitsunekode/sweep": patch
---

Record exact root and candidate filesystem identities at scan time and preserve
them through streams, saved plans and TUI rescans. Both engines refuse replaced
roots and preserve same-type candidate replacements. Plans without identity
snapshots require a fresh scan before applying; older native engines without
identity enforcement are refused. Keep JS covered receipts stable when parent
removal makes an internal symlink alias stop resolving.
