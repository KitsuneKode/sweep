---
"@kitsunekode/sweep": minor
---

Interactive list polish and engine default:

- `--engine` now defaults to `auto`: the Rust engine runs whenever its binary
  resolves (env override, workspace build, optional platform package, PATH);
  JS remains the fallback. `--trash` still drops to JS with a warning, and
  `isRustEngineAvailable` is memoised so the probe runs once per process.
- Fixed an end-of-list flicker: the sticky group-header slot mounted only
  when pinned, which shrank the viewport, pulled the owning header back into
  view, unpinned the slot, and looped forever. The slot is now reserved
  whenever the list can scroll.
- The scrollbar is interactive: click or drag the track to seek the cursor to
  the corresponding row.
- Rows now clear hover correctly (`onMouseOut`, not the nonexistent
  `onMouseLeave`), and hover-set is suppressed briefly after wheel input so
  repaints sliding under a static pointer do not chase a tint down the list.
- Wheel moves three items per notch with an aggregated-delta cap, and
  keyboard paging keeps two rows of context around the cursor instead of
  hugging the viewport edge.
