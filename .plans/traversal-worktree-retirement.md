Status: done
Scope: traversal integration, worktree retirement, large-tree review UX
Created: 2026-10-07
Updated: 2026-10-07
Commit: this changeset; retirement completed before final audit follow-ups

# Retire the traversal worktree

The user authorized retiring `.worktrees/traversal-engine` after checking useful
work was carried forward and verifying main. This review compares branch
`traversal-engine` at `3e458e8e7b2ecf8b93114cd6b775bfe4d2bf97f5` with main
`9f0d450e9fb8c3596ab1b724678441cc8a244467`. Neither of the branch's two unique
commits is an ancestor of main; semantic integration, rather than a merge,
carried their features forward. The [earlier review](codebase-audit-2026-10-01/traversal-review.md)
records the original defects and replacements.

## Integration decisions

| Worktree feature                                     | Current main implementation and decision                                                                                                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed discovery pool, local LIFO and stealing        | `crates/sweep-fs/src/lib.rs` and `concurrency.rs`; keep CPU-aware admission, panic cleanup, iterator error handling, queue/identity budgets.                                                                                     |
| Subdivided in-process sizing, hardlink deduplication | Shared bounded Rayon pool and raw `PathBuf` sizing on main; do not restore nested global Rayon pools or lossy UTF-8 conversion. Apparent-size and hardlink regressions remain.                                                   |
| JS shared traversal queue and BigInt identities      | `packages/core/src/scanner.ts` has bounded global scheduling and an incremental Node directory reader under Bun; the old `du` shortcut cannot enforce shared inode/memory bounds.                                                |
| Bounded wildcard matching and literal lookup         | `glob-match.ts` has the literal Set fast path and Unicode scalar parity. Keep hostile-pattern regressions; `compileNameMatcher` was replaced by `compileGlobMatchers`.                                                           |
| Progressive discovery, sizing updates and batching   | Native batched transport, bounded decoder, final completion validation and sparse timers remain. Host pacing is stronger than the old branch, but a committed React-frame acknowledgement remains open.                          |
| Native selected-ID Set and interrupted report        | Controlled stdin cancellation, lifecycle drainage, complete selected-ID outcome partition and journals on main replace the branch's signal-only apply and 250 ms host kill.                                                      |
| Partial-size display                                 | TUI rows/context already use `~`. One missing useful detail was reproduced: plain-text progressive candidate lines lacked a partial marker. Restore it using the current `~` convention rather than the old branch's `+` suffix. |
| Fat/wide benchmarks, plans and research              | Current harness supports fat/wide/flat/resource samples; committed `.docs/benchmarks/fat-wide-2026-10-07.json` and `.docs/testing.md` record commands. Research and prior review are retained with later corrections.            |
| Dirty Turbo update and fixture deletions             | Do not port a downgrade: main resolves Turbo 2.11.7 through the catalog; dirty branch requests 2.11.6 and its schema. Keep generated fixture markers on main.                                                                    |

No wholesale merge is appropriate: it would reintroduce weaker identity,
mount, protocol, resource and cancellation checks. Full history, the binary
dirty patch and the complete worktree contents (including ignored files and
symlinks, without following their external targets) are preserved under
`.scratch/worktree-retirement/traversal-engine-2026-10-07/`. The branch reference
is retained. `history.bundle` was verified as a complete-history bundle.
This local recovery directory is intentionally ignored and is not a portable
published artifact; tracked review evidence records its hashes.

The worktree was removed after all 48 required check tasks passed. Its exact
dirty patch matched the archive immediately before removal, and every archived
regular file and symlink was compared with the live tree. The branch remains
available; the [retirement manifest](audit-round2-2026-10-07/worktree-retirement.json)
records artifact sizes/hashes and verification boundaries.

## UX changes and evidence

- The 10,000-folder sidebar regression originally mounted 30,010 renderables.
  The viewport implementation stays below 200 at 20 rows and below 120 after
  shrinking to ten rows. Keyboard seeking, wheel movement, scrollbar seeking
  and exact clicked-scope identity are exercised with the real OpenTUI renderer.
- The old guide builder accessed 132,353 rows for a 514-row nested shape.
  A reverse sibling pass eliminates repeated subtree searches; the regression
  bounds row accesses without relying on a machine-specific timing threshold.
- Shared artifact/sidebar scrollbar interaction keeps cursor-coupled navigation
  and clamps the thumb to small viewport heights.
- Invalidation copy says `review incomplete` and `rescan before applying`,
  rather than claiming every stale or partially measured total is a lower bound.
- A [50,000-folder rendered run](../.docs/benchmarks/ui-render-wide-50k-2026-10-07.json)
  records three synthetic completed-plan sessions, 300 movement samples,
  15.74 ms p99 input-to-paint and 580.57 MiB session-sampled maximum RSS.
  There is no physical terminal, live scan or before/after performance baseline
  in this measurement. Windowing reduces mounted rows but does not eliminate
  retained candidate/index memory. Low-memory readiness remains open.

## Constraints that still need work

The default 10 GiB byte cap has already been removed; explicit configured caps
remain visible and enforceable. Candidate, path, queue and identity limits remain
necessary. They are logical charges, not a device RSS guarantee. The subsequent
[round-three pass](audit-round3-2026-10-07.md) aligns candidate metadata charges.
Wide-directory admission parity, incremental UI indexes and actual frame
backpressure remain open in the
[round-two ledger](audit-round2-2026-10-07/README.md). Raising limits blindly
would trade honest refusals for allocation failure.

Windowed rows do not make filtering, aggregating or every keystroke constant
time. Large allocated trees, cold/NFS storage, concurrent mounts and physical
terminal responsiveness still require qualification. Cancellation stops work;
it does not restore removed contents. No deletion guard was relaxed here.

## Acceptance

- [x] Refresh history, all dirty paths, ignored/untracked inventory and active
      readable `/proc/*/cwd` references; no worktree process was observed.
- [x] Preserve and verify recovery data before removal.
- [x] Restore the useful missing progressive marker with a failing-before test.
- [x] Reproduce and fix sidebar mounting and repeated guide-search costs.
- [x] Run required `bun run check` and review React diagnostics. The changed-code
      React Doctor pass reports no introduced findings; its 62/100 score is
      not a full health or performance qualification.
- [x] Recheck the dirty worktree snapshot, then remove only that worktree.

Commit/push and exact-commit hosted checks are integration evidence, tracked
separately from the completed worktree retirement. Publication remains unauthorized.
