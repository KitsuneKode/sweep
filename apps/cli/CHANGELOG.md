# @kitsunekode/sweep

## 0.5.3

### Patch Changes

- 648de44: Write `.sweeprc` exclusively with mode `0644` in `sweep init` (with atomic sibling replacement for `--force`, clear refusal without suggesting `--force` for non-regular or other-owner targets, and POSIX fsync on publication), tighten updated `.sweeprc` permissions to `0644` (preserving stricter modes such as `0600`) when saving pattern changes, allow group-writable configs and config directories only when the group matches the user's primary group (supporting `umask 002` while still refusing other-group, world-writable, and other-user entries), and align `sweep doctor` with the same config-file and `config_dir` trust checks.
- a5a1c41: Projects view: when a removal fails (a root-owned `node_modules` from Docker or `sudo npm`, say), the reason now stays on that item's row ("✗ EACCES: permission denied") after the notice is gone, instead of only the first reason flashing in a notice. The item stays queued, and the receipt line says how many were not attempted when a run stops early.
- 36037df: Worktrees read as part of their repository. Plans carry two optional fields for an artifact in a linked git worktree: `worktreeOf` (the canonical repository path it belongs to) and `worktreeState` (`upstream_gone` when its remote tracking branch is missing, or `merged` when the worktree is clean and its own commits are proven merged into a verified default branch). In the projects view a worktree row says `app · merged`, `app · branch missing`, or `app · worktree` instead of `app/.worktrees`, and the details margin shows the full state (**Tracking branch missing · check git** for `upstream_gone`). Only proven merged, clean worktrees nobody has touched for a day are listed first under "Finished worktrees"; a missing tracking branch is evaluated first and is never treated as finished. It is a hint about which build output you are done with; sweep still removes only build output.
- ed10a51: Harden scan target guardrails and tool-home classification across both the JS and Rust engines:

  - Prefix-block deep OS subtrees (`/etc`, `/sys`, `/proc`, `/dev` except `/dev/shm`, `/boot`, `/bin`, `/sbin`, `/lib`, `/lib64`, macOS `/private/etc`, and Windows `<Drive>:\Windows`) as scan targets while keeping `/run`, `/usr`, and `/var` exact-match so `/run/media/...`, `/run/user/<uid>/gvfs`, `/var/www`, and `/usr/local/src` stay usable; normalize Windows `\\?\` verbatim prefixes before lexical checks; add `Windows` to `SYSTEM_TOOL_DIRS` and scope Unix OS roots to non-drive/non-UNC paths so `C:\dev\...` stays cleanable.
  - Expand `HOME_TOOL_DIRS` and `SYSTEM_TOOL_DIRS` to protect additional toolchain, version-manager, conda, editor, agent, package-manager, and app homes (such as `~/.npm-global`, `~/.asdf`, `~/.mise`, `~/go/pkg`, `~/scoop`, `~/.var/app`, `~/snap`, `~/miniconda3`, `~/anaconda3`, `~/.conda`, `~/.vscode-insiders`, `~/.vscode-oss`, `~/.windsurf`, `~/.claude`, `~/.codex` with `~/.codex/worktrees` carved out, `~/.t3/userdata`, `~/Applications`, and `/home/linuxbrew/.linuxbrew`).
  - Surface a non-blocking `cloud-sync` reason and scan notice for candidates under cloud-synced folders (`~/Dropbox`, `~/OneDrive`, `~/OneDrive - <Org>`, `~/Google Drive`, `~/My Drive`, and macOS `~/Library/CloudStorage/*`) without changing their risk tier or default selection.
  - Restrict `.app` bundle detection to macOS folders containing `Contents/Info.plist` so ordinary project directories named `*.app` are no longer misclassified as tool homes.

- 40f2bb2: Projects view: the bar under the total now shows where the reclaimable space is, split by what it costs to get back (cache, install, build), at every terminal width and with a key under it. Once something is queued, its share of each part stays solid and the rest recedes, so one bar shows what is there and what is chosen; it follows the keyboard with no easing. The review dialog says how the queue comes back ("install 5.0 GiB (bun install) · build 3.0 GiB (cargo build)"), and the size bars hold 3:1 contrast in both themes.
- d73ff3f: Projects view: one definition of "reclaimable" everywhere. Rows, section headers and the top line all count safe and caution items; dangerous and blocked bytes are named beside the total ("+8.8 KiB guarded") and never added to it. While a scan runs the total says "~X so far", an incomplete scan says so and offers `r`, and projects sort by what you can reclaim. After a removal the receipt shows the estimate with a "~" next to what the disk actually gained, and says when far less came back (hardlinked installs, another volume).
- 862f3ce: The project panel describes opt-in kinds (`.venv`, `__pycache__`, `.gradle`...) with the catalog's own note ("virtualenv - slow to recreate") instead of "your pattern", which is now said only for a pattern you wrote yourself.
- f228a2b: Projects view: keys now act only on what is on screen. Tab no longer sends focus to the hidden folder sidebar (it used to make Space queue a row you could not see), Esc closes an opened project before anything else, and a risk tier or folder scope carried over from the full view is named beside the total ("dangerous only · esc clears"). After a trash apply the notice says the bytes are still on disk instead of "freed".
- dcbcd55: Projects view: `?` shows its own short key list (the full-view list listed `i` twice with two meanings), narrow terminals drop whole parts instead of cutting a size or a word, and an empty scan says which patterns are opt-in.
- 5da011b: Make npm installs, Node 22.12+ scans, and UI startup safer across Node, Bun, and Windows:

  - Drop end-of-life Node.js 20 and require `engines.node >= 22.12.0` for `@kitsunekode/sweep` (verified with installed-tarball headless smoke across Node 22.12.x, 22.x, 24.x, and 26.x with optional dependencies omitted and raw non-UTF-8 filenames).
  - Move `@opentui/core` to `optionalDependencies`. Bun (`bun add -g @kitsunekode/sweep`, `bunx @kitsunekode/sweep ui`, including `bun install --production`) and Yarn 4 install it automatically. pnpm and Yarn 1 skip linking it on Node older than 26.4 (Yarn 1 prints an engine warning), and npm on Node older than 26.4 leaves `@opentui/core` unmet and may still extract `@opentui/core-<platform>` unless `--omit=optional` is passed. In all of these cases, `sweep` installs and runs CLI commands on Node.js 22.12+.
  - Verify the resolved `@opentui/core` version (following npm prerelease semver rules) and required exports before `sweep ui` loads, reporting the offending path, version, and recovery options (reinstall, `bunx`, or cross-platform standalone binaries) instead of a raw `SyntaxError` when a shared global tree holds an incompatible copy. `sweep doctor` runs the static version and export inspection under Node (and full live-export verification under Bun) and no longer warns about OpenTUI in standalone binaries.
  - Make `git` authoritative for tracked-file protection across both engines: verify each enclosing repository with `git rev-parse --show-toplevel`, list tracked paths once with sanitized `git ls-files -z --cached --full-name` (dropping inherited `GIT_*` overrides and disabling `core.fsmonitor`), and match candidates locally using the repository's `core.ignorecase` and `core.precomposeunicode` (or macOS NFC/NFD) rules while preserving literal backslashes on POSIX. Committed symlinks matching an artifact name are now blocked as `git-tracked`, and candidates containing a `.git` entry at or below them are flagged at least `dangerous` with `contains-git-repository` (never pre-selected, and refused at apply unless explicitly selected one at a time). When `git` is unavailable, the native fallback validates regular files without blocking, enforces `extensions.objectFormat`, and marks unverified or empty-index repository items `dangerous` (`tracked-status-unknown`). Apply refuses with exit code 2 and structured refusal codes `git_tracked`, `tracked_status_unknown`, and `contains_git_repository`.
  - Build the published CLI, UI, and standalone binaries with `NODE_ENV="production"` and the production JSX transform for `@opentui/react` (smaller `sweep-ui.js`, working outer ErrorBoundary in standalone builds, no React development mode), and strip workspace `devDependencies` and monorepo scripts from the published manifest.
  - Search only absolute `PATH` directories when resolving the Rust engine and helper binaries (`node`, `git`, `bun`, `sync`), skipping empty, whitespace-only, `.`, and relative `PATH` segments on every platform and never spawning a bare executable name on lookup miss. Lookup still preserves literal spaces in absolute directory names, skips non-executable POSIX files and Windows `.CMD`/`.BAT` shims ahead of a real `.exe`, applies shell-free `PATHEXT` suffixes to extensionless Windows paths, and reports missing explicitly configured paths instead of silent `not_installed`.
  - Keep the Rust engine probe's failure reason in `sweep doctor` and emit both a stable enumerated `reasonKind` and a human-readable `reason` sentence for warning checks in `sweep doctor --json`. `--engine auto` prints a single stderr note when falling back to JS for any reason other than `not_installed`. When Bun's JS directory reader cannot start `node`, report a missing-runtime error rather than a scan resource limit.
  - Projects view search now hints `older:30d` instead of the nonexistent `idle:30d` key and shows filter advice for malformed queries.
  - Shell completions now scope `--allow-dangerous` to clean/apply and complete `--view` and `--theme` values in bash, zsh, and fish.

- e114243: In the projects view, resting on an item lights its share of the size bar and
  lets the other shares recede, and the matching entry under the bar turns bold.
  It follows the cursor at once (no easing: it moves with every key). Terminals
  without pixel graphics show the receded shares as a lighter line.
- 7d1f51e: `sweep status [path]` says what you could free right now: the total, which
  kinds hold it, the idle projects holding the most, and how many items are
  protected. `--json` emits that as a small summary (a few hundred bytes, not a
  whole plan), for status lines and widgets. Only safe and caution items count
  as space; dangerous and blocked ones are reported separately and never added
  to a size. It is read-only.

## 0.5.2

### Patch Changes

- 533bde3: The projects view can remove things directly: `x` on a project reviews just
  that project's removable items (never dangerous ones), and `x` on an item
  reviews that item; whatever else is queued stays queued. The footer shows `a`
  to queue everything removable and, once something is queued, `c` to review
  and `u` to clear. Review dialogs name what they remove, the help lists the
  keys inside a review (y remove, t trash, esc cancel), and the message after a
  removal says what went and what it freed, leaving out zero counts.

  A first look gets one plain line above the footer (space picks, c shows what
  would go, nothing is deleted until y) until something is queued. The next
  step in the footer is drawn in the accent, and `? keys` always fits.

## 0.5.1

### Patch Changes

- 8be9dd6: 0.5.0 cannot be installed from npm, and its native engines were published
  without the execute bit, so they never ran. Install 0.5.1 instead. The package
  is now published from its packed tarball, so the registry's install metadata
  is exactly the manifest that was checked, and engine binaries are made
  executable and checked before they are published.
- becee24: In terminals with kitty graphics, the full view's size bars, the folder
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

- 4d97a17: The dark and light themes are now Sweep's own solid canvas in every terminal.
  Only auto takes on the terminal's background and transparency; before, a dark
  or light theme on a matching terminal blended into it the same way.

## 0.5.0

The first release since 0.3.0; it carries every change made since then.

### Minor Changes

- fa87aae: `sweep ui` opens on a calm projects view: one row per project (git work tree or
  manifest folder), grouped into "Idle 30+ days" and "Worked on recently", with a
  single line that says how much you can reclaim and how much is idle. No boxes
  or column headers; detail opens with Enter. `i` queues idle projects, `b`
  switches to the full folder view. Plans now carry an optional `projectRoot` per
  candidate, and idle time is measured for the whole project.
- 67ab1ec: Sweep now respects git: a folder holding any tracked or staged file is blocked,
  since build output is never committed. Git is asked once per repository with
  the repository's `core.fsmonitor` disabled, and again just before removal.
  Unattended runs (`--yes`) refuse dangerous items unless `--allow-dangerous` is
  passed, and every dangerous path is printed before it is removed.
- 08a73d6: Sweep now knows when each project was last worked on (git index and reflog,
  plus the project's own files; never its build output) and uses it:

  - `--idle 30d` (also `2w`, `3m`, `1y`) selects only artifacts in projects
    nobody has touched for that long.
  - The scan report shows each project's idle time, warns when the selection
    includes projects worked on today, suggests clearing idle projects first,
    and shows free disk space before and after.
  - Plans carry an optional `projectActiveMs` per candidate.

- cd9b8da: `sweep init` now looks before it writes: a read-only scan shows the built-in
  artifacts it found and the opt-in names worth a decision, asks about each in a
  terminal, and writes only those answers. It no longer writes placeholder
  patterns. `--dry-run` prints the file instead of writing it.
- 8adbbd5: Scan and dry-run output leads with what would be reclaimed, then lists groups
  largest first with paths relative to the folder you scanned. Long groups fold
  into one counted line (`--verbose` lists everything), and items left behind are
  explained: left for you to decide, or blocked. While scanning, a live line shows
  folders walked and items found instead of going quiet after the first match.
- 12da012: `sweep ui` sits on your terminal instead of covering it: in auto theme it asks
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

- c1c2604: Filter by picking, not just typing: press `f` or click Filter to toggle risk,
  kind, size, last-touched and queue facets, each with its own count and size.
  The filter bar now shows the query with how many artifacts and bytes it
  matches, folders with a single artifact take one row, and colour is reserved
  for meaning (orange only for caution, chartreuse only for what is queued).
- 30f1fce: The terminal UI can switch folders without restarting: Ctrl+O fuzzy-finds the
  folder above, folders you cleaned before, and projects inside and beside the
  current one, or takes a typed path. Each switch runs the same guardrails and
  `.sweeprc` lookup as `sweep ui <path>`, and refusals are shown in place.
  Backspace steps the folder tree up one level, ncdu-style.
- 73b0bfb: The terminal UI reads project activity: the Age column is now **Idle** (when
  the owning project was last worked on, not when the artifact was rebuilt), the
  filter's age facets become "Project idle", and the action menu offers "Queue
  safe items in projects idle 30+ days" with its count and size. The folder
  switcher fits narrow terminals and no longer offers protected folders such as
  home. Counts are digit-grouped everywhere.
- 2fe439d: The terminal UI shows last scan's sizes as soon as each folder is found
  (marked `~`), then replaces them with fresh measurements. Sizes come from
  `size-cache.json` in the configuration directory, are only reused for the same
  folder identity, and are never used by the CLI or by any removal.
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

- 80d5acb: The terminal UI opens with a ledger: how much space can be reclaimed, split
  by risk tier, how much is queued, and a rule that fills as you queue. Click a
  tier to filter the list to it. After a cleanup the ledger shows what was freed.
  Sizes now read by magnitude, project folders lead their paths, queue marks are
  rings that fill when queued, folders show their share of space, and buttons are
  filled controls with their shortcut beside them.

### Patch Changes

- f721671: The projects view reads as one compact list on any terminal width: lines stop
  at 104 columns, each section shows its eight largest projects with the rest
  folded into one row, location and kinds sit in aligned quiet columns, and the
  mouse wheel moves the cursor.
- 4b1055d: The git-tracked check is about ten times faster on trees with many
  repositories: the native engine reads each repository's index directly and in
  parallel instead of running `git` once per repository. On a 4,000-candidate
  tree the check drops from about 240 ms to 22 ms. Split and sparse indexes, and
  installs without the engine, still use the hardened `git ls-files` path.
- 4890a36: Pointing sweep at your home folder now says so and suggests a projects folder
  (`sweep ~/Projects`) instead of calling it a system root.
- 3e16eb8: Fix `--json` output being cut short when piped under Bun. Large results (over
  roughly 64 KiB) could be truncated with a successful exit code because the
  final flush trusted an empty write's callback, which Bun completes before
  earlier bytes reach a slow reader. The flush now waits for the data itself.
- 46feb6c: The terminal UI's scan meter no longer runs backwards. It showed sized items
  over found items, and found keeps growing while discovery continues, so the bar
  could reach 100% and drop back to 80%. It now holds its high point within a
  scan; the exact "N of M sized" count beside it is unchanged.
- ba47d86: Project rows name the items that need a look: "! 3 caution" or "✗ 1 dangerous",
  so a risky project is visible before you open it.
- 63760ec: Project files can no longer be cleaned, whatever pattern or flag is used:
  `src`, manifests and lockfiles (`package.json`, `Cargo.toml`, `go.mod`, ...),
  `.env` files and `.sweeprc` classify as blocked, and `apply` re-checks them in
  saved plans. A repository's own `.sweeprc` could previously add patterns for
  them. When nothing is pre-selected, sweep now says what it found and points to
  `sweep ui` for review instead of suggesting blanket flags.
- 47aab94: Folder checkboxes in the terminal UI show three distinct states: an open ring
  (nothing queued), a half disc (some queued) and a full disc (all queued).
  Before, a folder with a single queued item looked fully queued.
- 13765c2: Fix `sweep ui` in the standalone binaries (Homebrew and the install script):
  it refused to start with "requires @opentui/core" although the terminal UI is
  embedded in the binary.
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
- 5da2149: Explain link-only deletion and manual trash restoration in confirmations, name
  the reviewed path in single-item receipts, wrap inspected paths, and preserve
  size columns beside wide filenames in narrow terminals. Closing a terminal
  preserves completed session results and requests cancellation of active removal.

  Apply streamed reason limits to saved plans and native decoding, and stop plan
  validation at its first error to bound malformed-input diagnostics. Validate native
  package format and architecture, guard direct publication with exact-source CI,
  and preserve manifest backups during interrupted packing. Make CLI cleaning work
  across supported shells and operating systems.

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
- bfeae8b: Stop presuming a default artifact name is safe on its name alone. A match is now
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

- daa0a2a: The terminal UI now uses the sweep palette from the website: olive-black
  surfaces with a chartreuse focus, mode chip and queue accent in dark mode, and
  paper surfaces with an olive accent in light mode. Every text colour keeps
  WCAG AA contrast on every surface, and `NO_COLOR` still removes all hue.

  Status-line notices now say what kind of message they are. Completed scans,
  queued items, saved plans and patterns, and clean applies read as success;
  amber is kept for refusals, incomplete scans and anything worth a second look.

- 0987a8e: The terminal UI's "Review queue" button now stands out as the next step once
  something is queued, and stays muted while the queue is empty. The folder
  pane's footer hint drops words to fit narrow panes instead of being cut
  mid-word.
- c82f831: Terminal UI polish: keys in the footer and help card are drawn as keycaps, the
  help card fits its content, group headers use the same size format as their
  rows and drop the count for a single artifact, and the scanning strip no longer
  draws one part over another on narrow panes.
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

0.3.0 cannot be installed from npm: it was published with workspace dependency ranges. Use 0.5.0.

### Minor Changes

- 7081664: Streaming TUI with live Rust scan progress, safer default selection, and ignore-glob / abort fixes.

  The interactive review boots immediately and fills as the walk runs. Rust scans emit matches during traversal (`scan_progress` for dirs walked and items found), not after the walk finishes.

  Selection is safe by default: `a` queues safe+caution, `s` queues safe only, and the confirm dialog appears only when queued items are dangerous. Search Esc clears the filter. `g` goes to the top of the list; Shift+g goes to the bottom.

  Ignore globs like `*.cache` work, and ignore/pattern matching is case-insensitive on macOS and Windows. Scan abort cancels in-flight `du`. Nested apply no longer double-deletes. Windows junctions are treated as symlinks.

  `sweep doctor` dry-scans and treats a missing `.sweeprc` as defaults rather than a warning.

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
