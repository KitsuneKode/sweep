# fff discovery and indexing: lessons for Sweep

Reviewed: 2026-10-08. Upstream: `dmtrKovalenko/fff`, pinned at
`c188e7a8f90e4ee4aabe18f93d5869dfb4289f12`. Read source only; no upstream
code or installation scripts were executed or copied into Sweep.

## Primary sources

- [Project and intended resident-search use](https://github.com/dmtrKovalenko/fff).
- [File picker and scan progress](https://github.com/dmtrKovalenko/fff/blob/c188e7a8f90e4ee4aabe18f93d5869dfb4289f12/crates/fff-core/src/file_picker.rs).
- [Stable column storage](https://github.com/dmtrKovalenko/fff/blob/c188e7a8f90e4ee4aabe18f93d5869dfb4289f12/crates/fff-core/src/column_slab.rs).
- [Candidate search storage](https://github.com/dmtrKovalenko/fff/blob/c188e7a8f90e4ee4aabe18f93d5869dfb4289f12/crates/fff-core/src/candidates.rs).
- [Background watcher](https://github.com/dmtrKovalenko/fff/blob/c188e7a8f90e4ee4aabe18f93d5869dfb4289f12/crates/fff-core/src/background_watcher.rs).

## Observed design

`FileSync` retains file and directory tables, with a sorted scan-built region
and appended watcher entries. Lookup searches the sorted base before checking
the overflow. Paths use shared chunk storage; snapshots share allocations.
Separate background and search pools keep maintenance from owning the query
pool. Scan progress distinguishes enumeration, watcher readiness and warmup.
The watcher updates an existing index rather than forcing every query to walk.
Some snapshot code uses unsafe sharing under upstream ownership assumptions.
That implementation needs its own concurrency review; it is not a template to
copy into destructive code. Upstream speed claims are not Sweep benchmarks.

## Adopt the principles in Sweep

1. Retain a generation-owned discovery index. Use directory IDs plus relative
   names/path offsets rather than repeating absolute strings across every UI
   row, map and scope aggregate. Preserve native path bytes and identity.
2. Serve bounded pages of rows and aggregate counters to the UI. Selection is
   an explicit set of stable artifact IDs; a displayed page is never the entire
   apply authorization. Search/sort can run off the JS render thread.
3. Publish immutable revisions with bounded deltas. Readers need an explicit
   generation/revision token; stale replies are rejected. Overflow compaction
   must respect the same memory budget as the original index.
4. Keep discovery, sizing and removal progress separate. A single large artifact
   reports activity/elapsed time without inventing a per-file percentage whose
   denominator is unknown. Only a validated report establishes completion.
5. Measure worker contention before changing worker counts. Disk work and CPU
   queries need bounded pools and cancellation, not one task or mutex per file.

The current incremental row/folder work already applies the retention principle.
This pass also routes completed grouping through the existing bounded scope-key
cache, so live and completed views share path classification.

## Keep Sweep's authority boundary

Git-ignore defaults suit a search picker; adopting them here would hide the
`node_modules`, `target` and other artifacts users came to clean. Content
indexing, frecency and fuzzy matching are optional discovery features, not
reasons to delete a recently used directory. Watcher events can invalidate a
reviewed plan, never silently broaden its selection. A cached size or path is
not fresh containment/identity evidence. Every real apply still validates its
root, exact IDs, current identity, mount boundaries and outcome partition.

The next architecture experiment is a bounded native index with page queries,
not a new search dependency or larger RAM caps. See the
[round-four follow-up](../.plans/audit-round4-2026-10-08.md) for acceptance gates.
