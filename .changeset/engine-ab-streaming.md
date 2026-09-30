---
"@kitsunekode/sweep": minor
---

Live engine switching, scan timing, and streaming progress:

- `E` inside `sweep ui` swaps the scan engine (js ↔ rust) and rescans the same
  tree. The completion notice compares timings once both engines have run
  (`rust 273ms vs js 311ms (1.1× faster)`); the header chip keeps the active
  engine's last duration. `E` is global but never fires while a text field owns
  the keyboard, and switching to Rust fails cleanly when no binary resolves.
- Scan duration is surfaced end to end: the scanning strip shows a live 4Hz
  elapsed readout, `scan_completed` carries `elapsedMs`, and non-interactive
  scan headers print the time alongside the engine.
- `scan_progress` events now carry `currentDir` - the TUI shows the folder
  being walked instead of only counts, in both the empty-state panel and the
  scanning strip.
- Rust scan fast path: with no `onEntry`/`onEntrySized`/`onProgress` hooks the
  engine writes one plan JSON instead of streaming per-candidate NDJSON, and
  `du` size batches now run with bounded parallelism (matching the JS
  `DU_MAX_INFLIGHT`) instead of serially - ~860ms → ~270ms on a 13k-dir tree.
- New `bun run bench` engine A/B harness: interleaved warm runs, median/min/
  max, and a candidate-path-set hash for parity.
- Scrollbar drag now follows OpenTUI's SliderRenderable semantics: thumb grabs
  preserve the grab offset, thumb travel maps over `height - thumbHeight`
  (previously the last rows were unreachable by drag), track presses seek then
  continue as drags, and press `preventDefault` stops a scrub from starting a
  text selection.
