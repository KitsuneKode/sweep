# Trust — apply containment and guardrails

Status: planned
Scope: engine
Created: 2026-06-24
Updated: 2026-06-24
Commit: uncommitted
Parent: [master.md](./master.md)

## Why

Trust first. `applyPlan` must not delete outside `plan.targetDir`. Windows paths,
junctions, and `blocked` tier gaps are known holes in the overhaul audit.

## Steps

1. **`applyPlan` containment** (`packages/core/src/engine.ts`) — before delete,
   `path.resolve(candidate.path)` must stay under resolved `plan.targetDir`
   (platform `path` + trailing sep guard).

2. **Windows guardrails** (`packages/core/src/guardrails.ts`) — `BLOCKED_ROOTS`
   for `C:\`, `C:\Users`, `C:\Program Files`; segment splitting via
   `path.win32` when `process.platform === "win32"`.

3. **Junctions / reparse points** (`packages/core/src/scanner.ts`) — detect,
   treat like symlinks (unlink only, never recurse).

4. **`blocked` tier** (`packages/core/src/planner.ts`) — producer rule for
   paths inside VCS / protected dirs; UI already refuses toggle.

5. **Rust parity** (`crates/sweep-engine/`) — mirror containment; extend
   `tests/integration/engine-contract.test.ts`.

**Verify:**

```bash
bun test packages/core/src
bun test tests/integration/engine-contract.test.ts
bun run check
bun run rust:check   # if crates/ touched
```

## Done

- [ ] Test: plan path outside targetDir rejected at apply
- [ ] Test: junction not recursed
- [ ] `blocked` candidates appear in fixtures with correct tier
- [ ] `bun run check` passes
