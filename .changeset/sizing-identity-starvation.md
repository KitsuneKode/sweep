---
"@kitsunekode/sweep": patch
---

Fix a sizing race where hardlink dedup reservations could exhaust the shared sizing identity lane and make a concurrent candidate report zero bytes. Directory-cycle and hardlink sizing identities now use separate budget lanes in both engines, and hardlink dedup is capped to a byte share that preserves directory-traversal headroom; exhausting hardlink dedup marks unique bytes partial while directory sizing continues.
