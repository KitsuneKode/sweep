# Sweep codebase audit

- **Status:** `planned` — audited; focused fixes implemented; open findings remain
- **Scope:** `repo`, `engine`, `ui`, `security`, `performance`, `product`
- **Created:** 2026-10-01
- **Updated:** 2026-10-01
- **Commit:** `uncommitted`
- **Baseline:** `12c52b164ecef681151fa2f3faf15121b11ec047`

## Outcome and scope

The strongest product differentiator is trustworthy cleanup with a reviewable,
programmable contract and immediate feedback. Rust is useful but is not uniformly
faster. The largest demonstrated tail problems were a native subprocess pipe
stall, regex backtracking, and large UI selection rebuilds.

The audit covered destructive JS/Rust paths, config and plan loading, native
transport, scanner/sizer scheduling, TUI state/streaming/rows, release workflows,
package smoke checks, and project intent/docs. It is a hotspot-weighted code
review with targeted experiments, not an exhaustive formal proof or a dependency
security certification. All deletion experiments used disposable temporary trees.

The initial baseline was `a42314e` with existing CLI/UI/doc edits. Other work
landed `ea8da98`, `c90dddc`, and `12c52b1` during the audit; findings were refreshed
against that state before implementation. Those commits are not audit-authored.
The report's source references describe the final working tree and may drift.

## Implemented and verified in this audit

| Change                                               | Evidence                                                                                | Result                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drain native `du` stdout during execution            | `crates/sweep-fs/src/lib.rs`, test `du_drains_long_path_output_before_waiting_for_exit` | 50 empty artifacts with long paths stalled for 30.01 s before; the regression now completes in about 10 ms. Output remains capped and the 30 s timeout remains.                                                                                                                                                 |
| Remove fixed 10 ms polling floor                     | `crates/sweep-fs/src/lib.rs`                                                            | Poll starts at 1 ms and backs off to 10 ms for long jobs. Repeated release-engine measurements are in the benchmark report.                                                                                                                                                                                     |
| Protect canonical VCS parents for symlink leaves     | `packages/core/src/planner.ts`, `cleaner.ts`, `crates/sweep-engine/src/apply.rs`        | Both engines check the parent during revalidation and again at the destructive boundary, while leaving the leaf symlink target untouched. JS and Rust regression tests pass.                                                                                                                                    |
| Validate and bound native scan streams               | `packages/core/src/ndjson.ts`, `rust-stream.ts`, `plan.ts`, `rust-engine.ts`            | UTF-8 line cap applies before newline; schema, start/finish order, candidate identity, size resolution and completion totals are checked. Malformed or truncated output fails instead of making a partial plan. Handler errors reject the request and terminate the child. Non-EPIPE stdin errors are surfaced. |
| Restore real UI batching after first reveal          | `packages/ui/src/stream-batcher.ts`, `streaming.tsx`                                    | The first result is immediate; later upserts coalesce by ID over 60 ms or 200 pending candidates. The former `buffer.size === 1` branch flushed every arrival. Completion/error/abort clean up timers.                                                                                                          |
| Keep scan failure persistent and make sizing visible | `packages/ui/src/state/store.ts`, `app.tsx`, `ReviewPane.tsx`                           | `N sizing` distinguishes unresolved sizes; dismissed failures stay `INCOMPLETE`. Apply and executable plan export require finalization. Successful retry recovers; completed scans with skipped dirs are explicitly partial.                                                                                    |
| Cache queue summaries on their real inputs           | `packages/ui/src/state/store.ts`                                                        | Cursor and progress/timing frames reuse totals; dangerous count reuses the summary. Selection/filter changes still invalidate correctly.                                                                                                                                                                        |
| Add reproducible streaming engine benchmark          | `packages/core/benchmarks/engine-comparison.ts`                                         | Alternating runs, raw samples, first result/size, empirical p50/p95/p99, heartbeat lag, and candidate/exact-byte parity.                                                                                                                                                                                        |

Focused tests include partial streams, malformed fields, oversized newline-free
UTF-8 output, duplicate/out-of-order events, mismatched summaries, failed scan
recovery, premature plan export, timer cleanup, and protected symlink parents.

## Remaining findings, in recommended priority order

Effort includes tests: S = hours, M = roughly a day, L = multiple days. Risk is
risk of the fix, not severity of the defect. HIGH confidence means code or a
controlled experiment supports the claim; MED means a further platform or
threat-model investigation is required.

| ID  | Priority / category | Finding and impact                                                                                                                                                                                                                                                                                     | Evidence                                                                                                             | Effort | Fix risk                           | Confidence                     |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------- | ------------------------------ |
| A01 | P1 security / p99   | JS glob translation creates exponential regex backtracking. One accepted short ignore pattern took 1181 ms for a single short basename in a controlled test; a larger permitted case exceeded 8 s. A project's config can freeze scan and UI feedback.                                                 | `packages/core/src/config.ts:382`, `scanner.ts:51`                                                                   | M      | MED: glob semantics/parity         | HIGH                           |
| A02 | P1 correctness      | Rust interruption kills the process rather than stopping scheduling and returning exact completed/failed/unattempted work. Partial disk changes can occur without an exact report/history entry.                                                                                                       | `packages/core/src/rust-engine.ts:152`, `crates/sweep-engine-cli/src/main.rs:59`, `crates/sweep-engine/src/apply.rs` | L      | HIGH: destructive lifecycle        | HIGH                           |
| A03 | P1 performance      | JS traversal's pool of 16 is recreated per directory. Nested sibling branches can create far more than 16 concurrent walkers; this is not a global resource limit. Broad/deep or slow filesystems can amplify memory, I/O and latency.                                                                 | `packages/core/src/scanner.ts:532`, `packages/core/src/async-pool.ts`                                                | L      | MED: scheduling/order/abort        | HIGH                           |
| A04 | P2 UI p99           | Selection changes still reconstruct grouping/sorting/sidebar stats. At 50k candidates, the post-fix state pipeline's selection p95 is about 154 ms, excluding React/native rendering. Windowed rows do not eliminate upstream whole-list work.                                                         | `packages/ui/src/rows.ts:124`, `scope-tree.ts:64`, `scope-tree.ts:119`                                               | M–L    | MED: ordering and queue counts     | HIGH                           |
| A05 | P2 performance      | Rust selection uses `Vec.contains` for each candidate, O(N×selected). Large saved plans pay quadratic work before deletion begins.                                                                                                                                                                     | `crates/sweep-engine/src/apply.rs:27`                                                                                | S      | LOW: set membership semantics      | HIGH                           |
| A06 | P2 correctness      | Native apply adapter reconstructs deleted entries as every selected path absent from failures. Nested/duplicate candidates removed by native dedupe are counted as individual deletions by the host, unlike `report.deletedCount`.                                                                     | `packages/core/src/engine.ts:183`, native `deduplicate_nested_entries`                                               | M      | MED: report compatibility          | HIGH                           |
| A07 | P2 parity / failure | Rust turns an unreadable root into a successful empty/partial scan with a skipped count; JS throws for the root. A failed root should not look like an ordinary empty scan to scripts.                                                                                                                 | `crates/sweep-fs/src/lib.rs:321`, `:325`; `packages/core/src/scanner.ts:474`                                         | M      | MED: exit-code compatibility       | HIGH                           |
| A08 | P2 correctness      | Exact/fallback sizing silently skips unreadable files/subtrees and returns a number; traversal `skippedDirs` does not represent these failures. Totals can understate data while still saying exact.                                                                                                   | `packages/core/src/scanner.ts:230`, `:250`; `crates/sweep-fs/src/lib.rs` `walk_size`                                 | M      | MED: protocol/UX sizing semantics  | HIGH                           |
| A09 | P2 streaming        | Sparse sizing batches wait for 50 candidates (8 in Rust exact mode), argv budget, or walk completion. An early candidate in a long sparse walk can remain unsized for the entire traversal.                                                                                                            | `crates/sweep-engine/src/lib.rs:209`, `packages/core/src/scanner.ts:317`, `:365`                                     | M      | MED: timer/worker lifetimes        | HIGH                           |
| A10 | P2 memory / honesty | History reads the whole file before slicing to the alleged 8 MB cap. Rotation also reads whole files and drops old sessions; `stats` calls the retained data lifetime totals even after truncation.                                                                                                    | `packages/core/src/history.ts:72`, `:93`; `apps/cli/src/handlers/stats.ts:11`                                        | M      | MED: migration/concurrent writes   | HIGH                           |
| A11 | P2 startup / p99    | Native availability probe uses synchronous spawn without a timeout. A hung engine `--version` blocks auto startup or the TUI engine switch before cancellation/UI work can run.                                                                                                                        | `packages/core/src/rust-engine.ts`, `isRustEngineAvailable`                                                          | S–M    | MED: availability cache/fallback   | HIGH                           |
| A12 | P2 release evidence | Native Linux ARM64 package is inspected but not executed (`verify: false`). ARM64 standalone CLI has its own runner, but that is a separate artifact and does not qualify this native package.                                                                                                         | `.github/workflows/native-engine-release.yml:43`; `.github/workflows/cli-binaries.yml:33`                            | M      | LOW: CI matrix                     | HIGH                           |
| A13 | P3 CI / docs        | CI's TypeScript job calls Turbo directly, omitting root `check:docs`. Older roadmap/release docs still say JS default/no Windows Rust CI/four standalone targets despite current code/workflows. The old benchmark also suggests nonexistent `rust:build`.                                             | `.github/workflows/ci.yml:54`, `.plans/overhaul-roadmap.md:36`, `.docs/release.md`, `scripts/bench-engines.ts:226`   | S      | LOW                                | HIGH                           |
| A14 | P2 design limit     | The apply size guard uses selected plan estimates, not a refreshed observation. Growth between scan and apply or hand-edited totals can bypass the intended size warning; exact sizing semantics differ from physical disk blocks. Decide whether this is a warning or an enforced current-data limit. | `packages/core/src/plan.ts:130`, `apps/cli/src/handlers/apply.ts:68`, `apply-plan.ts:33`                             | M–L    | HIGH: extra apply latency/contract | HIGH property; MED remediation |

Fix sketches: A01 uses a bounded matcher and parity tests; A02/A06 introduce
explicit native apply outcomes and cooperative cancellation; A03/A09 use global
queues and time-bounded partial-batch flushing; A04 caches immutable ordering and
updates selection aggregates separately; A05 indexes selected IDs with a set;
A07 makes root-read failure explicit; A08 carries unknown/incomplete sizing;
A10 uses bounded file-handle reads and honest retained/lifetime accounting; A11
adds a bounded probe and cache keyed to binary identity; A12 executes the actual
native package on an ARM64 runner; A13 reconciles owning docs and adds the root
doc gate to CI; A14 needs a written policy before changing apply behavior.

## Residual safety limits and missing evidence

- Filesystem operations still use pathname rechecks, not a pinned directory-handle
  boundary. The narrowed ancestor swap window and mount/bind-mount semantics need
  adversarial tests and a threat-model decision. No race-proof deletion claim is
  justified. Rust documents internal symlink-race protection for `remove_dir_all`
  on most platforms; that does not validate sweep's surrounding pathname checks.
  [Rust standard library documentation](https://doc.rust-lang.org/std/fs/fn.remove_dir_all.html).
- Plans reject symlink/type drift, but same-kind replacements have no saved inode
  identity. A directory's own `modifiedMs` is not recursive activity: editing a
  nested file need not change its root mtime. Treat age as an own-entry timestamp,
  not proof an artifact is unused.
- Scan latency benchmarks do not qualify apply throughput, cancellation latency,
  peak RSS, cold caches, network/FUSE filesystems, permission-failure tails,
  huge single directories, hardlink byte accounting, or physical disk reclaim.
- macOS/Windows/ARM64 runtime behavior and real terminal/SSH/multiplexer sessions
  were not exercised locally. Existing CI configuration is not a hosted run result.
- npm advisories were not obtained: the sandbox attempt failed DNS, and automatic
  approval review rejected the external dependency-metadata upload without
  specific approval. The approval question is pending. `cargo-audit` is not
  installed; no fresh RustSec database scan was performed. No clean dependency
  security claim is made.
- Best-effort cleanup history is not a durable recovery journal. Trash is a rename
  directory, not a complete restore/purge product; cross-filesystem moves can fail.

## Product direction and growth options

1. **Show the trust journey in a short, repeatable demo.** Use a generated mixed
   ecosystem tree; show immediate discovery, size refinement, risk explanations,
   deliberate selection, confirmation and trash. Keep benchmarks honest about
   fixture shape and engines. Npkill already exposes filtering, multi-select and
   JSON streams, so those alone are not a unique differentiator; sweep's stronger
   opportunity is reviewable cleanup policy and trustworthy failure reporting.
   This comparison is an inference from [Npkill's README](https://github.com/voidcosmos/npkill/blob/main/README.md)
   and `.docs/product-direction.md`. Effort S–M; tradeoff: demonstration quality
   must track actual release behavior.
2. **Offer an opt-in, privacy-preserving cleanup receipt.** Reuse `ApplyReport`
   and ecosystem/risk counts to export a shareable local summary. Do not share an
   executable plan, absolute paths, usernames or project names by default. Label
   estimated bytes, actual removed items and trash moves accurately. Effort M;
   tradeoff: requires A02/A06/A10 before outcome claims are dependable. The current
   private `S` plan export is gated and owner-only; a public receipt is not built.
3. **Make automation easy to adopt.** Publish tested scan→review→apply examples
   for monorepos and CI, plus structured contracts for agents. Preserve explicit
   paths, exit codes and guardrails; avoid automatic destructive cleanup in a
   starter template. Effort M; tradeoff: maintained examples need platform gates.
   Grounding: shared schemas, `scan --json-stream`, saved plans, product direction.
4. **Productize reversibility and diagnosis before adding surface area.** Design
   restore/purge for trash, `doctor` output showing resolved binary/version and
   sizing support, and regression benchmarks attached to releases. Effort M–L;
   tradeoff: restore collision, stale manifests and portability require real
   safety work. Grounding: existing JS trash/history/native package machinery.

There is no evidence that a redesign, framework swap, mandatory account, cloud
upload, or telemetry would improve adoption. Virality is not something this
local audit can guarantee; measure successful first cleanup, repeat usage and
opt-in sharing rather than treating stars or scan speed as sufficient proof.

## Verification

`bun run check` passed: 502 Bun tests, format/lint/typecheck and doc links.
`bun run rust:check` passed. Release Rust build passed. Functional package
preflight checks passed outside the sandbox; the publish gate correctly fails
because source changes are uncommitted. Nothing was committed or published.
A final refresh of verification after the last source refinement is recorded
in the benchmark report/index when complete.
