---
"@kitsunekode/sweep": minor
---

`sweep ui` sits on your terminal instead of covering it: in auto theme it asks
the terminal for its background, takes dark or light from it, keeps the
terminal's own colour and opacity as the canvas, and mixes every tint from it.
Project rows show their size as a bar, so where the space is reads before a
number does. In terminals with kitty graphics (kitty, Ghostty, WezTerm) the bars
and the meter under the answer line are drawn in pixels; elsewhere they are
glyphs. An opened project lists its six largest items and folds the rest, and
the risk column keeps kinds and folders lined up.

Every key hint in the footer can be clicked. On a wide terminal the projects
view shows the cursor's project beside the list: where it lives, its branch,
when it was last worked on, and per kind of artifact what it weighs and what
brings it back (a cache refills itself, `bun install`, `cargo build`). The
confirm shows the disk before and after removal, and a clean removal is
answered with what came back. The full view trades its boxes for quiet rules.

`c` now reviews the queue in both views, since many terminals and tmux send
Ctrl+Enter as a plain Enter; it still always opens the confirm first. With an
open dialog, the calm view's footer names that dialog's keys.
