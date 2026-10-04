# Hosted CI and distribution qualification

- Status: in_progress
- Scope: ci, release, safety
- Created: 2026-10-04
- Updated: 2026-10-04
- Commit: uncommitted
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
