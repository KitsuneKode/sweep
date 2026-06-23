# Rust engine parity

Status: planned
Scope: engine
Created: 2026-06-24
Updated: 2026-06-24
Commit: uncommitted
Parent: [master.md](./master.md)

## Why

Rust engine is default when installed but can drift from JS on streaming, guardrails,
and sizing. Original overhaul **Phase 5**. Protocol schemas in
[`packages/protocol/schemas`](../../packages/protocol/schemas) are the contract.

Depends on: [trust-guardrails.md](./trust-guardrails.md), [streaming-engine.md](./streaming-engine.md) (JS reference behavior first).

## Steps

1. Guardrails + apply containment in `crates/sweep-engine/` (mirror JS).
2. Progressive/streaming NDJSON scan output; `exact` sizing path.
3. Batch `du` (50 paths per subprocess, aligned with JS `DU_CHUNK_SIZE`).
4. Forward full `SweepConfig` via stdin bridge (patterns, ignore, depth).
5. Expand [`tests/integration/engine-contract.test.ts`](../../tests/integration/engine-contract.test.ts): streaming, guardrails, Windows; tighten byte tolerance only where documented.

**Verify:**

```bash
bun run check
bun run rust:check
bun test tests/integration/engine-contract.test.ts
```

## Done

- [ ] Rust not silently bypassed for default interactive path when binary present
- [ ] Contract tests cover streaming + guardrails
- [ ] `bun run rust:check` passes
