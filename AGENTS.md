# sweep — Agent Guide

Use this file as the thin project router. Follow it first, then open the linked
docs only when they are relevant to the task.

## Task Completion Requirements

- Run `bun run check` before treating work as complete.
  This runs format, lint, typecheck, and tests via Turborepo.
- For Rust changes under `crates/`, also run `bun run rust:check` (fmt, clippy,
  test). Individual steps: `rust:fmt`, `rust:lint`, `rust:test`.
- Never use stale command names from older docs. The repo is on `oxfmt`,
  `oxlint`, TypeScript, Turborepo, and `bun run check` / `bun run test`.

## Project Snapshot

`sweep` is an artifact cleanup CLI for project trees. It is a Bun workspace
monorepo with a single published npm package in `apps/cli` (`@kitsunekode/sweep`).

Core priorities:

1. Trust first.
2. Performance and low overhead.
3. Predictable behavior under failure and destructive operations.

If a tradeoff is required, choose correctness and guardrails over convenience.

## Repo Map

- `apps/cli/` — Commander program, command handlers, CLI entrypoint, and the published `@kitsunekode/sweep` package.
- `packages/protocol/` — shared protocol types and JSON Schema artifacts.
- `packages/core/` — config, guardrails, scanning, planning, and cleanup engine.
- `packages/display/` — terminal formatting, spinners, and progressive output.
- `packages/ui/` — OpenTUI interactive selection flow.
- `packages/typescript-config/` — shared TypeScript config for workspaces.
- `crates/sweep-*/` — Rust workspace (`types`, `errors`, `fs`, `engine`, `engine-cli`).
- `tests/` — Bun integration and contract tests.
- `scripts/` — build, preflight, and fixture tooling.
- `.plans/` — active plans, backlog, and archived plan history.
- `.docs/` — durable internal project truth.
- `.reference/` — external or supporting reference material.
- `README.md` — user-facing package documentation.

## Read Next

- Workspace layout: [.docs/workspace-layout.md](.docs/workspace-layout.md)
- Engineering principles and doc ownership: [.docs/engineering-principles.md](.docs/engineering-principles.md)
- For active work and backlog: [.plans/README.md](.plans/README.md)
- For project architecture: [.docs/architecture.md](.docs/architecture.md)
- For current product direction: [.docs/product-direction.md](.docs/product-direction.md)
- For config behavior: [.docs/config.md](.docs/config.md)
- For tooling commands and policy: [.docs/tooling.md](.docs/tooling.md)
- For how to run and test (prompts, engines, fixtures): [.docs/testing.md](.docs/testing.md)
- For local dev and `npm link`: [.docs/getting-started.md](.docs/getting-started.md)

## Documentation Ownership

- Keep this file short. It owns routing, completion rules, and a few important
  repo invariants.
- Put stable project facts in `.docs/`.
- Put active execution plans and backlog items in `.plans/`.
- Put upstream inspiration, competitor notes, and other consulted material in
  `.reference/`.
- Prefer linking to the owning document instead of repeating the same rule in
  multiple places.

## Repo-Specific Notes

- `CLAUDE.md` should remain a symlink to this file for tool compatibility.
- The current implemented config file is `.sweeprc` (JSON, no extension). The
  future direction discussed in planning is documented separately; do not assume
  it is implemented until the code changes.
- The published package is `apps/cli` (`@kitsunekode/sweep`). The root is a private
  orchestrator; internal workspaces are private. `apps/cli/scripts/build.ts` bundles
  into `apps/cli/dist/`.
