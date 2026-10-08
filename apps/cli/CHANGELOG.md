# @kitsunekode/sweep

## 0.4.0

### Minor Changes

- b39b06b: Triage by age, in the TUI and in the plan format.
  - Scan results now carry `modifiedMs`, the artifact's own last-modified time (optional in the plan schema, produced by both the JS and Rust engines). The list shows an Age column and a size bar, `o` cycles size, name and age (stalest first), and the cursor row says how long ago it changed. Anything touched in the last week is tinted as probably in use.
  - The scope sidebar gains a risk breakdown and an "untouched 30d+" total, and its meter now reads "queued of found".
  - Filter operators in `/`: `kind:target`, `risk:caution`, `path:crate`, `>100MB`, `<1GB`, `older:30d`, `newer:7d`, `is:queued`, `is:symlink`, and `!` to negate. Bare words still match as substrings, and every term must match.
  - New keys: `v` queues a range of rows (never dangerous or blocked ones), `y` copies the row's path (OSC 52), `S` saves the queue as a plan file for `sweep apply --plan`, and `t` in the confirm dialog switches between deleting and moving to trash.
  - Partly queued groups read "1 of 3 queued". Caution is now amber instead of an olive that was hard to tell from safe, dim text meets 4.5:1 contrast in both themes, the help screen wraps instead of clipping, and the panes no longer waste a row or a column.

- c90dddc: Live engine switching, scan timing, and streaming progress:
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

- bfdcd96: Make deletion byte ceilings opt-in: the default is now `null`, existing numeric
  caps remain enforced, zero remains a zero-byte cap, and `--max-size-gb` accepts a
  per-run GiB ceiling or `none`. Dry-run previews no longer require destructive
  permission flags. Path, identity, mount and resource guards remain enforced.

  Fix final JSON delivery on slow consumers and late broken-pipe failure reporting,
  route deletion progress to stderr, and add retry guidance to JSON errors. Reject
  unknown native plan/options fields, unsafe protocol integers and untrusted config
  shapes. Freeze native deduplication keys and preserve valid deletion receipt owners.

  Use binary size units, clarify cancellation feedback, improve reader diagnostics
  and allow installed-engine fallback after extraction errors. Update fast-uri,
  crossbeam-epoch and anyhow within their compatible ranges for security advisories.

- d69f485: Rework the pattern catalog around a strict trust boundary and add a real pattern editor to the TUI:
  - Defaults now ship only machine-created, ecosystem-canonical names (`node_modules`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.vite`, `.parcel-cache`, `.nyc_output`, `target`, `*.tsbuildinfo`). Generic names that can hold authored files — `dist`, `build`, `out`, `coverage`, `.venv`, `__pycache__`, `Pods`, `.gradle`, `.dart_tool`, `cmake-build-*`, and more — are still curated in the catalog but ship **opt-in**. The same catalog is mirrored in the Rust engine's `default_patterns()`.
  - Opt-in and custom matches now land in the `dangerous` risk tier on both engines: enabling a pattern consents to _scanning_ for it, never to selecting it — they are never pre-selected and never enter bulk selection. Candidate `reasons` distinguish `default-pattern`, `opt-in-pattern`, and `custom-pattern`.
  - The `p` pane is a grouped, searchable, windowed pattern editor: `/` filters the catalog, `a` adds a custom pattern (validated by the same rules config files use), `d` removes customs (catalog entries can only toggle off), `space`/`enter` toggles, and keystrokes are fully isolated from artifact-list actions.
  - `w` writes the current toggle set to the project `.sweeprc` as a minimal delta (`patterns` + `disabledPatterns` only); an existing file is never clobbered silently — `W` is the deliberate overwrite. The write refuses symlinked paths and uses exclusive temp-file creation + rename.
  - The `?` help overlay is regrouped into move / queue / filter & view / patterns / app sections, and the statusline marks `rescan*` while edited patterns await a rescan.
  - macOS blocked-root checks now fold case on both sides (a `/USERS/name` spelling can no longer walk past the home-directory guard on case-insensitive APFS), and the Rust engine resolves `..` in target paths the same way the JS engine does instead of diverging on it.

- ea8da98: Interactive list polish and engine default:
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

- 66cbb29: feat(ui): delete the row under the cursor without leaving the session

  `x` (or `d`) on a candidate opens the confirmation dialog scoped to that one
  artifact and, on `y`, applies it through the same pipeline as a queued apply -
  plan validation, containment, revalidation, type-flip detection, outcome
  reporting, and history. Deleted and covered rows leave the list in place;
  failed and unattempted rows stay put so they can be retried. `ctrl-c` during an
  apply stops scheduling new work while in-flight deletions finish, and the
  report still lands. Rows that a parent delete covered come along honestly via
  `covered` outcomes.

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
- ed9f37a: Traversal engine hardening and honesty:
  - `bytesKnown` is new on scan candidates: `false` means the subtree could not
    be fully read, so `estimatedBytes` is a partial lower bound rather than the
    real figure. TUI rows show a `~` marker and the detail pane calls it out;
    `summary.exact` demotes whenever any candidate's size is unknown, so totals
    are never presented as byte-accurate when they are not.
  - Glob matching is now a linear two-pointer `*`/`?` matcher with an exact-set
    fast path on both engines - hostile patterns can no longer trigger regex
    backtracking, and pattern length is capped at 128 chars on every trust
    boundary (JS config load, Rust engine stdin, library entry).
  - Rust discovery runs on a bounded depth-first work queue (stealing, cap 8)
    instead of a `par_iter` per directory, and the JS walker uses a single
    shared 16-worker queue with an indexed cursor instead of nested pools per
    directory level - directory concurrency is now actually bounded at scale.
  - Rust apply resolves selected candidate ids through a `HashSet` instead of
    `Vec::contains`.
  - Hardlinked files count once in apparent mode (GNU `du` semantics); exact
    mode still counts every link, matching the JS `exactSize` contract.

### Patch Changes

- e2dd306: Anchor native Linux deletion to directory descriptors, refuse nested mount and
  bind-mount crossings, bound retained directory handles, and check cancellation
  within artifacts. JS checks Linux mount boundaries before recursive operations.
  Interrupted directory removal reports possible partial contents removal.

  Keep folder focus stable as streamed sizes reorder scopes, navigate to folder
  parents with Left, clear the whole queue with `u` from either pane, and unqueue
  only visible artifacts with `U`. Release UI caches at session/rescan boundaries,
  pace native decoding, and keep startup errors recoverable in the UI.

  Omit already-bundled Commander from published dependencies and qualify local
  installed CLI/native packages without source workspace dependencies.

- 7d1a67a: Keep queued and single-artifact deletion in the terminal UI with preparation
  progress, current-path feedback and cooperative cancellation. Preserve the scan
  and queue for known size-limit and lock refusals; retain the rescan gate when an
  apply outcome is uncertain.

  Strengthen protected-root alias and direct-engine plan checks, share bounded
  scan/sizing admission, and expose a low-memory resource profile. Record private
  apply intent/outcome journals and actual trash destinations, with read-only
  recovery, lock diagnostics and versioned schema export for automation. Fix
  transitive build caching, native test coverage gates and terminal-control errors.

- 2f0a069: - Shell completions are now generated from the live Commander program instead
  of hand-maintained lists - `plan` no longer offers `--json-stream`,
  `inspect` no longer offers apply-only flags, and `init` gains `--force`.
  - The TUI header and `--verbose` scan output now name the scan engine
    (`engine:rust` / `engine:js`) so `--engine auto` is no longer invisible.
  - Rust engine now lossy-decodes non-UTF8 filenames like the JS engine; both
    engines count undescendable dirs as skipped instead of diverging.
  - `history.jsonl` rotates at 16 MiB (tail half kept, atomic rewrite).
- ed9f37a: Return explicit cleanup outcomes, drain cooperative Rust cancellation, refresh
  size ceilings before deletion, and show progress at each native removal.
  Cache UI grouping and sidebar structure across selections. Bound history reads,
  rotate whole private logs, label retained estimates honestly, and bound native
  availability probes. Align Unicode globs and per-artifact hard-link accounting
  across engines, and qualify packaged ARM64/Windows engines in release CI.
- f5c2270: Remove Linux's 32-directory deletion depth failure while keeping descriptor use
  bounded. Older traversal frames reopen through the pinned candidate root with
  fresh ancestor identities, symlink restrictions and mount boundaries. Frame
  metadata stays logically bounded, and cancellation remains cooperative.

  Qualify deep owned trees under a 32-descriptor process limit and preserve
  unselected sentinels; add replacement-directory and symlink-swap regressions.

- e2dd306: Pause JS traversal and the native scan pipe for slow JSON consumers. Bound output
  buffers and drain waits, release stream listeners, and fix Bun stdout handling
  that could truncate NDJSON while reporting success. Flush JSON dry-run and empty
  selection responses before exiting.

  Share broken-pipe handling between npm and standalone entrypoints. A broken
  output sink during apply cancels new work while outcomes and history finish;
  closed structured-output consumers receive a failure exit status.

- 762fc15: Clarify queue versus single-item deletion, item counts versus byte coverage,
  and confirmation feedback. Show native Linux removal activity inside large
  artifacts while keeping cancellation and final outcome accounting intact.
  Wait for live scan UI commits and reuse folder topology during sizing updates.
- 09838eb: feat(cli): `--cold` / `SWEEP_COLD=1` for honest cold-start dev runs

  Cold-start timing is the number real users feel and the one dev runs never
  see - every measurement after the first rides a warm page cache and a
  memoized engine probe. `--cold` (also `SWEEP_COLD=1`) does what cold can
  honestly do in-process: the engine-availability probe respawns per
  resolution instead of answering from the memo, and `/proc/sys/vm/drop_caches`
  is written when the process is root so dentry/inode/page caches drop before
  the scan.

  When the drop is not permitted the run says so - a `note:` on stderr - so
  warm numbers never pose as cold. `bun run bench -- --cold` drops before every
  timed run and reports `drops:N/runs` per row. TUI rescans (`r`) honor the env
  too, so a session started with `--cold` stays cold.

  What it does not fake: JIT/module warmth needs a fresh process (spawn a new
  CLI per iteration for that), and page-cache drops need root - anything less
  is reported, not relabeled.

- e2dd306: Add checksummed, streaming gzip standalone archives alongside raw release assets and a 4 MiB JavaScript bundle budget. Document runtime requirements, progressive review, resource limits and measured distribution sizes.
- 3142081: Require a committed confirmation and retain the exact single-item scope across
  input bursts. Report completed TUI sessions and unknown native apply outcomes
  accurately, preserve explicit trash choices, and keep JSON error envelopes on
  unexpected crashes. Refuse oversized plans before journals or trash creation;
  show incomplete journal records as uncommitted recovery evidence.
- a943256: Scale scan concurrency to the available CPU allowance on small machines while
  retaining bounded pools on larger machines. Discovery and native sizing share
  one worker allowance; JavaScript reduces simultaneous metadata operations.
- d521ef7: fix(ui): meter shows real sizing progress instead of a pinned 100% bar

  The sidebar bar measured queue coverage (selectedBytes / totalBytes), which
  sits near 100% under default selection - even mid-scan or after a failed scan.
  While scanning it now reports sized candidates against found candidates,
  clamped under 100% so a full bar only ever means a finished scan. A failed or
  partial scan replaces the bar with an explicit "scan incomplete" state and a
  rescan hint instead of holding a stale full bar.

  `scan_progress` events on both engines now carry `sizedCount` (protocol
  field, optional for older producers). The Rust engine also re-emits progress
  as sizing completes after the walk ends, so the meter keeps moving during a
  sparse sizing tail instead of freezing until the terminal flush.

- 200e1ff: Reuse artifact groups and folder observations across live scan frames, reducing
  allocation churn while preserving immutable earlier frames, selection and cursor
  behavior. Keep literal POSIX backslashes distinct from directory separators in
  scopes and confirmation previews. Avoid redundant hover updates during scans.
- e2dd306: Preserve replacements and cancelled candidates before destructive operations,
  keep native covered outcomes stable after parent deletion, and allow
  cancellation during native size preflight. Prevent invalid filename bytes from
  aliasing real Unicode paths and enforce native final-output limits in UTF-8
  bytes. Replace nightly-only Windows identity APIs with stable owned handles.
  Direct native apply now handles Unix SIGINT/SIGTERM cooperatively and flushes
  an interrupted outcome report before exiting.
  Trash moves also reject a trash root replaced by a new directory at the same
  path before the move.
- 1ed21a6: Update the React devtools shell-quote dependency to its patched release.
- 529a7b2: Fix Windows trash moves using an exclusive destination slot with a `payload`
  entry, preserving existing trash contents. Qualify installed and standalone
  packages on all five supported OS/architecture combinations.
- 12c52b1: Rust engine now sizes candidates progressively during the walk instead of in a
  post-walk phase, so TUI size columns fill in live like the JS engine. A bounded
  channel feeds a fixed pool of in-process sizing workers (`du -sb`-equivalent
  apparent size, or exact file sizes) with the same per-candidate fallback
  coverage as before - no subprocesses are spawned. Stream output is buffered and
  batched (`candidates_found`/`candidates_updated`) on a 16 ms heartbeat, and the
  JS bridge validates stream events structurally so first paint no longer pays a
  schema-compile delay.
- e2dd306: Record exact root and candidate filesystem identities at scan time and preserve
  them through streams, saved plans and TUI rescans. Both engines refuse replaced
  roots and preserve same-type candidate replacements. Plans without identity
  snapshots require a fresh scan before applying; older native engines without
  identity enforcement are refused. Keep JS covered receipts stable when parent
  removal makes an internal symlink alias stop resolving.
- 89da7e8: Harden the destructive and config paths: trash moves now verify the real destination stays inside the real trash dir (a preexisting symlink in the layout can no longer redirect a rename outside), `.sweeprc` must be a bounded regular file (a FIFO no longer hangs the scan, oversized configs are rejected), pattern strings and merged lists are length-bounded so a hostile repo config cannot burn scan CPU, `du` invocation uses `--` so dash-leading paths cannot be parsed as options on either engine, and the Rust engine subprocess output is byte-capped. Release binaries now ship `.sha256` sidecars and `install.sh` verifies the checksum before running.

  Apply now treats plan files as untrusted input on both engines: the plan target itself, dot-segment/case-variant spellings of it, and paths inside VCS metadata (`.git`, `.svn`, `.hg`, `.bzr`) are refused per entry as `protected_path` failures instead of being trusted to the plan's `riskTier`, while legitimate entries still apply and `--json` always emits a report. Confirmation prompts and declines moved to stderr so `--json` stdout stays machine-readable, `sweep init --force` refuses to write through a symlinked `.sweeprc`, symlink candidates report link size rather than target size, `?` is a single-character glob on both engines, and the engine subprocess reads a bounded stdin. Dev runs now resolve the workspace `target/` build before the installed optional engine package, so local Rust changes are what tests actually exercise.

- e2dd306: Bound aggregate transient sizing memory across concurrent artifacts and return
  reservations on completion, failure and cancellation without starving discovery.
  Allow x/d in inspect to open the same single-artifact confirmation as the list.

  Describe single-artifact cleanup receipts as estimated bytes moved or removed; trash no longer claims space was freed.

- fa43e72: fix(scan): stop killing large scans on cumulative sizing budget charges

  Sizing re-walked each candidate's subtree while charging the scan-wide
  admission budgets, so a real project tree with many hardlink-heavy artifacts
  (pnpm stores, shared git object dirs) could exceed `maxIdentities` or
  `maxDirectories` mid-scan and fail outright. Sizing jobs now bound only their
  own transient state: dedup sets cap at `maxIdentities` entries per job and the
  job queue at `maxQueuedDirs`. Reaching a cap degrades honestly - hardlinks
  count again (upper bound) or unsized directories flag `bytesKnown: false`
  (shown as `~`) - instead of aborting the scan. Walk-level cycle protection
  keeps the fatal budget and cannot be starved by sizing.

- 4d5971c: Second-pass trust, parity, and scale hardening:
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

- 9e7169c: Render only the scope sidebar rows that fit the terminal and keep keyboard,
  wheel and scrollbar navigation tied to the visible cursor. Avoid repeated
  subtree searches when drawing tree guides. Restore partial-size markers in
  plain-text progressive scans and clarify the feedback for an incomplete review.

  Keep single-item confirmation compact and show separate preparation/removal
  percentages with cooperative stop controls. Preserve queued selections during
  Ctrl+U navigation and count only enabled patterns. Pin consent/stop controls
  outside scrollable details and support paging long modal contents. Account for retained candidate
  metadata consistently before scan publication and apply, including enrichment
  reasons and Unicode fields. Retry late directory writes a bounded number of
  times during secure native removal, preserving identity and cancellation checks.
  Allow preview release versions through preflight and complete zsh option values.

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
