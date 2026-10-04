# Hosted CI and distribution qualification

- Status: in_progress
- Scope: ci, release, safety
- Created: 2026-10-04
- Updated: 2026-10-04
- Commit: CI repair checkpoint 529a7b2; follow-up qualification in progress
- Source baseline: e2dd306
- Execution: inline; user authorized push and checking hosted workflows

## Reproduced failures

CI run 37214993513 failed Rust lint and all four platform test jobs. Release run
37214993682 failed action/CLI compatibility. Workflow lint, TypeScript and docs
passed. The earlier cc7dab6 runs show the same original failure classes.

1. Local Rust was 1.94; hosted stable was 1.99, where fetch_update is deprecated.
2. The pin labelled Changesets action v1 was actually v2.1.2, requiring CLI v3;
   the installed CLI is v2.30. Pin official action v1.9.0 for compatibility.
3. Platform Bun tests ran before the native binary existed. Build first, pass
   its exact path to child tests, and require native assertions to execute.
4. Windows valid-plan and stream fixtures used Unix-only canonical spellings.
   Use native temporary paths while retaining rejection of malformed paths.
5. Invalid-byte filename fixtures cannot be created on APFS. Keep raw-byte
   coverage on Linux; deep and ordinary Unicode traversal still run everywhere.
6. Windows refuses directory rename over an empty directory placeholder. Reserve
   an exclusive slot and move into its absent `payload` child. Never remove an
   occupied slot to make a rename succeed. Add platform-independent primitive
   regressions and Windows integration assertions.
7. History test truncated an append-only Windows descriptor; use read/write
   mode for fixture extension, leaving production append behavior unchanged.
8. Fresh runners do not inherit the local npm cache. Request public dependency
   downloads explicitly in CI while retaining the local offline smoke default.
9. Check installed-package npm output with CRLF and actual artifact absence;
   unrelated filesystem errors must not count as successful deletion.
10. Qualify embedded UI loading as well as the native scan in the standalone.
11. Keep Linux mount qualification running when Ubuntu restricts unprivileged
    namespaces, using a private namespace on the disposable runner.
12. Windows Rust golden normalization retained native separators before deriving
    fixture IDs. Normalize only fixture-relative test paths to portable separators;
    preserve Unix literal backslashes and unrelated root-prefix paths.

The non-publishing CLI Binaries run 37217933535 passed all five targets and skipped
release attachment. Release run 37217900642 passed with compatible Changesets.
CI run 37217900461 passed every job except Windows Rust fixture parity; its
normalizer fix is awaiting a new hosted run. These are checkpoint results,
not qualification of the pending CPU-aware resource changes.

## Lower-spec follow-up

- Native discovery and sizing share a CPU-aware worker allowance rather than
  allocating eight sizing workers regardless of a small CPU allowance.
- JS metadata and directory concurrency scale down on small allowances while
  preserving the existing maximum counts and directory-reader handle bounds.
- Sample child processes from all runtime threads, and record affinity/thread
  peaks in the Linux resource harness. Keep logical budgets distinct from RSS.
- Qualify ten rescans on one CPU, 32 descriptors, a sampled 192 MiB watchdog,
  and an allocation-checked 200 GiB sparse fixture. This excludes UI rendering
  and does not establish a hard RAM cap or allocated-200-GB deletion throughput.

Recorded lower-spec evidence: [resource qualification JSON](codebase-audit-2026-10-01/resource-low-spec-2026-10-04.json).

Local checks: `bun run check` passed 676 Bun tests; `bun run rust:check`
passed 95 Rust tests with Rust 1.99.0. Hosted results remain pending for these
fixes; the red source-baseline runs above are not passing qualification.

## Completion gates

- Required local Bun/Rust checks, exact installed packages and standalone smoke.
- Successful hosted CI for Linux x64/ARM64, macOS Intel/ARM64 and Windows x64.
- Non-publishing standalone workflow dispatch on main: build/check artifacts;
  release attachment must remain skipped because this is not a release tag.
- Keep full application and small machine-protocol engine downloads distinct.
- Commit and push fixes; preserve the separate traversal-engine worktree.

Registry publication, version-PR merge and real interactive-device guarantees
remain separate. Passing five supported runners is not testing every device,
terminal emulator, filesystem or CPU instruction set.
