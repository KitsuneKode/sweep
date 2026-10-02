# Large selection responsiveness

- **Status:** done — platform qualification pending
- **Priority:** P2 performance
- **Scope:** UI selectors, grouping and sidebar
- **Created:** 2026-10-01
- **Updated:** 2026-10-02
- **Commit:** uncommitted
- **Effort:** M–L

## Problem and current behavior

The summary cache removes whole-list totals work from cursor/progress changes.
A 50k-candidate selection toggle still took about 146 ms median / 154 ms p95
in the measured state pipeline, excluding React/OpenTUI rendering. A04.
`computeDisplayRows` in `packages/ui/src/rows.ts` builds maps, groups and sorts
again on selection; `scope-tree.ts` repeatedly walks subtrees for stats/sorting.

## Implementation

Allowed: `packages/ui/src/rows.ts`, `scope-tree.ts`, selector/state modules,
related tests and a reproducible UI benchmark. Preserve established layout,
scroll/cursor identity, order pinning and every apply confirmation.

1. Capture 1k/10k/50k toggles and cursor moves with a seeded benchmark. Separate
   state derivation from native rendering; record samples and CPU/runtime.
2. Separate immutable candidate order/group membership from selected counts.
   Key caches by candidate/filter/sort/collapse/pin inputs, avoiding selectedIds
   where ordering does not depend on selection. Compute group aggregate bytes
   once rather than within a comparator. Never let memoized values mutate.
3. Build sidebar topology once per candidate generation. A single postorder
   pass caches subtree bytes/counts; selection uses selected aggregates without
   re-sorting topology. Start with O(N) selected-stat passes before introducing
   fragile delta mutation. Delta updates must account for every ancestor and
   filter scope and are justified only by the resulting benchmark.
4. Retain stable candidate IDs and group headers. Queue filters legitimately
   depend on selection; their visible membership must still update immediately.
   Structural changes still reanchor the cursor on the same candidate ID.
5. If visible rendering still blocks after selectors improve, profile renderer
   work before changing virtualization. Preserve reduced motion and terminal
   viewport invariants; do not redesign the UI as a performance fix.

## Validation and stop conditions

Tests: toggle in collapsed group, queued-only filter, pinned discovery updates,
selection cleared mid-scan, size update changing sort, keyboard/mouse navigation,
search and sidebar expansion. Compare outputs against existing uncached logic.
Run `bun run check`; report both selector and real-terminal measurements. A
reasonable first target is selection state p95 below 50 ms at 50k on the same
machine, not a universal latency promise. Stop and report if preserving input
semantics prevents the target; do not hide updates with optimistic wrong totals.
Refresh ownership first. No commit/publish or unrelated redesign authorization.

## Execution evidence

Implemented and checked in the authorized inline remediation. See
[remediation](remediation.md) for behavior, regressions, measurements and limits.
The design above records the original intent; owning current behavior is in
[architecture](../../.docs/architecture.md). No commit or publish was performed.
