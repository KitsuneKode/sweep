# Architecture

## Current state

The repo is now split into internal workspaces while keeping the root package as
the published npm surface:

- `packages/protocol/src/index.ts` owns the shared protocol and type surface.
- `packages/core/src/` owns config loading, guardrails, scanning, cleanup, and
  the first shared engine operations for `scan -> plan` and `apply plan`.
- `packages/cli/src/` owns terminal output and the current CLI entrypoint.
- `scripts/build.ts` bundles the CLI package entrypoint into the root `dist/`
  output for publish.
- `scripts/seed-fixture.ts` seeds tmp scenarios for monorepo-style integration
  tests and future cross-engine parity checks.
- `crates/engine-rs/` is a placeholder Rust workspace member for future engine
  experimentation.
- The CLI now exposes an explicit `scan` path and a first `apply --plan` path
  on top of the shared core and protocol packages.

## Intended direction

The accepted direction is to evolve toward clearer package and engine
boundaries:

- public package: `sweep`
- future internal boundaries: protocol, core/reference engine, CLI surface, UI
  surface, and optional Rust engine
- likely future workspace split: protocol, core JS engine, CLI, UI, shared test
  fixtures, and Rust engine experiment

## Long-term architecture decisions

- The long-term contract should be schema-first.
- A JS implementation should remain the reference behavior initially.
- Alternative engines, including Rust, should implement the same external
  contract rather than redefining product behavior.
- The execution model should move toward `scan`, `apply`, and `ui`, with
  plan-backed apply and strict default revalidation.
- Selection policy should stay explicit in the plan contract so alternate
  engines can produce the same selected candidate sets from the same scan.
- The scan engine should stream candidates progressively, prefer time-to-first
  result over end-of-run theatrics, and keep memory bounded.
- The planner should compile user or UI selection rules into explicit candidate
  lists before apply.
- The core should emit rich candidate entities and grouping hints, but the UI
  should own grouping and presentation behavior.
- The non-interactive surface should support both final JSON snapshots and
  streamed NDJSON events.
- Candidate identity should be stable enough for saved plans and strict
  revalidation.
- Revalidation and apply failures should use stable structured failure codes so
  JS and Rust engines can be compared by behavior, not just free-form text.
- Artifact matching should evolve from flat patterns toward artifact definitions
  with richer semantics.
- Saved plans should carry candidate lists, default selections, and aggregate
  risk counts so apply does not need to rediscover intent.

## Performance direction

- Optimize for time-to-first-result.
- Keep memory bounded.
- Prefer a single traversal stream with bounded worker pools.
- Use adaptive size refinement instead of blocking on exact size for every
  candidate.

## Cross-platform direction

- Treat Linux, macOS, and Windows as first-class targets for behavior.
- Correctness must not depend on Unix-only shell utilities.
- Platform-specific accelerators are acceptable, but only as optional fast
  paths that do not change semantics.

## Safety direction

- Hard guardrails remain non-negotiable.
- Risk should be represented with tiers plus rule-level reasons.
- Dangerous selections should require stronger interaction or flags.
- Apply should support both inline convenience and saved-plan execution, but
  always compile to explicit candidate sets before deletion.
- Apply revalidation should reject entries whose symlink or entry type no longer
  matches the saved plan.
