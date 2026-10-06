Status: in_progress
Scope: engine, ui, destructive operations, qualification
Created: 2026-10-04
Updated: 2026-10-07
Commit: ba9741a (source checkpoint; release qualification continues)

# Resource and recovery qualification

The user's accepted priorities are the specification: bounded combined memory,
crash/concurrency safety, responsive UI, filesystem failure coverage and release
qualification. Work inline on the authorized main checkout; preserve the dirty
traversal-engine worktree. Commit and push verified changes; do not publish.

## Execution

1. Compare traversal-engine against main. Adopt compatible missing behavior,
   never regress bounded enumeration, identity validation or incomplete gates.
2. Add one discovery/sizing logical byte allowance in both engines and expose
   balanced/low-memory scan profiles to CLI and UI. Keep RSS claims separate.
3. Reduce streaming state allocations; yield to UI consumption with bounded
   batches. Verify stable cursor, selection and stale-generation rejection.
4. Add fail-closed cooperative apply coordination and a private durable intent/
   outcome journal. Recovery is read-only; uncertain operations remain unknown,
   never automatically retried. Record actual trash destinations.
5. Add fault-injection qualification and repeat resource/latency probes. Extend
   diagnostics and documentation. Check dependency advisories without uploading
   private dependency metadata where a local database is available.
6. Review the complete diff, run bun run check and bun run rust:check, build and
   preflight; commit/push, then check hosted CI and repair observed failures.

## Qualification boundaries

Physical consoles, allocated 200 GB storage, network filesystem servers and
older devices require equipment not supplied by this checkout. Add reproducible
qualification commands and report unavailable evidence explicitly. No synthetic
test certifies immunity to OOM, external filesystem races or power loss.

## Progress and decisions

- Baseline: main 1af4d2d, clean. Traversal branch 3e458e8 with five dirty files.
- Worktree review: work stealing, shared sizing pool, bounded progressive batches
  and literal-name matcher are already implemented and hardened on main. Branch
  whole-directory arrays, DP glob allocations and separate 2.11.6 Turbo pin are
  regressions relative to main. Preserve them without importing.
- Ruling: hard cross-platform process RSS enforcement requires OS facilities;
  implement shared logical admission and public profiles, measure combined RSS,
  and document this as bounded admission rather than a hard RSS guarantee.

- Shared logical discovery/sizing admission and public low-memory profiles are
  implemented in JS/Rust; full fresh gates are pending for this diff.
- CLI applies write durable intent/outcome journals and serialize against other
  CLI applies sharing the config directory. Recovery reads receipts without
  retrying uncertain deletion. Core API/direct-native callers are a separate
  trust boundary; the lock is not an external filesystem lock.
- Reproduced same-drain UI confirmation dismissal, duplicate apply, stale trash
  mode and Ctrl-C races. Live refs now guard modal state, trash choice and apply
  ownership. Bulk and single deletion use the in-session pipeline with progress,
  animation, cooperative cancellation and authoritative outcome reconciliation.
- Test renderer Ctrl-C defaults differed from production and freed its native
  buffer before frame capture; lifecycle tests now use production settings.
- Protected canonical/inode root aliases, direct JS apply guards, VCS/proc-task
  roots and published build hashing are implemented and covered by regressions.
- Size-limit and lock refusals preserve a complete UI scan/queue. Native refusal
  events distinguish preflight from unknown mutation; journals record known
  fresh-size refusals as unattempted. Current path validation/sizing is visible
  and JS preflight yields between bounded batches.
- `schema` exports installed protocol schemas. JSON apply/clean fatal errors
  expose stable codes and not_started/unknown outcomes. Doctor and recovery show
  held lock ownership without guessing that PID disappearance authorizes unlock.
- Review inventory and next release work: [supplied audit triage](audit-triage-2026-10-07.md).
- Fresh repository check passed (48 tasks); Rust check passed (8 tasks). Final
  source changes and release-shape verification are checked at commit boundary.
- Warm 100-sample fat/wide engine results and a three-session rendered 50k UI
  probe are recorded in `.docs/benchmarks/`; neither qualifies allocated 600 GiB
  deletion, live UI streaming or physical consoles.
