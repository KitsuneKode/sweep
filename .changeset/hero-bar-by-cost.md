---
"@kitsunekode/sweep": patch
---

Projects view: the bar under the total now shows where the reclaimable space is, split by what it costs to get back (cache, install, build), at every terminal width and with a key under it. Once something is queued, its share of each part stays solid and the rest recedes, so one bar shows what is there and what is chosen; it follows the keyboard with no easing. The review dialog says how the queue comes back ("install 5.0 GiB (bun install) · build 3.0 GiB (cargo build)"), and the size bars hold 3:1 contrast in both themes.
