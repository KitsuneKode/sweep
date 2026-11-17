---
"@kitsunekode/sweep": patch
---

Projects view: when a removal fails (a root-owned `node_modules` from Docker or `sudo npm`, say), the reason now stays on that item's row ("✗ EACCES: permission denied") after the notice is gone, instead of only the first reason flashing in a notice. The item stays queued, and the receipt line says how many were not attempted when a run stops early.
