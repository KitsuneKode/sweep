---
"@kitsunekode/sweep": patch
---

The terminal UI's scan meter no longer runs backwards. It showed sized items
over found items, and found keeps growing while discovery continues, so the bar
could reach 100% and drop back to 80%. It now holds its high point within a
scan; the exact "N of M sized" count beside it is unchanged.
