---
"@kitsunekode/sweep": patch
---

Scale scan concurrency to the available CPU allowance on small machines while
retaining bounded pools on larger machines. Discovery and native sizing share
one worker allowance; JavaScript reduces simultaneous metadata operations.
