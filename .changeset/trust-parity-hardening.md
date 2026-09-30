---
"@kitsunekode/sweep": patch
---

Second-pass trust, parity, and scale hardening:

- `sweep apply --dry-run` now previews deletions instead of silently deleting,
  and every command warns when a flag it does not honor was passed
  (`stats --dry-run`, `doctor --trash`, `ui --json`, `init --yes`,
  apply with scan-shaping flags). `--json` and `--json-stream` are mutually
  exclusive, a missing `--config` file is an error instead of silent defaults,
  and `--depth` no longer shadows config-file values with a sentinel.
- Clearing the queue mid-scan (`u`) now stays cleared for the whole scan
  generation — later discoveries no longer refill a queue the user emptied —
  and apply is refused while a scan is still running. `.sweeprc` writes from
  the pattern pane preserve `maxSizeGB`/`depth`/`ignore` instead of reverting
  them to defaults.
- Plan targets are canonicalized before root-guardrail checks on both engines
  (a symlinked target can no longer walk past the `/` or `$HOME` blocks), VCS
  metadata detection runs on the canonical path and covers `.jj`/`.sl`, nested
  child entries dedupe on normalized absolute paths, each delete re-verifies
  the parent chain, missing paths report `missing`, and interruption is
  counted against the true deduplicated work set.
- The artifact list now memoizes by input tuple instead of state identity, so
  cursor movement and notices no longer trigger a full O(n log n) rebuild of
  filtered/visible rows at large candidate counts.
- Windows engine correctness: reparse points are detected via the
  `FILE_ATTRIBUTE_REPARSE_POINT` attribute instead of a verbatim-path compare
  that classified every directory as a symlink, ignore patterns normalize `\`
  separators like the JS engine, size walks no longer follow junctions,
  `mark_dir` dedupes on `file_index`, and junction removal falls back to
  `remove_dir`. Rust tests now run on the Windows and macOS CI legs, and engine
  failures carry the documented exit-code taxonomy (2/3/4) through the JS
  wrapper instead of flattening to 1.
- The published package's `exports` map now resolves — `dist/sweep-lib.js`
  ships the programmatic `makeProgram`/`VERSION` surface and preflight
  verifies every exports/bin target plus a side-effect-free import.
- TUI polish: `i` on a group header no longer opens an empty inspect modal,
  `q` inside the confirm dialog cancels instead of quitting, the patterns pane
  blocks artifact-scoped keys (`o`, `S`), the pattern cursor clamps after
  removing the last custom entry, and a sidebar focus orphaned by a resize
  reconciles back to the list. The help overlay renders a two-column keycap
  layout that degrades cleanly on narrow terminals, and the statusline tally
  reports the queue's risk composition instead of repeating header bytes.
