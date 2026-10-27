---
"@kitsunekode/sweep": minor
---

`sweep ui` opens on a calm projects view: one row per project (git work tree or
manifest folder), grouped into "Idle 30+ days" and "Worked on recently", with a
single line that says how much you can reclaim and how much is idle. No boxes
or column headers; detail opens with Enter. `i` queues idle projects, `b`
switches to the full folder view. Plans now carry an optional `projectRoot` per
candidate, and idle time is measured for the whole project.
