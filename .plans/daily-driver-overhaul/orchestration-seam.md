# Interactive cleanup orchestration seam

Status: planned
Scope: cli
Created: 2026-06-24
Updated: 2026-06-24
Commit: uncommitted
Parent: [master.md](./master.md)

## Why

`apps/cli/src/handlers/ui.ts` owns a `while(true)` rescan loop that duplicates
scan config mutation, spinner handling, and apply gating spread across `scan.ts`,
`clean.ts`, and `shared.ts`. One deep module improves locality and gives
integration tests a single user-journey surface.

## Target interface

Location: `apps/cli/src/orchestration/interactive-cleanup.ts` (CLI-only — avoids
`@kitsunekode/sweep-ui` importing from core in a cycle).

```ts
export type ReviewAdapter = (plan: ScanPlan, ctx: ReviewContext) => Promise<SweepUiOutcome>;

export type InteractiveOutcome =
  | { type: "completed"; report: ApplyReport }
  | { type: "aborted" }
  | { type: "nothing" };

export async function runInteractiveCleanup(
  opts: InteractiveCleanupOptions,
): Promise<InteractiveOutcome>;
```

Hides: pattern state threading, rescan loop, `assertSizeLimit`, dry-run exit,
engine selection.

## Steps

1. **Characterize current behavior** — integration test that runs `handleUi` with
   mocked TUI returning `rescan` then `apply`. Commit test on red if needed.

2. **Implement `runInteractiveCleanup`** — extract loop from `ui.ts` lines ~141–191;
   accept `review: ReviewAdapter` (production: `runSweepUi`).

3. **Thin `handleUi`** — config resolve → `runInteractiveCleanup` → exit mapping.

4. **Share apply path with `handleClean`** — both call same post-review apply +
   `executePlanDeletion` block from `shared.ts`.

5. **Pass scan hooks** — wire `onEntrySized` for future in-TUI progress ([ui-review-pane.md](./ui-review-pane.md) step 5).

**Verify:**

```bash
bun test tests/integration
bun run check
```

## STOP

If orchestration must live in `packages/core`, keep UI adapter injected via
callback type defined in CLI — never import `@kitsunekode/sweep-ui` from core.

## Done

- [ ] `ui.ts` has no rescan loop
- [ ] Integration test: rescan → apply
- [ ] `handleClean` shares apply seam
- [ ] `bun run check` passes
