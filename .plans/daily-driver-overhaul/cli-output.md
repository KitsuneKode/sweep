# CLI output — deduplication and exit semantics

Status: planned
Scope: cli
Created: 2026-06-24
Updated: 2026-06-24
Commit: uncommitted
Parent: [master.md](./master.md)

## Why

Handlers sometimes render progressive lines _and_ `printGroupedScanPlan` (~2×
output). CI logs miss totals; doctor warnings exit `1` like user abort.

## Steps

1. **Output mode matrix** — document and implement one path each:
   - `quiet` → errors only
   - default TTY → progressive OR grouped, not both
   - `verbose` → progressive with per-candidate lines
   - `--json` / `--json-stream` → machine only, no banner duplication

2. **Audit handlers** — `apps/cli/src/handlers/scan.ts`, `clean.ts`; pick single
   render call site per mode.

3. **Display cleanup** (`packages/display/src/`) — remove dead `printScanSummary`
   if unused; ensure non-TTY prints totals + group headers.

4. **Exit codes** (`apps/cli/src/errors.ts`) — doctor warnings → `0` or dedicated
   code; distinguish abort vs failure vs config parse.

5. **Flags** — `--json` on `clean` and `doctor` if missing; de-dupe `plan` vs
   `scan --json` in help text.

**Verify:**

```bash
bun test tests/integration
bun run check
# manual: SWEEP_NO_COLOR=1 sweep scan tests/fixtures/... | wc -l (no duplicate blocks)
```

Partial dependency: spinner dead zone improves after [streaming-engine.md](./streaming-engine.md).

## Done

- [ ] No double-print in default scan/clean paths
- [ ] Doctor exit codes documented and tested
- [ ] `bun run check` passes
