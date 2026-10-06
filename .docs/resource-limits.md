# Scan resource limits

Discovery runs under one cumulative operation budget. Defaults are identical
in the JS protocol package and Rust `ScanLimits`:

| Resource                                   | Default |
| ------------------------------------------ | ------- |
| Candidates                                 | 100,000 |
| Directory admissions (walk)                | 250,000 |
| Queued directory paths (walk)              | 32,768  |
| Retained inode identities (walk)           | 500,000 |
| Cumulative admitted path bytes             | 64 MiB  |
| Estimated retained byte charges per pool   | 128 MiB |
| Combined discovery and live sizing charges | 256 MiB |

Admission is checked before insertion. Directory queue slots are returned when
work starts. Other charges are cumulative: candidates cost 1,024 bytes plus
four times their UTF-8 path length; directories cost 128 plus four times their
path length; inode identities cost 128. Freed objects do not refund these
charges. This conservative policy can stop a long scan whose current retained
data is smaller than its cumulative charges.

**Sizing uses separate, shared live reservations.** Discovery stops at a matched
artifact; its descendants have not been admitted by the walk. Charging all of
their identities cumulatively can exhaust discovery merely by sizing hundreds
of artifacts. Instead, concurrent sizing jobs share live identity, queued-path,
path-byte and estimated-memory limits with the same default values. Reservations
are returned when paths are popped and jobs end, including on error or abort.
The discovery and sizing pools can each admit up to 128 MiB of logical charges;
a shared 256 MiB combined allowance now also bounds discovery charges plus live
sizing reservations. None of these values is an RSS ceiling. The directory and
hardlink sets together share one sizing identity limit across all jobs; per-job caps remain as additional bounds. Reaching a sizing cap never kills the
scan: an over-cap hardlink is counted again (the estimate becomes an upper
bound) and an over-cap directory is skipped (an under bound) - both mark the
entry `bytesKnown: false` and render with `~`. These are estimates, not certified
upper/lower bounds if a concurrent filesystem change also occurs. Apply's normal
size ceiling requires complete refreshed sizing before deleting. The walk-level directory dedup
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

Concurrency follows the CPU allowance reported by the runtime, including
affinity where supported. Rust discovery and sizing divide one allowance of
at most 16 workers, with no more than eight per pool. On one or two CPUs they
use one worker each to retain I/O overlap; larger allowances leave one CPU
outside these pools. This is admission control, not an OS CPU-use guarantee:
runtime threads, the host, multiple Sweep processes and filesystem work also
consume resources. The long-lived sizing pool chooses its allowance at creation.

Metadata sizing keeps 32 raw filename buffers per enumeration batch. JS admits
at most eight concurrent sizing walks across four progressive batches, each
allowing up to eight metadata calls (64 calls total). On one CPU this becomes
one batch with two sizing walks and two metadata calls per walk, alongside two
discovery workers. Larger allowances scale up within the existing caps.
Raw names preserve invalid UTF-8
filenames. Ordinary file metadata avoids BigInt allocation; hardlink and visited
directory identities use BigInt to preserve inode precision. Native sizing uses
the shared CPU-aware Rayon pool and bounded directory subdivision. Neither
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

The host counts native final output as UTF-8 bytes before retaining each chunk,
including multibyte Unicode. Discovery accepts only filename bytes that
round-trip through UTF-8; an unrepresentable filename marks its containing
directory incomplete instead of creating a lossy alias to another real entry.
Raw filenames inside an already selected artifact remain supported by sizing.

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

Scans can cross mounted filesystems. Native Linux deletion now opens the root
once per candidate and resolves relative entries with `openat2` restrictions,
refusing mount crossings (including same-device bind mounts), symlinked
ancestors and escape paths. It retains at most 32 directory frames and polls
cancellation within each artifact. Missing kernel support refuses deletion;
there is no pathname fallback. JS checks a bounded 1 MiB Linux mountinfo snapshot
before a directory removal or trash move, including nested bind mounts. Actual
owned bind-mount CLI qualification passed for both engines in a private namespace.
JS's snapshot is not atomic protection against subsequently changed mounts;
other platform policies still need runtime qualification. Guardrails and revalidation
reduce pathname replacement races; they do not provide fd-relative containment
through every destructive operation. Concurrent mounts/path changes, real
platform consoles, installers and terminal emulators remain release gates.
The deferred syscall-based sizing optimization is separate from any future
security work on deletion containment.

## Public profiles and long UI sessions

`--resource-profile balanced` is the default. `--resource-profile low-memory`
uses 5,000 candidates, 50,000 directory admissions, 2,048 queued directories,
65,536 identities, 8 MiB path charges, 8 MiB retained charges per pool and
16 MiB combined charges. These values apply to JS/Rust scans and the UI host.
The per-pool allowances also fit the combined limit on older engines that
understand the existing individual limits. Custom combined limits require an
updated native engine.

The UI renderer, React heap, plan serialization and engine process overhead
remain additional allocations. The rendered 5,000-candidate session probe
sampled about 287 MiB RSS on this machine; the low-memory profile is not a
promise that the whole app fits in 16 MiB or even 128 MiB. Narrow the scan scope
on constrained machines. See the dated rendered benchmark evidence and
[testing](testing.md) for a reproducible command.

CLI apply journals are private, individually capped at 64 MiB, and preserve
unknown intents after interruption. Their aggregate on-disk retention is not
yet bounded. Do not automatically discard uncertain receipts or infer that a
stale host PID means a native child has stopped. `sweep recover --journal PATH`
is read-only; stale-lock release and automatic restoration remain separate
qualification work.
