# 04 — Engine parity, guardrails, and edge cases

Status: done
Scope: engine, ui, cli
Created: 2026-09-29
Updated: 2026-09-29
Commit: uncommitted
Parent: [README.md](./README.md)

Landed: 4a (rust-engine stores `candidate_found`), 4b (`finalizeScan`
reconciles the enriched whole plan at scan end), 4c (case-insensitive VCS
guard on darwin/win32), 4d (`skippedDirs` in `ScanResult` + strip; Rust
protocol now emits it on `scan_progress`/`scan_completed`/`ScanPlan.summary`),
4e (dev:ino traversal set on both engines - Rust `walk_dir` dedupes via a
shared `(dev, ino)` set), 4f (`start` typed `Promise<void>`, select
`keyBindings={[]}` sole keymap ownership, pageup/pagedown/home/end + mouse
documented in `?`, dead exports pruned, dead-key notices landed via 03f).
Closed: `pageRows` now uses the measured list viewport height via
`onViewportRows`, `?` glob semantics documented in config.md/README.

Correctness hardening found during the line-level pass over `packages/core`,
`packages/ui`, and `apps/cli`. Ordered by user impact.

## 4a — Rust scan drops never-sized candidates (P1)

`packages/core/src/rust-engine.ts:278-283`: `candidate_found` events go to
`options.onEntry` but are **never inserted into `entriesByPath`** — only
`candidate_updated` adds. Any candidate the engine finds but never sizes
(sizing failure, early exit, engine contract drift) is shown live via `onEntry`
yet absent from the returned `ScanPlan`.

Fix: `entriesByPath.set(entry.path, entry)` on `candidate_found` too;
`candidate_updated` then overwrites with the sized record. One line, plus a
contract test in `rust-engine.test.ts` (or wherever the event stream is mocked)
asserting a `candidate_found` without a matching `candidate_updated` still
appears in the plan.

## 4b — Streaming enrichment is structurally impossible today (P1)

`planner.ts:108-112` `candidateFromEntry` runs `enrichCandidates([single])`.
`markWorkspaceStubs` needs ≥ 2 `node_modules` (`candidate-insights.ts:81-82`),
`markSymlinkAliases` needs sibling directory candidates (`:43-62`). In
streaming mode both are no-ops — `sweep ui` (the only entrypoint) never tags
workspace stubs or symlink aliases.

Consequence today: stubs/aliases arrive with plain tiers; combined with finding
02b (seeded queue), stubs would even be auto-queued — currently masked only by
the empty-queue bug.

Fix: enrich in the streaming pipeline where the whole set is visible —
either in `upsertCandidates` (`store.ts:265-279`) on each flush over the merged
map, or once in `onDone` before `setScanning(false)` (cheaper; one O(n) pass at
scan end). On-done enrichment also makes the fix engine-agnostic. Note: keep
user selection decisions — enrichment should patch `reasons`/`riskTier`/
`selectedByDefault` fields but never mutate `selectedIds`.

Test: `state.test.ts` or streaming-level test with a primary `node_modules` +
a <1MB stub; assert the stub is `caution` and carries `workspace-stub` after
`onDone`.

## 4c — `.GIT` slips past the VCS guard on case-insensitive filesystems (P1/P3)

- `guardrails.ts:238-241` `pathHasProtectedVcsSegment` compares segments
  case-sensitively.
- `scanner.ts:25` `SKIP_DIR_NAMES` is also case-sensitive.
- On macOS/Windows `.GIT` === `.git` on disk; the scan descends into `.GIT`,
  and artifacts inside it are **not** marked `blocked` — deletable through a
  normal apply. `compileMatcher` already handles case-insensitivity correctly
  (`scanner.ts:35-37`); the guardrails should use the same platform rule.

Fix: normalize segment comparison to lowercase when
`process.platform === "darwin" || "win32"` in both places. Test:
`guardrails.test.ts` — `pathHasProtectedVcsSegment("/x/.GIT/objects")` true on
darwin/win32 semantics (expose the case rule as a param so the test is
platform-independent).

## 4d — Unreadable directories vanish silently (P2)

`scanner.ts:402-406` `readdir` failure → `return`; `lstat` failure → `continue`.
A permission-denied subtree produces no signal — totals look complete. For a
trust-first tool, "I skipped 12 dirs I couldn't read" is important output.

Fix: count `skippedDirs` (+ maybe `skippedPaths`) in `ScanResult`; surface in
`ScanCompletedEvent` for Rust parity, print in `sweep scan` output, and add a
dim `· N unreadable` segment to the TUI scanning strip/context line when > 0.

## 4e — Bind-mount / inode cycles (P3)

`scanner.ts` walks directories with no visited-inode set — `mount --bind /a /a/b`
(or similar loop constructs) recurses until `config.depth` bounds it; with
`depth: -1` it runs effectively forever, growing the entries list.

Fix: track `(dev, ino)` pairs of traversed dirs in a `Set` (cheap `lstat` data
already partially available); skip revisits. Test with a symlink-free loop or
mocked inode duplication.

## 4f — Smaller items

- **`UiScanControl.start` lies about asyncness** (`streaming.tsx:28`): typed
  `void`, implemented `async`. Errors are internally funneled to `onError`, so
  this is safe today but the type invites a future caller to treat it as
  synchronous. Type it `Promise<void>` (or document the contract).
- **Dual key ownership in patterns focus** (`keymap.ts:302-313` +
  `<select>`'s own bindings): global handlers run first, then the select's —
  arrows happen to converge to the same index, but `shift+up`/`shift+down`
  diverge (keymap ±1 vs select's ±5 fast-scroll). Give the select sole
  ownership (drop the arrows branch from the keymap) or pass
  `keyBindings={[]}` and own all keys in the keymap. Decide one; remove the
  other.
- **`Tab` silently exits the patterns editor** (`keymap.ts:243` runs before the
  patterns block): focus jumps panes while the editor unmounts — either trap
  tab in patterns or show `tab panes` in the patterns footer. Minor.
- **`pageup`/`pagedown`/`home`/`end` and mouse undocumented**: bound in
  `keymap.ts:165-167,334-344` and rows are mouse-enabled, but `?` help lists
  neither. Add lines (and a "click selects focused row" note).
- **Dead exports**: `buildContextCaption`, `buildHeaderLine`,
  `buildFooterLine` (`presentation.ts:303-378`), `riskMark` (`theme.ts:132-137`),
  `theme` (`theme.ts:139-140`, already `@deprecated`),
  `LegacySweepUiResult` (`app.tsx:500-501`) — nothing imports them; prune.
- **Empty-queue `Enter` and exhausted `esc` are dead keys** — fold into 03f's
  no-feedback list if not handled there.
- **`pageRows` approximation** (`app.tsx:323`): `dimensions.height - 10`
  ignores the scanning strip row — off by one during scans. Harmless; tighten
  by measuring the list viewport if trivially available.
- **Pattern `?` in user patterns is a literal** (`compileMatcher` only expands
  `*` — `scanner.ts:41-46`): document or support `?` glob; today `foo?.d` never
  matches `foo.d` files… wait — `?` is escaped? No — `[.+^${}()|[\]\\]` escape
  set does not include `?`, so `?` lands in the regex as regex-any-char. Minor
  inconsistency: `foo?.d` matches `fooXd` too. Either document glob semantics
  or escape `?`.

## Verification

- `bun run check` (format/lint/typecheck/tests)
- `bun run rust:check` only if `crates/` changes — none of these do.
- New coverage: `rust-engine` event contract test, `guardrails` case-insensitive
  test, `state.test.ts` enrichment-on-done test, scanner skipped-dirs counter
  test.
