# Codebase audit and execution order

- **Status:** done — code fixes verified; hosted/platform and security qualification remain
- **Scope:** `security`, `engine`, `performance`, `ui`, `release`, `product`
- **Created:** 2026-10-01
- **Updated:** 2026-10-04
- **Commit:** included in the authorized production-qualification checkpoint
- **Reviewed baseline:** `12c52b164ecef681151fa2f3faf15121b11ec047` plus this audit's working changes

Engine traversal work (A01, A02, A03, A05, A08, A09, and the Rust size-walk
inversion) is executed from [traversal-engine.md](../traversal-engine.md).
A04 and A10 stay in the [audit report](audit.md). The requested worktree
comparison is in [traversal-review.md](traversal-review.md). The executed follow-ups below
are described in that report; they preserve sweep's priority order: trust,
performance, predictable failure behavior.

Current streaming, traversal and apply fixes are implemented locally. Engine work is owned by
[traversal-engine.md](../traversal-engine.md). Measured results and limitations
are in [benchmarks.md](benchmarks.md); the full issue register is in
[audit.md](audit.md).

The [Rust follow-up review](rust-followup-review.md) records the October 3
destructive-operation, filename, Windows-build and signal fixes, plus fresh
scan/deletion/resource measurements. The subsequent
[saved-plan identity follow-up](../saved-plan-identity.md) implements discovery-time
root and candidate snapshots with fresh gates and benchmark evidence. Ancestor/mount
and real-platform qualification remain open. Local passing gates do not establish
race-free deletion or authorize a release. The October 4
[production qualification](../production-qualification.md) adds native Linux
descriptor removal, private bind-mount and installed-package proof, paced stream
fixes and long-session navigation/cache checks. Other platforms and remaining
race/crash boundaries still require qualification.

| Order | Follow-up                                                     | Priority              | Status |
| ----- | ------------------------------------------------------------- | --------------------- | ------ |
| 1     | [Native apply outcomes and cancellation](002-native-apply.md) | P1 correctness        | done   |
| 2     | [Large UI selections](004-ui-scaling.md)                      | P2 responsiveness     | done   |
| 3     | [Bounded history and truthful totals](005-history.md)         | P2 memory/correctness | done   |

Bounded globs, global JS traversal workers and Rust selected-ID indexing are
already present in the current shared diff; sparse sizing timers and robust
worker failure cleanup were verified by this continuation. The new [remediation report](remediation.md) records fixes for A02/A04/A06/A10–A17. Detailed acceptance
and remaining filesystem limits are in the traversal plan and benchmark report.

Earlier audit stages did not commit, merge, publish or deploy changes. The user
authorized a checkpoint commit on October 4; publication remains separate. Other
sessions committed overlapping work; the reviewed root baseline is `cc7dab6`. Do not
execute all plans in the same shared worktree concurrently; scanner/UI/protocol
ownership overlaps. Each executor must refresh the current diff first and
preserve other work. Do not commit, push or publish without separate instructions.

## Findings considered and rejected

- Missing Windows/macOS Rust CI: already present in `.github/workflows/ci.yml`.
- Missing confirmation for safe TUI queues: already fixed; every apply confirms.
- Generic `dist`/`build` enabled by default: already opt-in, dangerous and unselected.
- Rust sizing is entirely post-walk: superseded by progressive sizing; sparse-tail flushing now also has a timer.
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
