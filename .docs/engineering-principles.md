# Engineering Principles

## Product priorities

When tradeoffs conflict, prefer in this order:

1. **Trust** — guardrails, explicit selection, predictable failure modes.
2. **Performance** — time-to-first-result, bounded memory, low overhead.
3. **Predictability** — stable contracts, structured errors, parity-friendly behavior.

## Single source of truth

| Topic                              | Owner                                                | Notes                                     |
| ---------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| Agent routing and completion rules | `AGENTS.md`                                          | Thin router only; link outward for detail |
| Tool compatibility symlink         | `CLAUDE.md` → `AGENTS.md`                            | Do not duplicate agent guidance           |
| Stable architecture and layout     | `.docs/architecture.md`, `.docs/workspace-layout.md` | Update when boundaries move               |
| Doc ownership and priorities       | This file                                            | Promote accepted plan decisions here      |
| Product direction                  | `.docs/product-direction.md`                         | Intent and UX stance                      |
| Config behavior (implemented)      | `.docs/config.md`                                    | Not future config names from plans        |
| Tooling and CI commands            | `.docs/tooling.md`                                   | Source of truth for `bun run` / `turbo`   |
| Active execution and backlog       | `.plans/TODO.md`, `.plans/*.md`                      | Status lives in plan files                |
| Upstream references and notes      | `.reference/`                                        | Not durable repo truth                    |
| User-facing usage                  | `README.md`                                          | Install, flags, examples                  |
| Technical specification            | `SPEC.md`                                            | CLI contract and guardrails               |
| Release history                    | `apps/cli/CHANGELOG.md`                              | Changesets feed published notes           |
| Protocol and plan shapes           | `packages/protocol/` + JSON Schema artifacts         | Machine-readable contract                 |
| Runtime behavior                   | Code in `packages/core`, `apps/cli`, `packages/ui`   | Docs summarize; code decides edge cases   |

## Documentation rules

- **Link, don't duplicate.** If a fact has an owner row in the table above, other
  files should link to it instead of copying paragraphs.
- **Separate current from future.** Unimplemented ideas stay in `.plans/` or
  direction sections until the code ships.
- **Promote on acceptance.** When a plan decision becomes stable truth, move it
  into `.docs/` and trim the plan.
- **Keep agents thin.** `AGENTS.md` stays under ~80 lines and routes to `.docs/`.

## Monorepo boundaries

- **Protocol** defines shared types and schemas; no filesystem or Commander deps.
- **Core** owns engine semantics; no terminal rendering.
- **Display** owns formatting helpers; no Commander or OpenTUI.
- **UI** owns interactive selection; compiles back to explicit candidate IDs.
- **CLI app** wires flags, handlers, and stdout; delegates engine work to core.
- **Rust crates** experiment behind the same external contract; JS remains the
  reference engine until parity is proven.

## Quality gate

Before merge or publish:

- `bun run check` — format, lint, typecheck, and tests (Turborepo).
- `bun run build` — bundle to `apps/cli/dist/sweep.js` and `apps/cli/dist/sweep-ui.js`.
- `bun run preflight` — publish guardrails (also runs on `prepublishOnly`).
- Rust path changes: `bun run rust:check`.
