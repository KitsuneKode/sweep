---
"@kitsunekode/sweep": patch
---

Stop presuming a default artifact name is safe on its name alone. A match is now
marked dangerous, and never pre-selected, when it is the wrong entry type (such
as a regular file named `target`), sits inside a toolchain, package-manager,
editor or system install tree (such as `~/.bun`, `~/.local` or `/usr`), or is a
`target` folder with neither a `Cargo.toml` beside it nor a `CACHEDIR.TAG`
inside. The reason is shown with the item. Both scan engines agree.

Fast typing and unbracketed pastes into the filter no longer trigger global
shortcuts: keys such as `o`, `d` and `q` that arrive in the same burst as `/`
land as filter text instead of sorting, opening a removal review or quitting.

On macOS, refuse system trees such as `/System/Library` and `/private/etc` as
scan targets, including case variants.
