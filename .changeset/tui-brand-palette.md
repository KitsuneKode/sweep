---
"@kitsunekode/sweep": patch
---

The terminal UI now uses the sweep palette from the website: olive-black
surfaces with a chartreuse focus, mode chip and queue accent in dark mode, and
paper surfaces with an olive accent in light mode. Every text colour keeps
WCAG AA contrast on every surface, and `NO_COLOR` still removes all hue.

Status-line notices now say what kind of message they are. Completed scans,
queued items, saved plans and patterns, and clean applies read as success;
amber is kept for refusals, incomplete scans and anything worth a second look.
