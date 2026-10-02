# Scan resource limits

Discovery runs under one cumulative operation budget. Defaults are identical
in the JS protocol package and Rust `ScanLimits`:

| Resource                         | Default |
| -------------------------------- | ------- |
| Candidates                       | 100,000 |
| Directory admissions (walk)      | 250,000 |
| Queued directory paths (walk)    | 32,768  |
| Retained inode identities (walk) | 500,000 |
| Cumulative admitted path bytes   | 64 MiB  |
| Estimated retained byte charges  | 128 MiB |

Admission is checked before insertion. Directory queue slots are returned when
work starts. Other charges are cumulative: candidates cost 1,024 bytes plus
four times their UTF-8 path length; directories cost 128 plus four times their
path length; inode identities cost 128. Freed objects do not refund these
charges. This conservative policy can stop a long scan whose current retained
data is smaller than its cumulative charges.

**Sizing is post-admission work and does not share these counters.** A
candidate's own subtree was already bounded when it matched during discovery;
re-charging it would double-count and could starve the walk. Each sizing job
instead bounds its transient state locally: the inode-dedup sets are capped at
`maxIdentities` entries per job (~16 MB transient), and the job's pending
directory queue is capped at `maxQueuedDirs`. Reaching a cap never kills the
scan: an over-cap hardlink is counted again (the estimate becomes an upper
bound) and an over-cap directory is skipped (an under bound) - both mark the
entry `bytesKnown: false` and render with `~`. The walk-level directory dedup
is structural cycle protection, so it stays on the fatal budget; it is bounded
by `maxDirectories` and cannot be starved by sizing.

**The 128 MiB value is logical accounting, not an RSS ceiling.** Runtime heaps,
thread stacks, temporary buffers, JSON parsing, the UI, native libraries and
filesystem caches also consume memory. An OS allocation failure or OOM kill is
still possible, especially on an already constrained device. Do not advertise
constant memory or guaranteed OOM immunity.

An exceeded limit produces an explicit incomplete-scan error and exit code 2.
The UI keeps its failed generation incomplete, even after dismissing the error;
apply and plan export remain unavailable. Scan a smaller subtree to proceed.
Do not silently drop candidates or treat a resource failure as a filesystem
skip. Programmatic JS hooks accept partial `limits`; native scan stdin accepts
the same optional object. No new `.sweeprc` setting or CLI limit flag is implied.
All limit values must be positive 32-bit integers. Saved-plan apply always uses
the default candidate/path bounds, even if a programmatic scan raised them.

JS discovery reads directories incrementally with 32-entry buffers. Node uses
its native `opendir`; under Bun 1.4.2 one Node child performs bounded enumeration
with at most 32 open handles and one credit-requested batch per handle. Reader
replies contain at most 128 names, while metadata work drains batches
of 32; the larger bounded transport batch amortizes IPC on flat directories.
Bun's own `fs.Dir` materializes whole `readdir` arrays despite `bufferSize`, so it is
not used for this path. Bun's JS backend needs Node on PATH; unavailability is
an explicit error, not an unsafe fallback. Standalone binaries embed Rust and
use it by default, with no external runtime required.

Metadata sizing keeps 32 raw filename buffers per enumeration batch, with eight
concurrent sizing walks across four progressive batches, each allowing up to
eight metadata calls (64 calls total). Raw names preserve invalid UTF-8
filenames. Ordinary file metadata avoids BigInt allocation; hardlink and visited
directory identities use BigInt to preserve inode precision. Native sizing uses
the shared eight-thread Rayon pool and bounded directory subdivision. Neither
engine retains one path per ordinary file in a flat artifact, and no sizing job
holds more than its per-job dedup/queue caps at once.

The external GNU `du` scan shortcut was removed because its retained inode data
cannot share this budget. Apparent sizing now uses the same bounded metadata
contract on every platform. This can slow JS apparent sizing on a single fat
artifact; Bun's JS path also pays Node worker startup and IPC cost. Compare
the current benchmark artifact rather than assuming every operation improved.

Saved-plan files, native stdin and final native stdout are bounded at 64 MiB.
Plan files are opened once, checked on that handle, and read with a byte ceiling
so growth after the initial stat cannot bypass it. Wire integers and total byte
arithmetic must fit JavaScript safe integers. Oversized or overflowing totals
are rejected before destructive operations. Intermediate native sizing overflow
marks sizing incomplete and causes the engine scan to fail.

The optional UI folder index has separate bounds: 100,000 nodes and 16 MiB of
retained UTF-8 prefix keys. Its traversal is iterative. If the index is too
large, the sidebar says `all scopes (folder index limit)` and the full candidate
list remains available. No candidates are discarded. Large ID groups are
appended iteratively to avoid JavaScript argument-count overflow.

## Qualification boundaries

Resource qualification is reproducible with `scripts/resource-stress.py`; see
[testing](testing.md) for commands and the dated benchmark evidence. Its watchdog
is test instrumentation, not a production RSS limiter. It samples the Bun host
and native child together. Repeated rescans without forced GC are observations,
not leak proofs. Capacity checks do not detect every filesystem quota; fixture
creation can still fail safely and clean up its owned temporary directory.

Scans can cross mounted filesystems. There is no single-filesystem policy or
mount-safe deletion qualification yet. A mount inside a selected artifact can
contain data reachable through that project path. Guardrails and revalidation
reduce pathname replacement races; they do not provide fd-relative containment
through every destructive operation. Concurrent mounts/path changes, real
platform consoles, installers and terminal emulators remain release gates.
The deferred syscall-based sizing optimization is separate from any future
security work on deletion containment.
