---
"@kitsunekode/sweep": patch
---

Bound aggregate transient sizing memory across concurrent artifacts and return
reservations on completion, failure and cancellation without starving discovery.
Allow x/d in inspect to open the same single-artifact confirmation as the list.

Describe single-artifact cleanup receipts as estimated bytes moved or removed; trash no longer claims space was freed.
