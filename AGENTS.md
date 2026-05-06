# sweep — Agent Guide

Use this file as the thin project router. Follow it first, then open the linked
docs only when they are relevant to the task.

## Task Completion Requirements

- Run `bun run fmt`, `bun run lint`, `bun run typecheck`, and `bun run test`
  before treating work as complete.
- Never use stale command names from older docs. The repo is on `oxfmt`,
  `oxlint`, TypeScript, and `bun run test`.

## Project Snapshot

`sweep` is an artifact cleanup CLI for project trees. It is currently a single
package repo, but the intended direction is a trust-first cleanup tool with a
strong automation surface and an optional richer UI layer later.

Core priorities:

1. Trust first.
2. Performance and low overhead.
3. Predictable behavior under failure and destructive operations.

If a tradeoff is required, choose correctness and guardrails over convenience.

## Repo Map

- `packages/protocol/` — shared protocol and type surface.
- `packages/core/` — config, guardrails, scanning, and cleanup runtime logic.
- `packages/cli/` — command surface and terminal presentation.
- `crates/engine-rs/` — future Rust engine experiment scaffold.
- `tests/` — Bun tests for config, guardrails, and scanning behavior.
- `scripts/` — build and publish/preflight scripts.
- `.plans/` — active plans, backlog, and archived plan history.
- `.docs/` — durable internal project truth.
- `.reference/` — external or supporting reference material.
- `README.md` — user-facing package documentation.

## Read Next

- For active work and backlog: [.plans/README.md](.plans/README.md)
- For project architecture: [.docs/architecture.md](.docs/architecture.md)
- For current product direction: [.docs/product-direction.md](.docs/product-direction.md)
- For config behavior: [.docs/config.md](.docs/config.md)
- For tooling commands and policy: [.docs/tooling.md](.docs/tooling.md)

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
- The published package is still the repo root package; the internal workspace
  split is there to separate responsibilities without changing the public npm
  surface yet.
