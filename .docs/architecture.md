# Architecture

## Current state

The repo is a Bun workspace monorepo. The root package `@kitsunekode/sweep` is
the published npm surface; internal workspaces compile into `dist/` via
`scripts/build.ts`.

### Layering

| Layer           | Location             | Responsibility                             |
| --------------- | -------------------- | ------------------------------------------ |
| Protocol        | `packages/protocol/` | Shared types, JSON Schema artifacts        |
| Core engine     | `packages/core/`     | Config, guardrails, scan, plan, apply      |
| Display         | `packages/display/`  | Terminal formatting and progressive output |
| UI              | `packages/ui/`       | OpenTUI selection flow and state           |
| CLI             | `apps/cli/`          | Commander program, handlers, entrypoint    |
| Rust experiment | `crates/sweep-*/`    | Alternate engine behind the same contract  |

### Data flow

```
CLI flags / config
       ↓
  packages/core (scan → plan → apply)
       ↓
  packages/protocol (ScanPlan, ApplyReport, ScanEvent)
       ↓
  packages/display (stdout)  or  packages/ui (interactive)
```

- `apps/cli/src/handlers/` maps subcommands (`scan`, `apply`, `ui`, default
  clean) to core engine calls.
- `sweep ui` scans via core, then hands plan editing to `packages/ui`; final
  selection compiles back to explicit candidate IDs.
- `scripts/seed-fixture.ts` and `tests/support/fixtures.ts` seed parity scenarios
  for integration tests and future JS-vs-Rust checks.

### Commands (implemented)

- `sweep` — default cleanup flow with prompt and guardrails
- `sweep scan` — scan only; `--json` and `--json-stream` for automation
- `sweep apply --plan` — apply a saved plan with revalidation
- `sweep ui` — OpenTUI interactive selection (TTY required)

## Intended direction

The accepted direction is clearer package and engine boundaries with a
schema-first contract:

- public package: `@kitsunekode/sweep` (root)
- internal boundaries: protocol, core engine, display, CLI app, UI, Rust engine
- execution model: `scan`, `apply`, and `ui`, with plan-backed apply and strict
  default revalidation

See [.docs/workspace-layout.md](workspace-layout.md) for the directory map and
[.docs/product-direction.md](product-direction.md) for product intent.

## Long-term architecture decisions

- The long-term contract should be schema-first.
- A JS implementation should remain the reference behavior initially.
- Alternative engines, including Rust, should implement the same external
  contract rather than redefining product behavior.
- The interactive UI should stay a thin shell over the shared plan contract:
  local cursor/filter state is okay, but final selection must compile back into
  explicit candidate IDs.
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
- `ScanPlan` and `ApplyReport` should have first-class JSON Schema artifacts so
  engines in different languages can target the same machine-readable contract.
- Shared protocol defs and streaming scan events should also have schema
  artifacts so the full non-interactive contract is explicit.
- Seeded fixture scenarios should cover both small targeted failures and larger
  mixed workspace trees so engine parity can be checked at multiple scales.
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
