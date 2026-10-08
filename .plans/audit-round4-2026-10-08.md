Status: in_progress
Scope: confirmation authority, automation errors, recovery evidence, discovery architecture
Created: 2026-10-08
Updated: 2026-10-08
Commit: 3142081cf2e54ebca6d6ae776c6e062be35dfc6e

# Round-four audit reconciliation

Baseline: `200e1ff97cdef5232760587fb7e51e881c76a606`. The supplied report is a
set of leads, not an exhaustive certification. Work is inline. No release is
published by this pass. User data is never used as a destructive test fixture.

## Implemented in this pass

- Delayed `x` then `y` reproduced an apply before the confirmation committed.
  Single-item authority now lives in a synchronously updated ref; neither time
  nor a stale keymap snapshot can authorize the queue. Missing single items
  show an unavailable-item dialog instead of a queue confirmation. Unarmed trash
  toggles explain why they are waiting.
- Unknown native apply reports and cancellation timeouts now use a typed failure
  (exit 4), with `apply_outcome_unknown`, a non-retryable hint and explicit
  unknown outcome. Read-only scan cancellation still uses exit 1. Guardrail exit
  codes cannot silently alias warning/invalid custom codes.
- Command hooks retain JSON mode for crash handlers. Both uncaught exceptions
  and rejected promises emit the envelope. Unknown-outcome tracking starts when
  the backend may mutate,
  separately from host preflight or claiming final report delivery. A missing
  progress event cannot establish that nothing was removed.
- Resource checks precede trash creation, journaling and backend entry. Their
  typed refusal proves `not_started`, preserves selection and cannot create an
  uncertain recovery journal.
- UI session results distinguish successful work, failed/interrupted work and
  missing reports from quitting without an apply. Explicit trash false survives
  exit-path handoff. The UI byte-ceiling warning reflects its actual behavior.
- Torn journals expose recorded outcomes/trash moves as uncommitted evidence;
  confirmed outcomes remain unknown until the journal commits. Recovery never
  retries, restores, purges or releases locks.
- Missing files, symlink loops and non-directory components retain useful errno
  distinctions in target/plan errors. Existing init configuration is a refusal
  (exit 2), not a user cancellation.
- Removed unused `runSweepUi` and its yes-bypass/options surface after a whole-repo
  caller search. The streaming entry remains. Completed grouping reuses the same
  bounded scope-key classifier as live rows.

- Required-native CLI integration tests now fail rather than skip without their
  binary, handle Windows executable spelling, and use the platform temporary
  directory. Removed the unconfigured `SWEEP_ENGINE_FROM_NPM` skip escape.
  A nonempty fixed-mtime file fixture checks absolute bytes, mtime and identity
  from each engine against filesystem ground truth, without golden normalization.

- Linux owned-fixture PTY qualification now uses the built CLI and an explicit
  private config directory, waits for observable completion instead of sleeps,
  and verifies the final success summary/exit while preserving the other queued
  artifact. It is wired into Linux CI.

- A fresh dependency audit found critical shell-quote/tinypool advisories missing
  from the supplied report. Patched lockfile resolutions and a temporary formatter
  override remove those matches. CI checks critical advisories. Two unpatched
  development-tooling advisories remain visible in the full audit; see
  [dependency security](../.docs/tooling.md#dependency-security).
- The separate RustSec pass checks 114 locked dependencies, without target
  filtering or ignored advisories, and reports no vulnerabilities or warnings.
  CI runs pinned cargo-audit 0.22.2 with warning failures. The receipt records
  the fetched advisory database commit, not a permanent safety claim.

## Findings that need qualification or differ from the report

- `buildLiveRows` is already committed. At the baseline, synthetic 50k delivery
  passed at approximately 642 MiB and 100k at 930 MiB. These are same-machine
  observations, not low-memory or real-tree certification. See
  [incremental indexes](incremental-live-indexes-2026-10-08.md).
- The Rust `apply_plan_controlled_with_progress` shim has an actual caller and a
  public re-export. Removing it as zero-caller dead code would be incorrect.
- Native OpenTUI Input has a default 1000-code-unit bound. The report's claim of
  unlimited interactive filter input misses that bound; direct state APIs still
  warrant explicit validation when a new external caller is introduced.
- Conservatively marking incomplete journals unknown is deliberate. The new
  recorded fields make evidence visible without certifying its current truth.
- A passing hosted platform matrix qualifies its actual tests, not macOS/Windows
  mid-delete mounts or every race. Linux mid-delete mounts remain a separate gate.

## Next architecture: compact discovery generations

Use the [pinned fff source review](../.reference/fff-discovery-2026-10-08.md) as
inspiration. Do not replace cleanup policy with git-ignore/frecency semantics.

Prototype a read-only native generation store: compact directory/path tables,
immutable revisioned pages, aggregate counters and an explicit selected-ID set.
The renderer retains only visible pages plus bounded lookahead. Search/sort run
in a bounded CPU pool, filesystem work in its own bounded pool. Limit IPC frames,
queued requests and delta retention; cancel obsolete queries. Generation teardown
must release snapshots, watchers, handles and pending replies. A watcher only
invalidates review; it never adds deletion authority. Apply independently refreshes
identity/containment and produces its existing authoritative outcome partition.

Do not land this as a protocol shortcut. First prove equivalent discovery,
filter/sort/scope behavior against both backends and existing fixtures; test stale
pages, IDs after rename, non-UTF-8 paths, hardlinks, bind aliases, cancellation,
slow consumers and replacement during review. Saved-plan export remains bounded
and explicitly reports incompleteness; page eviction cannot lose selected IDs.

Acceptance experiment: 5k/50k/100k unique-scope fixtures and repeated rescans,
with sampled peak RSS, queue size, open descriptors, first-result/commit latency
and input distributions. Set a measured low-memory target before implementation;
report device/runtime and sample counts, never call sparse samples p99 proof.
Qualify allocated 200–600 GiB fixtures by entry count and shape separately.
Do not increase budgets merely to make a benchmark pass.

## Remaining inventory and execution order

1. Non-Linux destructive boundary qualification; Linux mounts introduced during
   removal; overlapping targets across config dirs/users. Existing locks are
   cooperative, not protection from builds/sync writers.
2. Completed-journal retention and crash-orphaned extraction cleanup. Design
   explicit read-only listing/prune, ownership/pinned handles, retention budget,
   active/incomplete exclusions and interrupted-GC tests before automatic removal.
3. Doctor: journal inventory, config writability, extraction/noexec diagnostics,
   temporary space and selected engine/runtime readiness. Probes must be bounded,
   read-only where possible and honest about what they establish.
4. History health: show unreadable/corrupt/failed persistence separately from
   empty history. A stats failure must never change deletion outcomes.
5. Policy parity inventories for kinds, VCS roots, catalog defaults, risk domains,
   terminal codepoints and direct-native schema bounds. Share TS predicates within
   a language; keep independent cross-language validation and compare behavior.
6. Test quality: further child watchdogs; protocol fragmentation/UTF-8 and
   additional absolute byte/mtime ground-truth shapes;
   FIFO/socket, case-sensitive siblings, hardlink webs and deep path fixtures.
   Dispatch tests and outcome tests serve different purposes; replace vacuous
   assertions, not every small routing mock.
7. Engine stall timeout/diagnostics and async availability probes. A stall while
   mutation is possible must yield unknown outcome, never implicit JS fallback.
8. Fatal-render teardown qualification: inject a component render failure while
   an apply is active and after a trusted report. The React error boundary and
   runtime deadman use a different path from process crash handlers. Prove that
   cancellation drains independently of the view and a crashed view cannot turn
   unknown work into an ordinary abort. A session supervisor outside React should
   own operation/result lifetime if that test exposes a gap.
9. Compact discovery paging experiment above, followed by long-session and real
   allocated-tree qualification. Current resource ceilings remain enforced.

## Validation

The confirmation regression failed on baseline and passes with the fix.
Targeted native render, child crash/command hook, session summary, resource,
trash-choice, errno and journal tests cover the implemented changes.
The final required `bun run check` passed all 49 tasks. React Doctor 0.9.17
reports no changed-source issues (its aggregate score is not whole-app clearance).
Rust checks, installed-package smoke, pack preview and standalone smoke passed.
All nine clean-source local ladder steps passed after source commit 3142081,
including release preflight. The subsequent PTY/CI/documentation qualification
commit is checked again before pushing; exact-commit hosted CI follows the push.
Store raw
post-commit receipts under ignored `.scratch/qualification-round4-2026-10-08/`;
link results when available without pretending future gates have passed.

The source and PTY qualification commits are pushed. Exact-head hosted CI for
`511cb25e2f74d0e3b884a26c58c5f3e2272ece39` passed all eight jobs:
[CI receipt](https://github.com/KitsuneKode/sweep/actions/runs/37748807756).
The dependency follow-up repeats local and hosted gates independently.
