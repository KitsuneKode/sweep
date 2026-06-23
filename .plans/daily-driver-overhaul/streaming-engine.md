# Streaming scan engine

Status: planned
Scope: engine
Created: 2026-06-24
Updated: 2026-06-24
Commit: uncommitted
Parent: [master.md](./master.md)

## Why

Sync `readdirSync` + post-walk sizing blocks time-to-first-result and makes
desktop-scale scans feel stuck. Protocol already defines `candidate_found` /
`candidate_updated`; `.docs/architecture.md` calls for streaming traversal.

## Steps

1. **Async scanner** (`packages/core/src/scanner.ts`) — bounded-concurrency walk;
   emit `onEntry` during traversal, `onEntrySized` from worker pool; cap in-flight
   work and memory.

2. **Adaptive sizing** — batch `du` where available; stat fallback per chunk;
   abort/cancel hook for huge trees.

3. **Async cleaner** (`packages/core/src/cleaner.ts`) — concurrency-limited
   `rm`; real awaits in `clean()`.

4. **Bench harness** (`scripts/bench/`) — large/huge fixtures; track
   time-to-first-candidate and peak memory (hunk-style `bench:*` scripts).

5. **Handler wiring** — `runScanWithDisplay` and `handleUi` spinner update on
   `onEntrySized` without waiting for full walk.

6. **Rust follow-up** — progressive output + exact sizing in `sweep-engine`;
   tighten `engine-contract.test.ts` byte tolerance only where documented.

**Verify:**

```bash
bun run check
bun test tests/integration
# bench: time-to-first-candidate < 500ms on large-plan fixture (document actual)
```

## Done

- [ ] `scan --json-stream` emits events during walk
- [ ] Verbose CLI updates per candidate
- [ ] Bench script exists and is documented in `.docs/testing.md`
- [ ] `bun run check` passes
