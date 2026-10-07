Status: in_progress
Scope: supplied final audit, apply feedback, resource accounting, release guardrails
Created: 2026-10-07
Base: 9f0d450e9fb8c3596ab1b724678441cc8a244467
Commit: this changeset; exact-current hosted qualification pending

# Final audit follow-ups

The supplied reports are leads, not release evidence. Current code and failing
regressions determine which findings still apply. Work is implemented inline;
no new subagents were used. [Traversal retirement](traversal-worktree-retirement.md)
is complete with recoverable history and dirty contents, and is separate from
qualification of these later changes.

## Implemented

| Finding                                  | Change and evidence                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oversized confirmation                   | The real renderer used 30 of 32 terminal rows for a single item. Confirmation now uses a compact, viewport-clamped card with scrollable paths. No byte ceiling is neutral information.                                                                                                                                                                                                       |
| Missing apply percentages                | Preparation has a separate count/percentage or indeterminate state. Removal counts completed artifact operations, not bytes or individual files. It stays below 100% until an authoritative result arrives.                                                                                                                                                                                  |
| Responsive stopping                      | Esc, Ctrl+C and the clickable stop control abort the operation signal and keep the dialog/session open for the report. Mouse, keyboard and signal tests pass. Cancellation is not rollback.                                                                                                                                                                                                  |
| Ctrl+U destroys queued intent            | Plain u/U keep queue semantics; Ctrl+U/Ctrl+D page both panes. Tests assert preserved selection and the queue-cleared latch.                                                                                                                                                                                                                                                                 |
| Pattern count is inflated                | The footer uses the same enabled-pattern policy as the next scan. Default, opt-in, disabled and custom cases are covered.                                                                                                                                                                                                                                                                    |
| Candidate charges differ                 | JS discovery and native production now account for protocol strings before publication/sizing, including reserve for later workspace-stub/symlink-alias enrichment. Host stream and apply use the same UTF-16 field-length units, with UTF-8 path bytes separately. Tiny-budget discovery tests refuse before revealing candidates. This does not make logical accounting a process RSS cap. |
| Uncharged stream metadata changes        | Sizing updates must preserve kind, risk, reasons, default selection and discovery mtime, in addition to name/type/identity. A failing regression accepted changed reasons; it now refuses the update.                                                                                                                                                                                        |
| Concurrent writers produce ENOTEMPTY     | Linux secure removal reopens/re-drains the same directory at most twice after ENOTEMPTY. It rechecks identity through the pinned parent, retains NO_XDEV/NO_SYMLINKS constraints, closes EOF iterators before reopening and checks cancellation. Late write, repeated writer, replacement and retry cancellation tests pass. Continuous writers can still cause a partial failure.           |
| Prereleases fail preflight               | Preflight uses the existing strict release policy. The actual script accepts preview/stable versions and rejects malformed versions against owned manifests; missing release files still fail. No publication occurs.                                                                                                                                                                        |
| Native host binary mislabeled as foreign | Default packaging selects only a matching host release or the requested target's release path. It refuses foreign host fallback and implicit debug builds. Explicit --binary remains a caller choice and still needs architecture qualification.                                                                                                                                             |
| zsh value completion missing             | Generated specs distinguish files, enum values and depth values. Regression checks cover plan/journal/engine/depth. Syntax validation is added to Linux CI. Full interactive shell completion remains a separate check.                                                                                                                                                                      |
| Stale output qualification               | The script previously expected progress on stdout. It now reads stderr, tests stdout receipt loss separately from SIGINT, bounds preparation wait, and checks history against the owned tree plus an unselected sentinel.                                                                                                                                                                    |
| CI gaps                                  | Linux CI now runs output/cancellation and modest resource/slow-consumer probes, plus generated bash/zsh/fish syntax checks. These workflow additions have not run hosted yet.                                                                                                                                                                                                                |

## Current local evidence

- Required `bun run rust:check`: eight tasks passed, including fmt, all-target
  Clippy and 118 native tests plus doc tests. Release engine rebuilt.
- All 318 UI tests passed, including mouse stopping, pinned confirmation
  actions and PageUp/PageDown review of long paths. The full 49-task gate was
  repeated successfully after the final footer fix.
- Workspace typecheck/lint/format: all 33 tasks passed.
- Candidate/resource, stream, planner, release-policy, actual preflight and
  completion and native-pack regressions pass locally: 46 tests.
- Three owned 256-level Linux deletes passed with RLIMIT_NOFILE=32; unselected
  sentinels survived. This measures native Linux removal, not macOS/Windows.
- Updated output probe passed on both actual backends outside the sandbox.
  Lost final receipts exit 4. SIGINT exits 1 with JS 8 deleted / 32 remaining
  and Rust 1 deleted / 39 remaining; history agrees with disk and sentinels
  survive. Scheduling/timing varies; those counts are observations, not gates.
- Six bounded resource/slow-consumer cases passed, using 4096 flat files, 256
  wide artifacts, two rescans and a 64-descriptor limit. This is modest smoke
  evidence, not million-entry or low-memory UI qualification.
- Required `bun run check` passed all 49 tasks with native tests mandatory and
  documentation links valid. Sandbox listener/pipe EPERM failures were resolved
  by rerunning unchanged checks outside the sandbox. The automatic approval
  service recovered after its earlier usage-limit failure.
- [Local evidence](audit-round2-2026-10-07/qualification-round3-local.json)
  records outputs and artifact hashes; [resources](audit-round2-2026-10-07/round3-resources.json)
  records sampled process-tree RSS. Exact-current hosted qualification remains
  pending. Earlier checkpoint greens do not certify these changes.
- React Doctor's comparison against HEAD reports six DOM-property warnings
  on valid OpenTUI props and one complexity warning in the progress component.
  Terminal prop types and rendered interactions pass; no diagnostic was
  suppressed. Its full scan includes pre-existing findings, and the score API
  was unavailable. This is not a claim of a clean whole-app React audit.

## Still open, in order

1. Review/commit/push, then verify exact-current
   hosted platform/install jobs and the new CI probes. Do not publish before
   those checks and explicit release authorization.
2. Qualify allocated large trees by entry count and filesystem shape, not only
   byte size. The 50k-folder synthetic completed-plan probe sampled about 581
   MiB RSS. It is not low-memory or live-stream qualification. Bound retained
   UI indexes and consider incremental/paged data, committed-frame backpressure
   and measured device profiles before expanding scan limits.
3. Qualify Linux mid-delete mount races, JS mount timing and macOS/Windows
   interior mount/reparse deletion. Existing basic installed-package applies on
   those platforms do not cover this destructive boundary.
4. Bound engine/worker stalls, journal retention and extraction leftovers;
   design overlapping-target coordination without PID-only automatic unlocks.
5. Add FIFO/socket, raw-name, hardlink-web, case-fold and extreme-path fixtures;
   strengthen refusal/unknown-size parity and installer interruption checks.
6. Qualify physical terminals, tiny viewports, long-running scans and real
   mounted storage. Review defaults with users; do not hide estimates or loosen
   identity/mount boundaries to make a failure disappear.

No claim of exhaustive security, device-wide resource immunity or 200–600 GiB
production readiness follows from this pass.
