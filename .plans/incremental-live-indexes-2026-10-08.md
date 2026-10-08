Status: implemented; closing qualification follows this commit
Created: 2026-10-08
Scope: live index allocation, scope identity, final qualification
Baseline: 762fc15067eda095b457c08885c5fa7612145eb0

# Incremental live indexes

The [prior UI checkpoint](ui-streaming-followup-2026-10-08.md) is committed,
pushed and hosted-green. Its 50k synthetic producer exceeded 1 GiB sampled RSS.
This pass reproduced that failure before changing production code.

## Implemented

- Live artifact groups, membership and item rows survive discovery/sizing
  frames. Only changed headers are replaced. Earlier returned arrays and row
  objects remain unchanged; selection, filter, collapse and cursor behavior
  still refer to explicit artifact IDs. Completed scans use the existing
  requested sort, and structural changes rebuild safely.
- Folder topology remains uncompressed internally. New paths are inserted;
  sizing/selection deltas propagate to their ancestors. Compression is a view
  so new siblings can split an earlier flattened chain without losing folders.
  Leaf nodes allocate no child map. Unchanged rows and sorted children are
  reused; rename, deletion, reorder and target changes invalidate observations.
- The optional folder index retains its 100k-node/16 MiB key limits, with an
  honest aggregate fallback. Neither scan resource limits nor safety guards
  were raised. No forced GC was added to the application.
- Hover clearing avoids dispatching an empty hover state on every live commit.
  A native mouse test covers unchanged frames and removal of a hovered row.
  The benchmark now fails on maximum-update-depth warnings, stalled delivery,
  excess memory or missing final reconciliation.
- Literal backslashes on POSIX no longer merge `a\b` with `a/b`. Grouping,
  filtering, bulk scope queueing, inspection and confirmation preserve their
  identity. Windows alone normalizes its native separators for the tree view.

## Verification record

The row-reuse and POSIX-scope regression tests failed before their fixes.
100 deterministic discovery/sizing/selection/rename/removal transitions match
recorded output from the previous folder implementation. A committed seeded
fresh-vs-incremental test protects future changes. Native UI tests and the
required repository gate passed after the final production changes (49/49
tasks). React Doctor 0.9.17 reports no changed-file issues across nine files;
its aggregate score is not a whole-app clean claim.

Final benchmark receipts and source hashes are in the
[evidence directory](incremental-live-indexes-2026-10-08/metadata.json).

| Workload                                                              | Result         |            Elapsed | Sampled peak RSS | Input samples | Observed input p99 |
| --------------------------------------------------------------------- | -------------- | -----------------: | ---------------: | ------------: | -----------------: |
| [50k baseline](incremental-live-indexes-2026-10-08/baseline-50k.json) | Guard exceeded | 15.4 s, incomplete |         1027 MiB |            68 |             162 ms |
| [5k final](incremental-live-indexes-2026-10-08/qualified-5k.json)     | Passed         |             0.39 s |          233 MiB |            18 |        See receipt |
| [50k final](incremental-live-indexes-2026-10-08/qualified-50k.json)   | Passed         |             5.36 s |          642 MiB |            65 |              50 ms |
| [100k final](incremental-live-indexes-2026-10-08/qualified-100k.json) | Passed         |            22.18 s |          930 MiB |           115 |              68 ms |

All final runs report one maximum outstanding commit and zero update-depth
warnings. Earlier 100k repeats varied from about 893 to 986 MiB; the final
930 MiB result has little headroom below the test guard. This does not qualify
low-memory devices. Timings and RSS depend on workload, runtime and machine.

The receipts exercise
actual React scheduling and OpenTUI native in-memory output with 5k, 50k and
100k distinct scopes, discovery followed by sizing, and keyboard input.
They do not enumerate files, delete data or include a physical terminal.
Sparse input samples are not statistical p99 qualification. The 1 GiB guard
is a test assertion, not a process RSS limiter in the product.

The 70-column probe also passed; compact mode asserts completion state while
default-width probes assert the full discovery count.

Closing gates are pending at this commit: clean-tree `verify -- --all`, then
exact-commit hosted CI. Their post-commit receipts are stored in ignored
`.scratch/qualification-incremental-ui-2026-10-08/` and reported in the task
completion response. This avoids embedding a self-referential commit SHA.
Nothing is published by this task.

## Remaining production boundaries

1. Paging/spill and measured low-memory profiles: even passing large tests
   retain substantial RSS; candidate arrays/maps and completed sorting still
   scale with the tree. 100k synthetic UI candidates are not proof that a real
   scan will fit its separate logical resource budgets.
2. Allocated 200–600 GiB trees stratified by entry count, filesystem shape,
   cold/NFS IO, hardlinks and repeated long sessions.
3. Mid-delete Linux mounts and non-Linux interior mount/reparse boundaries;
   installed-package smoke is a different gate.
4. Async engine probes, bounded stalls, journal/extraction retention and
   overlapping-target coordination.
5. Physical TTY/device qualification and FIFO/socket, raw-name, hardlink-web,
   case-fold, extreme-path and installer-interruption coverage.
