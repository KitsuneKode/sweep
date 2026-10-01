# Codebase audit and execution order

- **Status:** `planned` — streaming and focused guardrail fixes implemented locally; remaining plans below are not implemented
- **Scope:** `security`, `engine`, `performance`, `ui`, `release`, `product`
- **Created:** 2026-10-01
- **Updated:** 2026-10-01
- **Commit:** `uncommitted`
- **Reviewed baseline:** `12c52b164ecef681151fa2f3faf15121b11ec047` plus this audit's working changes

Engine traversal work (A01, A02, A03, A05, A08, A09, and the Rust size-walk
inversion) is executed from [traversal-engine.md](../traversal-engine.md).
A04 and A10 stay in the [audit report](audit.md). The open follow-ups below
are described in that report; they preserve sweep's priority order: trust,
performance, predictable failure behavior.

| Order | Plan                                          | Priority       | Effort | Depends on                        | Status  |
| ----- | --------------------------------------------- | -------------- | ------ | --------------------------------- | ------- |
| 1     | Bound JS glob matching                        | P1 security    | M      | none                              | planned |
| 2     | Make native apply reporting exact             | P1 correctness | L      | none                              | planned |
| 3     | Bound scan scheduling and sparse-size latency | P1 performance | L      | 001                               | planned |
| 4     | Keep large UI selections responsive           | P2 performance | M–L    | streaming changes in current diff | planned |
| 5     | Make history bounded and totals honest        | P2 correctness | M      | none                              | planned |

001 should land before broader scanner performance work: otherwise a regex
hang can dominate any queue budget. 002's exact apply report precedes additional
native delete concurrency. 004 should use the current first-reveal/coalescing
behavior and must preserve manual selections and cursor identity.

No fixes are committed, merged, published or deployed by this audit. Do not
execute all plans in the same shared worktree concurrently; scanner/UI/protocol
ownership overlaps. Each executor must refresh the current diff first and
preserve other work. Do not commit, push or publish without separate instructions.

## Findings considered and rejected

- Missing Windows/macOS Rust CI: already present in `.github/workflows/ci.yml`.
- Missing confirmation for safe TUI queues: already fixed; every apply confirms.
- Generic `dist`/`build` enabled by default: already opt-in, dangerous and unselected.
- Rust sizing is entirely post-walk: superseded by `12c52b1`; sparse-batch latency remains.
- Removing Rust `remove_dir_all` merely because it might follow interior symlinks:
  current std documentation describes symlink TOCTOU protection on most platforms;
  audit the surrounding ancestor boundary rather than inventing a blanket vulnerability.
- `SWEEP_ENGINE_PATH`/PATH executing a selected local program: intentional local
  extension convention. Missing timeouts and malformed-output handling are separate defects.
- Concurrent Rust deletion as a quick win: deferred deliberately; exact cancellation
  and accounting must be proven first.
- Replacing OpenTUI, adding a disk-browser UI, cloud uploads or mandatory analytics:
  unsupported by product direction and unnecessary for the measured bottlenecks.
- Missing security reporting policy: `SECURITY.md` already exists.
