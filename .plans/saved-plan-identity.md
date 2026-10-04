# Saved-plan identity safety

- **Status:** done — implemented and verified locally; platform and atomic-containment qualification remain open
- **Scope:** protocol, scanner, engine, ui, safety
- **Created:** 2026-10-03
- **Updated:** 2026-10-04
- **Commit:** included in the authorized production-qualification checkpoint

## Problem and decision

Owned-fixture scan/save/load/apply reproductions deleted a same-type replacement
on both engines. Renaming the original away keeps its inode alive, making the
test independent of inode reuse. Replacing the complete root also went through.
The previous apply-time pins began too late to identify the scanned entry.

Capture `targetIdentity` before traversal and candidate `identity` at discovery.
The snapshot has a `platform` (`unix` or `windows`) and exact uint64 decimal
strings `device` and `inode`. Numeric JSON would lose large inode precision.
Use metadata already read for candidate mtime; do not add a stat per sizing
dirent or a thread/lock per candidate.

The fields are additive to protocol 1. Legacy plans remain readable for inspect,
but a nonempty destructive apply needs a root snapshot and identities for its
selected candidates. Missing/replaced roots refuse the apply; missing/replaced
leaves become per-candidate failures. Empty selections remain harmless no-ops.
There is no override that blesses an old plan without rescanning.

Native `--capabilities` advertises `planIdentity: true`. The host requires it
alongside `applyControl` before sending an apply request. New native direct apply
also enforces snapshots, so host validation is not its sole boundary. Older
native engines can still be inspected/scanned but cannot execute the new host's
destructive request without support. Update the native package or scan with JS.

## Lifecycle and preservation

1. JS root capture precedes worker creation; Rust captures before traversal and
   emits a root snapshot in its stream header.
2. Discovery records leaf identity without following leaf symlinks. Metadata
   failure leaves an unknown identity, not a snapshot invented after discovery.
3. Sizing updates preserve discovery identity. Stream validation rejects an
   update that changes, introduces or removes a known identity.
4. Plan construction, loading and enrichment are pure: they never capture or
   refresh approval snapshots. Unknown identities stay unknown even when the
   path currently exists. Owned benchmark fixtures explicitly capture snapshots
   as setup; production scans capture them at discovery.
5. Final TUI rescan state owns the latest root snapshot. Queued, exported and
   single-row plans use that state rather than the initial empty plan's identity.
6. Both engines compare saved identities before scheduling a removal, preserve
   existing begin-time checks and verify the approved root near operations.
7. Receipt alias keys are frozen before removal in both engines. A selected
   alias child cannot become unattempted merely because parent deletion makes
   its path stop resolving.

Candidate identity strings participate in logical retention accounting. Wire
validation bounds their fields, rejects imprecise/invalid forms and preserves
exact identifiers above JavaScript's safe numeric range. Golden comparisons
omit checkout-specific identities but separately require presence and compare
the engines' identities on the same fixture.

## Regression evidence

- Four scan/save/load/apply replacement tests failed before the change and pass
  afterwards: JS/Rust candidate replacement and root replacement.
- Native library tests enforce candidate/root snapshots without relying on the
  JS bridge and preserve replacement sentinels.
- Legacy JSON remains loadable, while missing snapshots cannot authorize apply.
- A fake older executable with cancellation but no identity capability is
  refused before its apply body starts.
- Stream tests preserve a large exact inode and reject changed sizing identity.
- TUI tests preserve a rescan identity in queued and single-row plans.
- JS covered-alias receipt reproduction failed; the pre-delete key fix passes
  for both engines. Correct the synthetic nested fixture to snapshot its own
  child identity, rather than copying the parent's identity.

All mutations use newly created, owned temporary trees. No existing project is
used for destructive testing. The [qualification record](codebase-audit-2026-10-01/saved-plan-identity-evidence.json)
records 663 passing Bun tests, 89 passing Rust tests, both required full gates,
Linux all-target lint and Windows all-target cross-compilation lint. Windows
runtime execution is not implied by a cross-compilation pass.

Fresh [scan measurements](codebase-audit-2026-10-01/engine-results-saved-identities.json)
contain 100 warm samples per engine, shape and sizing mode. The
[apply measurements](codebase-audit-2026-10-01/apply-results-saved-identities.json)
cover 400 verified runs; [resource checks](codebase-audit-2026-10-01/resource-saved-identities.json)
cover 100k files, three rescans, FD limit 64, slow consumers, explicit budget
failure and a 200 GiB sparse file. These are local workload observations, not
production latency guarantees, allocated 200 GiB deletion or leak/OOM proofs.
Benchmark fixture snapshot capture is excluded from timed apply; the final
explicit fixture setup also passed a one-sample smoke after plan construction
was made pure. Earlier measurements remain historical, tied to their hashes.

The rebuilt standalone passed an embedded-native scan with an empty PATH,
snapshot checks, UI module loading, a focused-deletion PTY interaction and
closed-output cancellation with history agreeing with disk for both engines.
The [public benchmark guide](../docs/developer/benchmarks.md) describes workload
limits and reproduction commands. No commit, merge, publication or deployment
was performed.

## Remaining boundaries

These snapshots are replacement detection, not authenticated plans, content
hashes, a locked tree or atomic containment. File contents can change in place;
IDs can be reused after removal; device IDs can be reassigned; remote filesystems
can expose missing or unusual identities. Failure must stay explicit. A user
still reviews target and selected paths from an untrusted plan.

Windows cross-compilation does not qualify real NTFS/ReFS/SMB identity behavior,
junctions or Bun/native identity parity. The existing runtime matrix now checks
parity, but its hosted result is a separate gate. [libuv's Windows stat mapping](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c)
is supporting reference, not proof of this installed Bun's Windows execution.

Descriptor/handle-relative containment, same-device bind mounts, competing
applies/trash destination races, crash recovery, cold/network workloads and
actual installed platform packages remain separate qualification work. Do not
replace std recursive removal with an ad hoc pathname walker as a shortcut.
