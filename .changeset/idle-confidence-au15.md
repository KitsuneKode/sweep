---
"@kitsunekode/sweep": patch
---

Harden project idle detection with activity confidence (owner decision D4):

- Replace the unsorted 256-entry `readdirSync` slice in project and git root discovery with direct marker probes (`lstatSync`), and stop `projectRoot()` and `gitActivity()` at `$HOME` so home-directory manifests or dotfiles repos are never adopted as a project root.
- Inspect nested non-generated source files with a bounded breadth-first walk (depth, directory, entry, and 100 ms time caps; directories are iterated so caps stop reading early) so in-place edits inside `src/` keep a project active instead of appearing idle.
- Treat any project whose activity cannot be proven (walk depth, directory, entry, or time limits exceeded, unreadable directory/git metadata, a symlinked directory that is not followed, a future-dated mtime, or no readable signal) as unknown (`projectActiveMs` omitted): displayed as unknown idle (`idle ?` in scan reports, `?` / `No activity found` / `worked on unknown` in the TUI), never treated as idle, and excluded from `--idle` and interactive idle queues.
