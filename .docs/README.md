# `.docs`

This directory is for durable internal project truth.

## What belongs here

- Current architecture and responsibility boundaries
- Workspace layout and package map
- Engineering principles and documentation ownership
- Stable product direction and decision logs
- Tooling source-of-truth commands
- Current config behavior and naming
- Contributor onboarding (`getting-started.md`)

## Index

| Document                                               | Purpose                                       |
| ------------------------------------------------------ | --------------------------------------------- |
| [architecture.md](architecture.md)                     | Layering, data flow, long-term decisions      |
| [workspace-layout.md](workspace-layout.md)             | Directory map, packages, build/publish path   |
| [engineering-principles.md](engineering-principles.md) | Priorities and single-source-of-truth table   |
| [product-direction.md](product-direction.md)           | Product intent and UX stance                  |
| [config.md](config.md)                                 | Implemented config resolution                 |
| [ux-principles.md](ux-principles.md)                   | TUI design contract (keys, safety, streaming) |
| [release.md](release.md)                               | npm + standalone binary distribution          |
| [tooling.md](tooling.md)                               | Commands, Turborepo, CI                       |
| [getting-started.md](getting-started.md)               | Install, dev, `npm link`                      |
| [decision-log.md](decision-log.md)                     | Locked decisions with dates                   |

## Rules

- Keep `.docs/` factual and current.
- Update `.docs/` when implementation changes make a stable fact obsolete.
- Do not store active implementation checklists here; those belong in `.plans/`.
- Link to `.reference/` when a reference influenced a decision, but keep final
  repo truth here.
