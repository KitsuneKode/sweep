# Production qualification and long-session UX

- **Status:** done locally; external qualification remains
- **Scope:** engine, safety, ui, release
- **Created:** 2026-10-04
- **Updated:** 2026-10-04
- **Commit:** included in the user-authorized production-qualification checkpoint

## Execution order

1. Strengthen native Linux deletion with descriptor-relative operations, mount
   crossing refusal, bounded descriptors and cancellation inside artifacts.
   Preserve outside sentinels under ancestor swaps and interior symlinks. Keep
   portable paths explicit; no claim of platform qualification from compilation.
2. Improve folder navigation and selection feedback, retaining confirmed apply
   and incomplete-scan gates. `u` clears the entire queue; visible-only unqueue
   has a distinct gesture. Collapsing a folder selects its parent rather than
   unexpectedly abandoning the tree pane.
3. Bound streaming work per UI frame and qualify repeated scan/cancel sessions,
   slow consumers, low descriptors and retained memory. Preserve all events and
   final state; no silent candidate drops.
4. Exercise installed-package and standalone Linux paths, add portable owned
   fixture smoke coverage, record dependency/release checks possible locally.
5. Review the complete accumulated diff once with one independent reviewer,
   fix actionable findings, run required full gates and commit verified work.

## Acceptance and boundaries

Tests must exercise actual operation paths with owned disposable fixtures.
Large allocated storage, privileged mount creation, real Windows/macOS/ARM64
TTYs, hosted CI, registry writes and publication are distinct external gates.
Do not represent their configuration as successful execution. Commit is
explicitly authorized; push, publish and deploy are not.

## Ledger

- Baseline: main cc7dab6; prior saved-plan gates 663 Bun / 89 Rust tests.
- Ruling: inline implementation with one final reviewer, matching the user's
  request to minimize subagents. Existing traversal worktree is preserved.
- Ruling: standard library recursive-removal protection must not be replaced by
  a pathname walker. Linux hardening must use safe descriptor APIs and fail
  closed when kernel resolution restrictions are unavailable.
- Interfaces: discovery identities -> saved plans -> apply -> UI receipts;
  stream batching -> final scan consistency -> selection gating.
- UI gestures and folder anchoring: four reproduced failures now pass. `u`
  works in list/sidebar and suppresses subsequent defaults; `U` unqueues only
  currently visible artifacts. Left navigates to a visible folder parent.
- Cooperative decoder: bounded 128-line / 4ms slices yield with paused input;
  close waits for the final slice. Ordered-slice regression passed.
- Linux remover: safe rustix openat2/unlinkat/Dir APIs, NO_XDEV/NO_SYMLINKS/
  BENEATH on relative opens, 32 retained directory frames, RAII descriptors,
  cancellation inside each artifact. Unsupported kernel support fails closed.
- Ruling: cancellation inside one already-started directory may produce one
  failed (possibly partial) candidate plus unattempted candidates. The previous
  signal test's zero-failures assumption only held for between-artifact polling;
  update it to assert truthful partitions and agreement with disk.
- Session cleanup releases strong row/tree/summary/path caches on rescan and
  teardown; weak candidate indexes do not own their candidate arrays.
- Actual private Linux namespace bind-mount CLI scan/save/apply checks passed
  for Rust and JS, both exit 4 with one failure and preserved outside sentinel.
- Actual local CLI/native npm tarballs installed offline; installed JS/Rust
  scan/save/apply passed without an engine path override. Package smoke restores
  source manifests and needs no registry writes. Bundled Commander is removed
  from the published dependencies, retaining it in source build dependencies.
- 400 refreshed apply runs passed. Anchored Rust deletion p99: 19.14ms (64
  small artifacts), 139.22ms (20k-file artifact); JS mount preflight p99:
  63.93ms / 401.78ms. Hardening adds work; preserve earlier hash-bound results.
- Final independent review found two confirmed transport defects, both reproduced
  before the fix: Node's exit-time stdout resume overlapped async decoders (P1),
  and a drain before an eventual wait produced a false timeout (P2). One fix pass
  serializes all chunk work and observes drains throughout the writer lifetime.
  Both regressions and their focused suites pass (14 tests).
- Thirty synthetic 10k-candidate UI sessions released strong caches without
  forced GC; 10 repeated scan resource checks passed with a 64-FD limit, including
  large sparse counters. These bounded observations are not leak proofs or
  allocated-200-GB deletion qualification.
- Final required gates passed: `bun run check` (674 tests / 48 tasks),
  `bun run rust:check` (95 tests / 8 tasks), Linux all-target clippy and Windows
  cross-clippy. The verification ladder also passed installed tarball, package
  preview and standalone empty-PATH/UI-probe smoke checks. Its preflight step
  refused only the uncommitted apps/packages state; rerun that after checkpoint.
- Actual terminal inspect/confirm deleted only the viewed artifact and preserved
  the other queued artifact. Broken apply output interrupted JS and Rust,
  preserved remaining artifacts and persisted history matching disk.
- Final scan evidence uses 100 samples per engine/exactness/shape after the
  transport fix. Exact p99: Rust 30.69/6.60/23.12ms versus JS
  386.03/225.18/166.56ms for wide/grouped/flat fixtures. No other benchmark or
  native build was running during this refreshed scan comparison.
- Full changed-source lint: 79 files, zero warnings/errors. Changed-file
  credential-pattern scan and `git diff --check` passed. YAML syntax parsed for
  all four workflows; hosted workflow lint/execution remain external evidence.

Detailed local evidence: [production qualification JSON](codebase-audit-2026-10-01/production-qualification-evidence.json).

## Next qualification work

1. Run the installed-package and interactive-console matrix on actual Windows,
   Intel/ARM macOS and Linux ARM64; qualify user-namespace availability in CI.
2. Design a durable intent/receipt journal before promising crash recovery.
   SIGINT reports are qualified; SIGKILL, power loss and blocked syscalls differ.
3. Qualify concurrent apply processes, network filesystems, antivirus/file locks,
   inode reuse and mount changes during JS removal. Locking coordinates Sweep
   instances but cannot lock out unrelated filesystem writers.
4. Qualify trash restore, full-disk/quota failures and permissions under an
   unprivileged account. An interrupted recursive removal can be partial.
5. Refresh dependency advisories through an authorized local or hosted workflow,
   then test exact preview downloads before considering a stable release.
