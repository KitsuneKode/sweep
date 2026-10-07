Status: in_progress
Scope: destructive safety, native protocol, output, config, release qualification
Created: 2026-10-07
Updated: 2026-10-07
Commit: f5c2270 (source checkpoint; broader release blockers remain)

# Round-two audit execution

The user's static report is a set of leads. Current code, reproductions and
qualification results decide the status below. Work is inline. The five dirty
paths in `.worktrees/traversal-engine` were preserved through this checkpoint;
the later [worktree retirement](../traversal-worktree-retirement.md) archived
them, restored the missing progressive marker and removed only the reviewed
worktree with user authorization. No release is authorized.

Latest continuation: [round-three follow-ups](../audit-round3-2026-10-07.md)
records compact apply UI, percentages/stop controls, bounded ENOTEMPTY retries,
candidate accounting, prerelease/pack/completion fixes and current validation
limits. Earlier checkpoint greens below do not certify this uncommitted pass.

## Implemented in this working tree

| Area                        | Change and evidence                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON delivery               | An early `drain` could end flush before preceding writes completed. The failing-before Writable regression now passes; final flush uses a write callback barrier. Queue and timeout bounds remain. Both Node-hosted engines delivered 1,000 unique candidates and a final completion event to a paced consumer; see slow-output.json.                                                                                                 |
| Destructive EPIPE           | Active applies cancel cooperatively. Receipt ownership persists after the controller is cleared, so a late human report EPIPE exits 4. Final result writes use stdout streams; deletion progress uses stderr. Lifecycle and output-channel regressions pass; Both actual backends report exit 4 on a lost final human receipt and preserve an unselected sentinel; see late-output.json. Real mid-apply pipe loss remains to qualify. |
| Rust canonical-key race     | Re-canonicalizing live parents at distinct stages could change a lookup key and panic. Deduplication and coverage now use frozen keys, with an alias-change regression. The original timing-dependent live panic was not reproduced.                                                                                                                                                                                                  |
| Duplicate receipt ownership | Review found a rejected duplicate-path candidate could take a valid candidate's removal receipt. The regression failed with the valid candidate reported as covered; only revalidated candidates now own the path-to-ID mapping.                                                                                                                                                                                                      |
| Dry-run                     | Preview returns before byte policy and destructive authorization gates. A 600 GiB metadata plan previews under a zero cap without `--yes`, leaving an owned sentinel unchanged. This is not a 600 GiB allocated-data benchmark.                                                                                                                                                                                                       |
| Byte policy                 | Default `maxSizeGB` is null; existing numeric caps remain effective and zero remains a zero cap. Null disables an inherited cap. CLI `--max-size-gb` supports numeric GiB or explicit none; both apply backends retain all non-byte safety/resource checks. The rendered confirmation states the policy.                                                                                                                              |
| Reader transport failure    | Worker protocol/transport failures become fatal resource errors rather than ordinary skipped-directory errors. Malformed output is exercised with a fake executable; the scanner's mid-listing downgrade path is the static partial-completion concern. Existing live-reader tests remain required and pass in the unrestricted full repository gate. Worker diagnostics retain a bounded 4 KiB stderr tail.                          |
| Target spelling             | CLI targets resolve to one reviewed canonical root, rechecked for safety. A leaf alias yields an appliable canonical plan. Trailing separators were already normalized by the current CLI; that allegation was not reproduced. Direct core/native API alias semantics still need review.                                                                                                                                              |
| Unsupported identity        | JS/Rust diagnose unavailable root identities without promising that rescan will establish them. Doctor checks root identity once. Inode-zero filesystems remain unsupported for safe apply; no weak identity fallback was added.                                                                                                                                                                                                      |
| Native plan input           | Unknown plan/candidate/summary/policy fields, unknown artifact kinds and unsafe byte/timestamp integers are rejected. A strict flat decoder preserves the public flattened candidate shape. Full createdAt/identity/cross-field validation parity remains open.                                                                                                                                                                       |
| Native options              | Misspelled scan options are rejected. Library WalkConfig defaults ignore Sweep trash. Empty-selection apply still validates a real target; stronger empty-plan identity parity remains open.                                                                                                                                                                                                                                          |
| Config trust                | Non-object JSON and unknown fields are rejected, including a misspelled cap key. Reads pin a regular file descriptor and enforce 1 MiB while reading, including editor read-modify-write. Auto-discovered configs require the current POSIX owner; explicit reviewed config paths are opt-in. Other-user ownership and Windows pathname races still need platform qualification.                                                      |
| Engine resolution           | Embedded extraction exceptions no longer prevent trying other engines. Noexec binaries, version/protocol probing, asynchronous availability checks and general child timeouts remain open.                                                                                                                                                                                                                                            |
| Terminal output             | U+2028/U+2029, zero-width/bidi controls and Unicode tags are escaped in human output. Native diagnostics retain the last 64 KiB of bytes rather than the first prefix. JSON paths remain unmodified data.                                                                                                                                                                                                                             |
| Display                     | Binary units use KiB/GiB, invalid byte values show unknown, and narrow progress prioritizes the current path. Repeated Ctrl+C keeps cancellation/report drainage; help no longer promises immediate exit during removal. Inspect estimate markers and unclosed-paste recovery remain open.                                                                                                                                            |
| Agent contracts             | JSON read-only commands and plan now use fatal error envelopes too. Refusals include retryable/hint; only lock contention is retryable. Parsed JSON-mode usage errors are structured and exit 2, distinct from cancellation. Place `--json` before invalid arguments. Completions await delivery; ignored options are warned on plan/recover and before apply early returns.                                                          |
| Rust advisories             | Offline RustSec snapshot found crossbeam-epoch and anyhow advisories. Narrow cached lockfile updates resolve them; 1,290-advisory recheck reports no findings. [Snapshot and limitations](rustsec.json).                                                                                                                                                                                                                              |

## Release blockers and next work

1. **Nested mounts and races:** qualify macOS and Windows interior mount/reparse
   behavior and implement platform-native constraints. Linux JS removal still
   has a mid-walk mount race. Fresh pathname identity checks are not handle-based
   transactions; trash slot/root races need that qualification too.
2. **Deep deletion:** the Linux 32-frame failure is fixed and hosted-qualified on x64/ARM64 with a
   bounded cache of 16 iterators and one MiB logical frame metadata. A failing
   128-level fixture now passes; replacement-directory, symlink and cancellation
   regressions pass. [Three 256-level applies](deep-deletion.json) succeed under
   RLIMIT_NOFILE=32 and preserve an unselected sentinel. A [warm shallow comparison](shallow-removal-comparison.json) records a 0.37 ms median difference across 20 samples; this is not p99. Reopening rechecks all
   ancestors and can increase work on very deep layouts; qualify other
   filesystems and descriptor-pressure behavior. Concurrent ENOTEMPTY retries
   remain separate and must be bounded with identity checks.
3. **Scale and UI:** reconcile discovery/stream/apply candidate charges and
   directory admission timing. Introduce actual committed-frame backpressure,
   incremental indexes. [Sidebar windowing](../traversal-worktree-retirement.md)
   is implemented; a 50k-folder synthetic run still samples 581 MiB RSS.
   Measure live 25k–100k UI workloads,
   million-entry deletion, cold storage/NFS, cancellation and observed RSS. Byte
   policy removal does not qualify allocated 200–600 GiB production use.
4. **Engine lifecycle:** add bounded operation/worker timeouts, verify availability
   by compatible protocol/capabilities, cache safely, handle noexec extraction,
   qualify direct native signals during blocked input, and manage crashed native
   extraction leftovers without deleting another process's live assets.
5. **Trust boundaries:** finish native plan timestamp/identity/cross-field parity,
   raw-native plan enrichment, config init atomicity and concurrent-writer tests,
   saved-plan loader adversarial coverage, unreadable-root exit-code parity and
   the unclosed bracketed-paste escape path. Keep cancellation distinct from rollback.
6. **Coordination and journals:** retain conservative locks until overlapping
   target/cross-user coordination is designed. Bound aggregate journals and test
   disk-full/crash behavior. Do not use PID liveness as automatic unlock authority.
7. **Dependencies and distribution:** fast-uri is updated to 3.1.8 through Bun
   within AJV's existing range; the lockfile change is isolated to that package. The supplied braces claim of an available patch
   conflicts with the current [advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
   which lists no patched version. Assess removal/replacement of dev tooling and
   run a current full JS audit. Cargo's result excludes registry yank checking.
   Installer interruption/checksum tests, non-mutating native pack staging,
   actual Windows junction/console cases, MSRV and exact-commit hosted CI remain gates.

The remaining first-round inventory is in
[the original triage](../audit-triage-2026-10-07.md). Dependency age, speculative
performance estimates and conditional fd-relative sizing are not automatic
implementation mandates. Measure contention, startup, serialization and IPC
before changing algorithms or removing live deletion-time validation.

## Qualification boundaries

- Required `bun run check` passed all 48 tasks, including live readers, docs
  prerender, rendered OpenTUI tests and native lifecycle/integration tests.
  `SWEEP_REQUIRE_RUST_TESTS=1` makes native availability mandatory.
- Required `bun run rust:check` passed all eight tasks, including all-target
  Clippy and native/contract tests. The current release engine was rebuilt.
- All nine local `verify -- --all --json` steps passed on committed bfdcd96,
  including clean-source preflight, installed CLI/native tarballs and standalone.
  [Exact checkpoint qualification](qualification-bfdcd96.json) records this and
  green hosted CI on Linux x64/ARM64, macOS Intel/Apple Silicon and Windows.
  The later [f5c2270 checkpoint](qualification-f5c2270.json) also passed all nine
  local steps and all hosted platforms. [Hosted deep deletion](deep-deletion-hosted.json)
  executed successfully on Linux x64 and ARM64. This is not publication or
  real-terminal proof.
- [Policy smoke](policy-smoke.json) covers a 600 GiB sparse file with zero
  allocated bytes, dry-run without destructive flags, a configured refusal,
  an explicit uncapped override and an unselected sentinel. It is not an
  allocated-data performance benchmark.
- [Slow output](slow-output.json) records both Node-hosted scan streams under
  a paced consumer, including actual artifact hashes. Consumer-paced wall
  times are delivery qualification, not scan benchmarks.
- Earlier sandbox EPERM pipe/listener failures were resolved by running the
  unchanged required tests outside the sandbox. Automatic approval service
  is responding again; no test was weakened for those environment failures.
- Required before release: review/commit of follow-ups, post-commit preflight,
  exact-commit platform/install/TTY checks and explicit release authorization.
  No benchmark, sparse file, memory safety language feature or green local
  gate proves device-wide resource immunity. The blockers above remain open.
