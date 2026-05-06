# `.docs`

This directory is for durable internal project truth.

## What belongs here

- Current architecture and responsibility boundaries
- Stable product direction and decision logs
- Tooling source-of-truth commands
- Current config behavior and naming

## Rules

- Keep `.docs/` factual and current.
- Update `.docs/` when implementation changes make a stable fact obsolete.
- Do not store active implementation checklists here; those belong in `.plans/`.
- Link to `.reference/` when a reference influenced a decision, but keep final
  repo truth here.
