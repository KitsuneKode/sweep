Status: done
Scope: native review accounting and bounded UI page ownership
Created: 2026-10-12
Updated: 2026-10-12
Commit: accompanying paged-review change

# Paged review ownership

The existing native adapter validates pages but the production TUI still retains
all candidates. This pass removes two integration blockers without feeding a
partial page into the all-candidate reducers.

1. Cache native active/queued counts, bytes, partial counts and risk totals.
   Make explicit retirement atomic, revisioned and bounded. Retired rows cannot
   be queued or appear in future pages. Retention accounting remains conservative.
2. Validate new receipts against compact host witnesses; prepare single-item plans
   without toggling the queue or reconstructing all candidates.
3. Add a UI page owner that retains one bounded page, keeps global totals outside
   that page, prepares explicit queue/single plans and reconciles trusted outcomes.
   Failed/unattempted rows stay; unknown or incomplete reports cannot retire rows.
4. Test page eviction, hidden queue state, cancellation, stale rows, forged receipts,
   partial bytes and repeated apply accounting against the real native subprocess.
5. Run check, rust:check and the verification ladder; commit and check hosted CI.

Default integration still needs progressive generation replacement, sidebar/group
ordering and bulk-action contracts. Native byte-order name sorting must not silently
replace the current locale-aware order. Scan/saved-plan ceilings stay unchanged.
No existing user corpus is scanned or deleted by qualification fixtures.

## Results and review

- Native summary reads now use cached totals rather than a full candidate walk.
  Atomic retirement advances revision once per bounded batch. It removes active
  and queued counts, byte estimates and risk totals; the last partial row clears
  the corresponding partial marker. Record storage remains charged until close.
- The host checks receipts against its own compact witnesses. Caller mutation
  cannot change an in-flight ID batch. Single-row plans own their nested objects,
  keep the queue intact, and reject changed or retired candidates.
- The page owner exposes immutable queue marks for the visible page without
  confusing them with the complete queue. It rejects overlapping requests and
  actions on stale/evicted rows.
  Complete interrupted reports remove only deleted/covered rows; failed and
  unattempted rows remain queued. A failed later retirement batch closes the
  review generation while retaining the known apply counts.
- Review tightened plan binding: unknown/duplicate IDs, changed metadata and
  mismatched root identity cannot be reconciled into the generation. Failure paths
  must match the failed outcome ids; covered children retire with a confirmed
  parent without adding a second deletion to the receipt. A poisoned
  native session also releases the page. Filesystem apply still belongs to the
  existing guarded engine and external operation owner.
- Focused adapter/owner suite: 37 passing tests. Rust discovery suite: 8 passing
  tests. `bun run rust:check` and `bun run check` passed before the final document
  update; rerun check and the clean-source verification ladder before push.

The [raw benchmark report](paged-review-2026-10-12.json) records the binary hash,
compiler, runtime and source state. It includes 600 exact page/reference comparisons
and three 50k replacement/export/retirement cycles with unchanged descriptor counts
and reaped children. No source fixture paths were created or removed.

| Synthetic metadata     | Native logical storage                             | Native peak RSS | Page round-trip p99 |
| ---------------------- | -------------------------------------------------- | --------------- | ------------------- |
| 5,000 ordinary paths   | 1.9 MiB                                            | 7.7 MiB         | 2.7 ms              |
| 50,000 ordinary paths  | 20.0 MiB                                           | 56.8 MiB        | 48.9 ms             |
| 100,000 ordinary paths | Refused by saved-plan retained budget before spawn | —               | —                   |
| 100,000 compact paths  | 28.0 MiB                                           | 84.7 MiB        | 23.9 ms             |

These timings include transport, validation and the page owner. Native peak RSS
includes snapshot parsing/build. The benchmark holds a full reference plan in
JavaScript, so it does not qualify total rendered TUI memory, low-spec devices,
real scans, or allocated 200–600 GiB deletion. Name/group ordering is unchanged in
the production UI; this checkpoint does not enable native paging by default.

## Next integration work

- Scope/group aggregates and deterministic cursor lookup across page retirement.
- Bulk actions with an explicit policy for hidden rows; no page-local "queue all".
- Progressive scan-to-index handover that releases the host's full candidate graph.
- Native render/long-session evidence before default activation, preserving current
  locale-aware name ordering or documenting an explicit replacement.
- Mount/path races and real allocated large-tree testing remain separate gates.
