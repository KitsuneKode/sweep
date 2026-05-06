# Repo Context Cleanup

Status: done
Scope: repo
Created: 2026-05-06
Updated: 2026-05-06
Commit: uncommitted

## Goal

Reduce context waste, assign clear ownership to internal docs, and make sure
project and product direction is written down in the repo instead of living only
in chat history.

## Decisions Locked

- `AGENTS.md` is a thin router, not a project brain.
- `CLAUDE.md` is a symlink to `AGENTS.md`.
- `.plans/` owns implementation planning and execution state.
- `.docs/` owns stable internal project truth.
- `.reference/` owns supporting material and upstream references.
- Plan files should encode status and timestamps directly instead of depending
  on `active/` and `archive/` folders.

## Steps

1. Replace the bloated root `AGENTS.md` with a short routing guide.
2. Create the hidden doc directories and their ownership readmes.
3. Capture current architecture, product direction, config behavior, tooling,
   and locked decisions in `.docs/`.
4. Add scoped plan files and a root backlog in `.plans/`.
5. Align docs with the real toolchain and current config implementation.

## Verification

- `CLAUDE.md` resolves to `AGENTS.md`.
- `AGENTS.md` stays concise and points outward.
- Internal docs no longer claim Biome is part of the current workflow.
- The repo has one obvious home for backlog, durable truth, and references.
- `.plans/` works as a flat scoped plan registry with status metadata in-file.
- The internal workspace split now exists and the docs point at the real
  package layout.
