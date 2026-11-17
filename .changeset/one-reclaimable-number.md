---
"@kitsunekode/sweep": patch
---

Projects view: one definition of "reclaimable" everywhere. Rows, section headers and the top line all count safe and caution items; dangerous and blocked bytes are named beside the total ("+8.8 KiB guarded") and never added to it. While a scan runs the total says "~X so far", an incomplete scan says so and offers `r`, and projects sort by what you can reclaim. After a removal the receipt shows the estimate with a "~" next to what the disk actually gained, and says when far less came back (hardlinked installs, another volume).
