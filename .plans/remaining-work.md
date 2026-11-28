Status: in_progress
Scope: repo
Created: 2026-10-15
Updated: 2026-11-28
Commit: uncommitted

# Remaining work ledger

Historical ledger of open work after checkpoint bfe1eab (9/9 local steps,
8/8 hosted jobs). Older audit plans keep their history and evidence; their open
items are mapped to the IDs below and tracked here. Update this file on every
merge: move an item to "Closed" with its commit SHA, never delete it silently.

For 0.6.0 execution order, release gates, issue mapping, rc process, promotion,
and rollback, use [release-0.6.0.md](release-0.6.0.md) as the authoritative
plan. Do not duplicate that sequencing here; update this ledger only with
stable gate status and landed-commit evidence. Several rows below predate the
November 28 audit merges and may be stale until W0-1 reconciles them.

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

Implemented: `DARWIN_SYSTEM_ROOTS` (both engines, macOS only, exact match with
case folding) refuses two-segment system trees as targets. One-segment roots
already fail the depth rule; deeper paths remain scannable and S1 demotes
their contents. Pre-selection from `/usr/share` and `~/.bun` is closed by S1
(selection diff 5 → 0 and 69 → 0). The macOS-only JS and Rust tests are
skipped on Linux; the hosted macOS job is their first execution.

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

| ID  | Item                 | Notes                                                                                                                                                                                                               |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Trash management     | List/inspect first, then guarded restore with explicit overwrite handling and purge. Trash is not a backup and frees nothing until purged.                                                                          |
| L2  | Agent convenience    | Bounded `--plan -`, lock waiting, clearer capability diagnostics.                                                                                                                                                   |
| L3  | `sweep report`       | Read-only category report allowed on `~` and `/`, extended to a read-only whole-disk "where your space goes" report (Phase 7 / `AU28`); actions limited to sweep cleanup, owner-tool commands, or information only. |
| L4  | Cached instant start | Persisted index shown as stale at launch; never applicable until rescanned.                                                                                                                                         |

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

## 2026-11-27 audit ledger

Two independent audits reviewed `a5a1c41` plus the owner's uncommitted worktree
branch: [audit index](audit-2026-11-27/README.md) (full raw audit reports are
kept privately off-repo). Every source finding (`A01`–`A18` and `F01`–`F20`) is
merged into a stable `AU*` ID below and assigned to Phases 0–7. Owner decisions
`D1`–`D10` and private security advisory placeholders live in
[audit-2026-11-27/README.md](audit-2026-11-27/README.md).

### Audit execution phases

| Phase   | Focus                                                                                                                                                                                                                                                                                                                                 | Audit IDs                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Phase 0 | Land worktree WIP with D5 labeling, C-locale git env, branch sanitization, bounded `.git/HEAD` reads, per-scan budget, ledger, and stray-folder cleanup                                                                                                                                                                               | `AU01`, `AU02` (budget)                 |
| Phase 1 | Release 0.5.3 readiness: OpenTUI as `optionalDependency` + startup export/version check, production `NODE_ENV` builds, `prepack` manifest cleanup, bundle-vs-manifest release check, Bun global PTY smoke, `idle:30d` hint, landing/docs copy, engine fallback reasons, dependency advisories, test isolation                         | `AU03`–`AU10`                           |
| Phase 2 | Install reach: `glibc 2.17` floor via `cargo-zigbuild` with ELF gate and old-distro container smoke, `musl` packages, `install.sh` staged probe/`.gz`/retry/`v`-prefix/musl, `install.ps1` + Scoop, Homebrew `.gz` + completions, release reconciliation after npm success, build attestations, remove `flake.nix` `packages.default` | `AU11`–`AU14`                           |
| Phase 3 | Trust and correctness: idle confidence (D4), one reclaimable number (D3), `status` coverage, `--json-stream` final tiers, `apply --plan` prompt, `.sweeprc` writer/permission rules, tool-home list + `.app` rule, hardlink-store bytes                                                                                               | `AU15`–`AU21`, `AU02` (G2a measurement) |
| Phase 4 | Private security fixes (tracked privately; no public exploitation details)                                                                                                                                                                                                                                                            | `AU22`–`AU24`                           |
| Phase 5 | UI consistency and cross-platform polish                                                                                                                                                                                                                                                                                              | `AU25`, `AU26`                          |
| Phase 6 | Clove-inspired redesign (terminal and website) and architecture/test debt                                                                                                                                                                                                                                                             | `AU26`, `AU27`                          |
| Phase 7 | Reach and new features: read-only whole-disk "where your space goes" report (extends `L3`), mise/aqua/AUR/winget, `$schema` support, MCP server, running-process and cloud-sync advisories                                                                                                                                            | `AU28`                                  |

### Merged audit findings (`AU01`–`AU28`)

| ID     | Summary                                                                                                                                                                                                                                                                                                                                                                             | Source IDs                                             | Gate          | Phase                                    | Status                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------- | ---------------------------------------- | ----------------------------------------------------------- |
| `AU01` | Reserve "Finished worktrees" for clean, proven-merged worktrees against a verified base (D5); evaluate `upstream_gone` first (`app · branch missing` on rows, "Tracking branch missing · check git" in details); data-only cleanliness and sanitized git env/args in JS & Rust; canonical `worktreeOf` and reflog path checks; sanitize `facts.branch` and harden `.git/HEAD` reads | Codex `A04`; Antigravity `F06`, `F09` (UI branch/HEAD) | W1            | Phase 0                                  | In review (PR #142; closes on merge)                        |
| `AU02` | Enforce a monotonic per-scan deadline with cancellable async subprocesses on worktree git enrichment so spent budget degrades remaining repos to unknown without spawning git; measure 300-worktree scans (Phase 0) and broader multi-repo corpus under G2a                                                                                                                         | Codex `A12`                                            | G2a / G4 / W1 | Phase 0 (budget + 300-wt), Phase 3 (G2a) | Partial (budget & 300-wt check in PR #142; G2a corpus open) |
| `AU03` | Keep `@opentui/core` as `optionalDependency` (D1) with startup version/export check, bundle-vs-manifest release check, isolated Bun global PTY smoke, and standalone `doctor` fix                                                                                                                                                                                                   | Codex `A01`; Antigravity `F01`, `F02`                  | G8            | Phase 1                                  | Open                                                        |
| `AU04` | Build `sweep-ui.js` and standalone binaries with production `NODE_ENV` (remove React DEV helpers) and stop duplicating `sweep.js` / `sweep-lib.js`                                                                                                                                                                                                                                  | Antigravity `F04`                                      | G8            | Phase 1                                  | Open                                                        |
| `AU05` | Strip `devDependencies` (`workspace:*`, `catalog:`) and monorepo `scripts` in `prepack.ts` and enforce in publish check                                                                                                                                                                                                                                                             | Antigravity `F05`                                      | G8            | Phase 1                                  | Open                                                        |
| `AU06` | Fix `ProjectsView` `idle:30d` placeholder mismatch (alias or align with `older:`) and render `filterAdvice`                                                                                                                                                                                                                                                                         | Antigravity `F10`                                      | G7            | Phase 1                                  | Open                                                        |
| `AU07` | Fix landing/docs copy drift (`npx ... ui .`, inconsistent dry-run arithmetic, stale `apps/cli/README.md`, outdated TUI docs/mockups)                                                                                                                                                                                                                                                | Codex `A15`; Antigravity `F11`                         | G8            | Phase 1                                  | Open                                                        |
| `AU08` | Surface structured native-engine fallback reasons and separate missing runtime capability from scan-budget exhaustion                                                                                                                                                                                                                                                               | Codex `A05` (fallback); Antigravity `F12` (fallback)   | G4 / G8       | Phase 1                                  | Open                                                        |
| `AU09` | Refresh locked transitive dependency advisories (`fast-uri`, `seroval`) and re-verify plan parser, CLI smoke, and docs smoke                                                                                                                                                                                                                                                        | Codex `A18`                                            | G8            | Phase 1                                  | Open                                                        |
| `AU10` | Isolate `config.test.ts` from `TMPDIR` ancestor `.sweeprc` and scope `check-doc-links.ts` to owned docs                                                                                                                                                                                                                                                                             | Codex `A14`, `A17`                                     | G8 / G9       | Phase 1                                  | Open                                                        |
| `AU11` | Target `glibc 2.17` Linux floor via `cargo-zigbuild` with ELF symbol-version gate and old-distro container smoke, plus `musl` packages                                                                                                                                                                                                                                              | Codex `A05` (ABI); Antigravity `F12` (ABI/musl)        | G8            | Phase 2                                  | Open                                                        |
| `AU12` | Probe staged binary before replacement in `install.sh` plus `.gz`, retries, `v`-prefix, musl; add `install.ps1` + Scoop; switch Homebrew formula to `.gz` + shell completions                                                                                                                                                                                                       | Codex `A07`; Antigravity `F12` (installer/Homebrew)    | G8            | Phase 2                                  | Open                                                        |
| `AU13` | Reconcile binary release after npm success, add build provenance attestations, pin Homebrew tap update, broaden `preflight.ts`, and `drainStdout()` in `doctor --json`                                                                                                                                                                                                              | Codex `A11`; Antigravity `F18`                         | G8            | Phase 2                                  | Open                                                        |
| `AU14` | Remove broken `packages.default` from `flake.nix` (D7)                                                                                                                                                                                                                                                                                                                              | Codex prior #6; Antigravity `F12` / prior #6           | G8            | Phase 2                                  | Open                                                        |
| `AU15` | Add activity confidence with bounded nested source checks, direct marker probes instead of unsorted 256-entry `readdirSync` slice, and `$HOME` stop in `projectRoot()` (D4)                                                                                                                                                                                                         | Codex `A02`; Antigravity `F08`                         | —             | Phase 3                                  | Open                                                        |
| `AU16` | Unify "reclaimable" as safe + caution everywhere with guarded shown separately (D3), and keep partial-byte qualifiers across views                                                                                                                                                                                                                                                  | Codex `A10`                                            | G7            | Phase 3                                  | Open                                                        |
| `AU17` | Carry scan/byte coverage, exact idle duration, guarded-only vs empty wording, and worktree parity in `sweep status`                                                                                                                                                                                                                                                                 | Codex `A03`                                            | —             | Phase 3                                  | Open                                                        |
| `AU18` | Align `sweep scan --json-stream` final post-enrichment risk tiers and include target/dangerous summary in `sweep apply --plan` prompt                                                                                                                                                                                                                                               | Antigravity `F13`                                      | —             | Phase 3                                  | Open                                                        |
| `AU19` | Fix `.sweeprc` writer permissions under `umask 002`, align `sweep doctor` ownership checks with runtime loader, and improve `apply-session.ts` config-dir guidance                                                                                                                                                                                                                  | Codex `A06` (mode); Antigravity `F14`                  | G6            | Phase 3                                  | Open                                                        |
| `AU20` | Expand tool-home protections, scope `.app` bundle detection cleanly, respect `--engine js` in `gitTrackedPaths`, and surface `safe.directory` failures                                                                                                                                                                                                                              | Antigravity `F17`                                      | S1            | Phase 3                                  | Open                                                        |
| `AU21` | Surface cross-artifact hardlink/reflink store byte inflation (pnpm/Bun stores) alongside apparent sizes                                                                                                                                                                                                                                                                             | Codex prior #4; Antigravity prior #4                   | G2b           | Phase 3                                  | Open                                                        |
| `AU22` | Subprocess executable resolution hardening (private)                                                                                                                                                                                                                                                                                                                                | —                                                      | Security      | Phase 4                                  | Open (private)                                              |
| `AU23` | Untrusted metadata file handling and root controls (private)                                                                                                                                                                                                                                                                                                                        | —                                                      | Security      | Phase 4                                  | Open (private)                                              |
| `AU24` | Config initialization write atomicity (private)                                                                                                                                                                                                                                                                                                                                     | —                                                      | Security      | Phase 4                                  | Open (private)                                              |
| `AU25` | TUI and cross-platform polish: platform-aware project-relative paths, `homedir()` normalization, Windows junction fail-closed, standalone temp extraction reuse, left-button press-release in `ProjectsView`, key-burst refs, cache teardown, `.unref()` eviction timer, completions/`--help` drift, `/proc/self/mountinfo` caching                                                 | Codex `A16`; Antigravity `F15`, `F16`, `F19`           | G7 / G9       | Phase 5                                  | Open                                                        |
| `AU26` | Landing and docs accessibility/performance: focus restoration in review demo, 320 px path and rule-scope legibility, and compressed initial-load JS budget                                                                                                                                                                                                                          | Codex `A08`, `A09`, `A13`                              | G7 / G8       | Phase 5 / Phase 6                        | Open                                                        |
| `AU27` | Clove-inspired Storage Card and Dot-Grid Canvas redesign across TUI and website (D8), CSS token unification, `app.tsx` decomposition, and `apps/docs` + `scripts/` test coverage                                                                                                                                                                                                    | Codex §4; Antigravity `F20`, §5                        | G1 / G7       | Phase 6                                  | Open                                                        |
| `AU28` | Reach and new features: read-only whole-disk "where your space goes" report extending `L3` (D9), mise/aqua/AUR/winget channels, `.sweeprc` `$schema` + `config.schema.json`, MCP server, running-process and cloud-sync advisories                                                                                                                                                  | Codex §5, prior #8/#10; Antigravity §6, prior #8/#10   | L3 / L2 / G8  | Phase 7                                  | Open                                                        |
