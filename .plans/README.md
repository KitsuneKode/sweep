# `.plans`

This directory is the working home for implementation plans.

## Structure

- `TODO.md` — backlog and current execution order
- `overhaul-roadmap.md` — completed P0–P6 overhaul (source of truth for roadmap status)
- `*.md` — scoped plans that live directly in this directory
- `<scope>/` — focused plan folders when a effort spans multiple files (e.g.
  `daily-driver-overhaul/`)

Avoid nested `active/` or `archive/` directories unless the number of plans
eventually makes the flat structure hard to scan.

## Naming

Use clear scoped names:

- `repo-context-cleanup.md`
- `product-architecture-roadmap.md`
- `engine-protocol-v1.md`
- `ui-selection-model.md`

Prefer scope-first names so related plans stay grouped naturally in directory
sorting.

## Required plan metadata

Every plan file should start with:

- `Status:` `planned`, `in_progress`, `done`, or `superseded`
- `Scope:` short area label such as `repo`, `product`, `protocol`, `engine`, `ui`
- `Created:` `YYYY-MM-DD`
- `Updated:` `YYYY-MM-DD`
- `Commit:` commit SHA when landed, otherwise `uncommitted`

## Rules

- Keep plans implementation-ready and decision-complete.
- Put the execution state in the plan itself instead of relying on folder names.
- Update `Status`, `Updated`, and `Commit` when work lands.
- Do not use `.plans/` as the long-term source of truth for stable repo facts.
- When a plan decision becomes durable project truth, promote it into `.docs/`.
- Link from `TODO.md` to plan files instead of duplicating large plan content.
