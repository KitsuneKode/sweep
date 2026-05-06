# Product Direction

`sweep` aims to become a trust-first artifact cleanup tool.

## Core promise

- Safe enough to trust for destructive cleanup
- Fast enough to feel immediate
- Clear enough that both humans and automation understand what will happen

## Product stance

- Keep `sweep` as the public package.
- Make the automation/programmatic surface the center of the product.
- Treat richer interaction as a first-class mode layered on top, not a separate
  unrelated tool.
- Keep one product surface and one shared engine/planner model even as CLI and
  UI become richer.

## Primary use cases

- Safe scripted cleanup for developers, CI, and agents.
- Human review and selective cleanup when a full-screen UI is worth it.
- Monorepo and project-tree artifact cleanup that feels trustworthy instead of
  blunt.

## Desired user reactions

- "This is the cleanup tool I trust."
- "I can use this safely in scripts or as an agent."
- "When I need review and selection, the UI helps instead of getting in my way."

## UI direction

- Future UI stays cleanup-first.
- Search, filtering, grouping, risk review, and selection ergonomics matter.
- The UI should not turn into a generic disk browser.
- Search should be fast over structured candidate fields and selection should
  feel immediate.

## Interaction model direction

- Plain `sweep` should feel alive immediately in a TTY.
- `sweep ui` is the explicit richer interaction entrypoint.
- The CLI and UI should share the same candidate, planner, risk, and apply
  semantics.
