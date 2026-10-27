---
"@kitsunekode/sweep": patch
---

In terminals with kitty graphics, the full view's size bars, the folder
sidebar's bars and the removal progress bar are now drawn in pixels, on the
colour painted behind each row. Other terminals keep the block-character bars.
The progress bar eases to each new count, and jumps under reduced motion.

The projects view's details panel opens with a disk map: one bar split by what
bringing each part back costs (cache, install, build), cheapest first, with
the size of each under it.

`sweep ui` asks the terminal for its background before drawing anything, so it
no longer flashes the fallback theme before settling on the terminal's own.
`--theme auto|dark|light` (or `SWEEP_THEME`) sets the theme; `t` still cycles
it and remembers the choice. While a scan runs, its bar glides instead of
showing a percentage it cannot know yet; the count beside it is the progress.
