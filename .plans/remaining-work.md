Status: in_progress
Scope: repo
Created: 2026-10-15
Updated: 2026-10-15
Commit: uncommitted

# Remaining work ledger

Single source of truth for open work after checkpoint bfe1eab (9/9 local steps,
8/8 hosted jobs). Older audit plans keep their history and evidence; their open
items are mapped to the IDs below and tracked here. Update this file on every
merge: move an item to "Closed" with its commit SHA, never delete it silently.

Nothing in this ledger has been published. A green checkpoint is a tested
baseline, not 200–600 GiB readiness or full filesystem-race protection.

## Working rules

1. Reproduce first: every defect gets a failing fixture or test, in both engines
   where behavior is shared, before the fix.
2. Risk classification only moves toward caution. Promoting anything to `safe`
   needs a decision-log entry in `.docs/`.
3. Read-only selection diff on real trees (`sweep scan --json`, old vs new
   commit) before merging any classification change. Unexpected additions block.
4. Destructive qualification runs only on generated trees under a dedicated
   qualification mount or VM; harnesses refuse other targets.
5. Apply authority (revalidation, identity, confirmation, journal) changes only
   in its own PR, never bundled with UI or paging work.
6. Protocol and schema changes are additive and versioned.
7. One worktree and PR per gate; each checkpoint passes `check`, `rust:check`,
   `verify` and exact-SHA hosted CI.

## Order

| Phase | IDs            | Why here                                                        |
| ----- | -------------- | --------------------------------------------------------------- |
| 0     | S1, S2, S3     | Reproduced harm; contained; shifts candidate sets before paging |
| 1     | G2a            | Baseline measurements so later phases prove an effect           |
| 2     | G1             | Main architecture bottleneck                                    |
| 3     | G2b            | Scale and cancellation on the paged path                        |
| 4     | G4, G5         | Limits informed by phase 3 measurements                         |
| 5     | G3             | Independent; may run alongside phases 3–4                       |
| 6     | G6, G7, G8, G9 | Accumulation, diagnostics, usability, fixtures, release closure |
| 7     | L1–L4          | Only after the foundations                                      |

## Phase 0: reproduced safety defects

### S1 — `safe` requires context, not just a name

Reproduced 2026-10-15 on bfe1eab, both engines identical: `sweep -y` deleted a
regular file named `target` and an authored `notes/target/chapter1.md`.
Read-only scans pre-selected `~/.local/share/icons/*/cursors/target` (an
Xcursor file), `~/.bun/install/global/node_modules`,
`/usr/share/cursor/resources/app/node_modules` and editor runtimes under
`~/.local/share`. Cause: `inferRiskTier` (`packages/core/src/planner.ts`) and
its Rust twin classify by catalog name only.

Implemented (`packages/core/src/classification.ts`,
`crates/sweep-engine/src/classify.rs`); each failure is `dangerous`, never
pre-selected, with one added reason:

- `entry-type-mismatch`: catalog entries declare their entry type
  (directories for `target`, `node_modules`, `.next` and peers; files for
  `*.tsbuildinfo`).
- `tool-home`: toolchain, package-manager, editor, app-data and system install
  trees (`~/.bun`, `~/.cargo`, `~/.local`, `~/.config`, `~/Library`,
  `AppData` except `AppData/Local/Temp`, `/usr`, `/opt`, `/var/lib`, `*.app`,
  `Program Files`, ...). `/var/www` and macOS `/var/folders` are not listed.
- `no-project-marker`: `target` needs a sibling `Cargo.toml` or a
  `CACHEDIR.TAG` inside. Rust checks once at walk time (`WalkEntry`) so found
  and sized events classify identically.

Evidence: fixture `classification-context` matches identical goldens on both
engines; the six existing goldens are unchanged. `scripts/selection-diff.ts`
against bfe1eab, both engines: `~/.local/share` 51 → 0, `~/.bun` 69 → 0,
`/usr/share` 5 → 0, `~/Projects` 724 → 720 with zero additions (the four
removals are fixture negatives and an unmarked fixture `target`).

Follow-up (not Phase 0): a `node_modules` marker (`package.json`) was dropped
from scope. No reproduced harm needed it once tool homes are excluded, and it
would demote every bare test fixture; revisit with a user-facing review.

### S2 — burst input reaches global shortcuts

Reproduced 3/3: `/node` typed as one write changes sort (`o`) and opens a delete
confirmation (`d`); `/zzqq` quits. Consent held: no burst deleted anything.
Cause: `packages/ui/src/keymap.ts` routes on `state.focus`, which updates on
the next render; modal routing already uses a synchronous ref.

Implemented: key-driven input-mode changes (`focusPanel`, patterns `/` and `a`)
dispatch inside `flushSync` through `commitMutation`, and the switching key calls
`preventDefault` so the newly focused input does not also receive it. A bare
`flushSync()` does not commit default-lane updates from stdin handlers, so
reading fresh state alone was not enough.

Evidence: four app tests send `/node`, `/zzqq`, `/yolo` and `P/target` as one
write; all fail with the fix reverted and pass with it. Real tmux PTY: new build
6/6 correct (word in filter, sort unchanged, no dialog, still running); bfe1eab
control reproduces the quit, sort change and delete dialog.

Follow-up (G9): `readFreshState()` relies on a bare `flushSync()`; audit callers
for the same default-lane assumption.

### S3 — guardrail gaps (conservative half)

`/usr/share` and `~/.bun` pass the target guard and get pre-selected items;
macOS system roots below one segment (`/System/Library`, `/Library/Caches`,
`/private/etc`) pass the depth rule. Phase 0 adds macOS roots to both engines
and relies on S1's tool-home rule. Allowing read-only scans of `~` waits for
L3 (`sweep report`), after per-item protection is proven.

## Gates

| ID  | Gate                                   | Work remaining                                                                                                                                                                                                                                                                                                                                     | Absorbs                                                                                 |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| G1  | Production paging and memory           | Native index owns queries, filtering, ordering, aggregates and ID seek; TUI keeps visible pages and selection as rules plus exceptions, compiled to explicit IDs at review. Cursor continuity, grouped pages, locale ranks, range/filter parity, progressive handover, bounded ingestion peak. Shadow-mode differential tests, flag, then default. | review-navigation steps 2–3; paged-review next work; compact-discovery remaining; R4 #9 |
| G2a | Measurement baseline                   | Per-stage harness (discovery, sizing, transport, UI ingest, first paint/row, complete, preparation, removal), peak RSS, FDs, cancellation settle time; entry-count corpora on loop images; cold/warm; `dm-delay`; local NFS.                                                                                                                       | R3 #2; triage #2; R2 #3                                                                 |
| G2b | Scale qualification                    | Run G2a at allocated 200–600 GiB with millions of entries on the paged path. Allocated (`st_blocks`) bytes alongside apparent; plan-wide hardlink dedupe with bounded tracking.                                                                                                                                                                    | R3 #2; R2 #3                                                                            |
| G3  | Platform destructive boundary          | Handle-relative deletion where available (`openat2` RESOLVE_BENEATH/NO_XDEV, macOS `openat`+`O_NOFOLLOW`, Windows parent-handle `FileDispositionInfoEx` with reparse handling); network/FUSE detection; locked-file reporting; honest residual-risk docs.                                                                                          | R4 #1; R3 #3; triage #1; R2 #1                                                          |
| G4  | Stalls and engine lifecycle            | Progress-aware stall detection with keep-waiting/stop; bounded child shutdown; post-mutation timeout records unknown outcome, never retries or falls back to JS; async availability probes; fatal-render teardown test during apply.                                                                                                               | R4 #7, #8; R3 #4; R2 #4                                                                 |
| G5  | Locks and recovery                     | Overlap detection on canonical roots across config dirs; owner identity by host/boot ID/PID/start time; guided explicit stale takeover; disjoint operations later.                                                                                                                                                                                 | R4 #1; R3 #4; triage #4; R2 #6                                                          |
| G6  | Accumulation and diagnostics           | Journal inventory, retention and prune; abandoned extraction cleanup without touching live assets; doctor checks (journal health, config writability, extraction/noexec, temp space, Bun/Node); history health separate from empty.                                                                                                                | R4 #2, #3, #4; R2 #4, #6                                                                |
| G7  | Usability and accessibility            | Keyboard-only and mouse-only journey to receipt; Largest-first/Queued-only/small-item controls; hidden counts visible. Audit items: 80/100-column truncation, ✓ overloaded for safe and enabled, empty state, partial-scan path list, `match · found` header, plain-letter review key, grouped `scan` output, Bun-free TUI.                        | review-navigation step 4; triage #3 remainder                                           |
| G8  | Release and documentation closure      | Installer/terminal qualification on five targets; dependency advisory pass; installer fault tests; root devDep hygiene; release notes; separate explicit release workflow.                                                                                                                                                                         | triage #5, #6; R2 #7; docs-site; TODO "release/process notes"                           |
| G9  | Policy parity and adversarial fixtures | FIFO/socket, raw-name, hardlink-web, case-fold sibling and extreme-path fixtures; protocol fragmentation; saved-plan loader adversarial coverage; unreadable-root exit parity; unclosed bracketed-paste path.                                                                                                                                      | R4 #5, #6; R3 #5; R2 #5                                                                 |

## After the foundations

| ID  | Item                 | Notes                                                                                                                                      |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| L1  | Trash management     | List/inspect first, then guarded restore with explicit overwrite handling and purge. Trash is not a backup and frees nothing until purged. |
| L2  | Agent convenience    | Bounded `--plan -`, lock waiting, clearer capability diagnostics.                                                                          |
| L3  | `sweep report`       | Read-only category report allowed on `~` and `/`; actions limited to sweep cleanup, owner-tool commands, or information only.              |
| L4  | Cached instant start | Persisted index shown as stale at launch; never applicable until rescanned.                                                                |

## Closed but still unchecked elsewhere

Verified against bfe1eab source on 2026-10-15:

- Committed-frame backpressure and sidebar windowing (triage #3, R2 #3 parts):
  commit receipts in `packages/ui/src/streaming.tsx`; windowed sidebar landed in
  traversal-worktree-retirement.
- Deep deletion (R2 #2): hosted-qualified; evidence in the round-two plan.
- Daily-driver overhaul: umbrella is done in `TODO.md`. Its sub-checklists are
  historical. Verified present: `lint-staged`, Turbo fixture inputs,
  extracted `ReviewPane`, `bench` script. Still open and moved here: root
  devDependencies on internal workspaces (G8) and `app.tsx` size (G1, as part
  of splitting state owners).
