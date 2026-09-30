# @kitsunekode/sweep

## 0.4.0

### Minor Changes

- b39b06b: Triage by age, in the TUI and in the plan format.
  - Scan results now carry `modifiedMs`, the artifact's own last-modified time (optional in the plan schema, produced by both the JS and Rust engines). The list shows an Age column and a size bar, `o` cycles size, name and age (stalest first), and the cursor row says how long ago it changed. Anything touched in the last week is tinted as probably in use.
  - The scope sidebar gains a risk breakdown and an "untouched 30d+" total, and its meter now reads "queued of found".
  - Filter operators in `/`: `kind:target`, `risk:caution`, `path:crate`, `>100MB`, `<1GB`, `older:30d`, `newer:7d`, `is:queued`, `is:symlink`, and `!` to negate. Bare words still match as substrings, and every term must match.
  - New keys: `v` queues a range of rows (never dangerous or blocked ones), `y` copies the row's path (OSC 52), `S` saves the queue as a plan file for `sweep apply --plan`, and `t` in the confirm dialog switches between deleting and moving to trash.
  - Partly queued groups read "1 of 3 queued". Caution is now amber instead of an olive that was hard to tell from safe, dim text meets 4.5:1 contrast in both themes, the help screen wraps instead of clipping, and the panes no longer waste a row or a column.

- d89cd74: Overhaul the interactive TUI and harden scanning:
  - The artifact list is windowed, so navigation and rendering stay fast on
    repositories with thousands of candidates; the mouse wheel moves the cursor
    instead of a detached viewport, and scrollbars are passive indicators.
  - Every apply now opens a confirmation step — safe queues get a standard
    dialog, dangerous selections get the red confirmation.
  - Streaming scans seed `selectedByDefault` candidates immediately and preserve
    manual toggles; the final enriched plan is reconciled on completion.
  - `scan --json` and `scan_completed` events now report `skippedDirs` when
    directories could not be read; human output surfaces the same count in scan
    summaries, grouped plans, and `doctor`.
  - Traversal is safer: device/inode cycle detection defeats bind-mount loops,
    unreadable roots fail loudly while nested unreadable directories are counted
    and reported, and `.GIT`-style VCS dirs are blocked case-insensitively.
  - Group headers always render so rows can't drift under the wrong scope,
    narrow terminals shed chrome instead of truncating mid-word, modals clamp
    to the viewport instead of crashing, and dead keys explain why they no-oped.

- 8960f0d: Add `--trash` (reversible cleanup: candidates move to `.sweep-trash-<ts>/` inside the target instead of being deleted — atomic renames, original paths preserved, trash dirs auto-ignored by future scans), `sweep stats` (cleanup history + lifetime reclaimed total, JSONL at `~/.config/sweep/history.jsonl`, `SWEEP_CONFIG_DIR` to override), `sweep inspect --plan` (read-only plan provenance: counts, kinds, risk tiers, selected bytes), `sweep completions` for bash/zsh/fish, and a `curl | sh` installer script for standalone binaries (now including linux-arm64). Also: `clean --json` no longer mixes scan display text into stdout.

### Patch Changes

- 89da7e8: Harden the destructive and config paths: trash moves now verify the real destination stays inside the real trash dir (a preexisting symlink in the layout can no longer redirect a rename outside), `.sweeprc` must be a bounded regular file (a FIFO no longer hangs the scan, oversized configs are rejected), pattern strings and merged lists are length-bounded so a hostile repo config cannot burn scan CPU, `du` invocation uses `--` so dash-leading paths cannot be parsed as options on either engine, and the Rust engine subprocess output is byte-capped. Release binaries now ship `.sha256` sidecars and `install.sh` verifies the checksum before running.

## 0.3.1

### Patch Changes

- 3adabd3: Fix an uninstallable package. 0.3.0 shipped with Bun's `workspace:` and
  `catalog:` dependency protocols left unresolved in the published manifest, so
  every `npm install @kitsunekode/sweep` failed with `EUNSUPPORTEDPROTOCOL` and
  `bun install` failed to resolve the workspace dependencies.

  `bun publish` rewrites those protocols while packing, but `npm publish` — which
  `changeset publish` shells out to — ships the literal strings. The pack step now
  resolves `catalog:` entries against the root catalog and drops the internal
  `workspace:` packages, which are private, never published, and already inside
  the bundle. A guard fails the pack if any unresolvable specifier survives, and
  the original manifest is restored afterwards.

## 0.3.0

### Minor Changes

- 7081664: Streaming TUI with live Rust scan progress, safer default selection, and ignore-glob / abort fixes.

  The interactive review boots immediately and fills as the walk runs. Rust scans emit matches during traversal (`scan_progress` for dirs walked and items found), not after the walk finishes.

  Selection is safe by default: `a` queues safe+caution, `s` queues safe only, and the confirm dialog appears only when queued items are dangerous. Search Esc clears the filter. `g` goes to the top of the list; Shift+g goes to the bottom.

  Ignore globs like `*.cache` work, and ignore/pattern matching is case-insensitive on macOS and Windows. Scan abort cancels in-flight `du`. Nested apply no longer double-deletes. Windows junctions are treated as symlinks.

  `sweep doctor` dry-scans and treats a missing `.sweeprc` as defaults rather than a warning.

### Patch Changes

- 8a80458: Fix a confirmation dialog that could under-report how much `sweep ui` deletes.

  Queue totals were counted over the filtered view while apply acted on the whole
  queue. Queuing artifacts and then narrowing the scope or the filter made the
  confirmation offer to delete fewer items, and fewer bytes, than it actually
  removed: queue three artifacts, narrow to one, and it read "1 item · 1000 bytes"
  before deleting all three. The header, tally, and confirm dialog now count every
  queued artifact, matching apply exactly, and the header names how much of the
  queue the current view hides. Pressing `enter` also no longer does nothing when
  the whole queue is filtered out of sight. The `--max-size` guardrail reads the
  plan directly and was never affected.

  Fix rows losing their identity during a live scan. Artifact and scope rows
  carried ids derived from their position in the list. OpenTUI keys a parent's
  children by renderable id, so those ids went stale whenever a sized batch
  re-sorted a running scan: rows were dropped, drawn out of order, and the cursor
  highlight landed on a row that was never placed. Rows now carry stable identity.

  Fix `Ctrl+C` leaving `sweep ui` unquittable. The terminal runs in raw mode, so
  no SIGINT is delivered and quitting depends on the keymap — but the filter
  input, help overlay, confirm dialog, and scan-error dialog each swallowed the
  key, leaving the process to be killed from another shell. Quit is now checked
  before every other binding, with a stdin-level fallback that works even if the
  render tree is wedged.

  Stop the list re-sorting under the cursor mid-scan. Sizes arrive after
  discovery, so results are held in the order they are found while a scan runs and
  sorted once when it finishes. If the cursor was never moved it lands on the
  largest artifact; if it was, that artifact is kept across the re-sort.

  Improve navigation and readability. The cursor steps between artifacts instead
  of stopping on group headings, the viewport scrolls only far enough to keep the
  cursor in view rather than recentering on every keystroke, scopes render as a
  folder tree that opens to the active scope, and the cursor, active scope, and
  ancestor rows are now visually distinct. Scanning shows a dot-matrix loader, and
  the statusline key hints follow the active pane and dialog.

## 0.2.0

### Minor Changes

- Trust-first cleanup improvements, engine parity coverage, and a redesigned interactive UI.

  **Trust & CLI**
  - Restore grouped scan summary and delete confirmation on `sweep` / `clean`
  - Default scan engine to `js`; Rust honors `.sweeprc` and CLI scan flags when `--engine rust` or `auto`
  - Fix `sweep ui` plan handoff, config parse exit codes, and `doctor` non-zero on warnings

  **Interactive UI**
  - Group artifacts by directory scope for monorepo-friendly review
  - Minimal single-line list with a context strip for full paths and match reasons

  **Testing & engines**
  - Colocate package unit tests; keep integration tests under `tests/integration`
  - Add golden engine-contract fixtures with optional JS/Rust parity checks

  **Docs**
  - Add `.docs/testing.md` and refresh README / workspace references

## 0.1.0

### Minor Changes

Initial release.

**Features**

- Recursive artifact cleanup for any project tree (`node_modules`, `dist`, `.next`, `target`, `.turbo`, and 10 more default patterns)
- Monorepo-aware — scans nested packages automatically, no double-counting
- Hard guardrails: blocks `/`, `/home`, `/usr`, home directory, shallow paths, path traversal, and null-byte injection
- Config file support: `.sweeprc` walked up from CWD, merged with `~/.config/sweep/config.json` and CLI flags
- `--dry-run` with exact recursive sizes, `--yes` for CI, `--force-large --yes` for oversized deletes
- TTY-aware output: spinner + colors in terminal, plain prefixed lines in CI/pipes
- Size estimation via batched `du` (single subprocess for all matched paths)
- Symlink-safe: `lstatSync` detection, `unlinkSync` removal — never follows links
- Pattern safety: all patterns (CLI and config file) validated before use
- Single bundled ESM binary, Node 18+ and Bun compatible
