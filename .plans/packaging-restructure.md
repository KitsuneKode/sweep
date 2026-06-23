# Packaging restructure

- **Status:** `done`
- **Scope:** `repo`
- **Created:** 2026-06-24
- **Cursor plan:** `monorepo_packaging_restructure_74a7bc43.plan.md`

## Summary

Move the published npm identity from the private repo root into `apps/cli`
(`@kitsunekode/sweep`), co-locate build output at `apps/cli/dist/`, and remove
reach-up publish wiring. Supersedes the overhaul roadmap Phase 0 claim that
"publish-at-root" is intentional.

## Before → after

| Concern                  | Before (antipattern)            | After (target)                             |
| ------------------------ | ------------------------------- | ------------------------------------------ |
| Published package        | Root `@kitsunekode/sweep`       | `apps/cli` `@kitsunekode/sweep`            |
| Root role                | Orchestrator + npm package      | Private `sweep-monorepo` orchestrator only |
| Build output             | `dist/` at repo root            | `apps/cli/dist/`                           |
| Preflight / version sync | Reach up to root `package.json` | Scoped to `apps/cli`                       |
| UI bundle                | `packages/ui` build → root dist | CLI build bundles UI source directly       |

## What stays

- Bundling private workspaces into one shippable CLI artifact.
- Native engine via `optionalDependencies` platform packages.
- `@opentui/core` as optional peer for `sweep ui`.
- Bun catalog, Turborepo, changesets.

## Execution checklist

- [x] Root `package.json` private orchestrator (`sweep-monorepo`)
- [x] `apps/cli` owns publish fields, version, `optionalDependencies`
- [x] `scripts/bundle.ts` → `apps/cli/dist/`
- [x] Remove `packages/ui` bundle build; CLI build emits both artifacts
- [x] Turbo outputs package-relative `dist/**`
- [x] `preflight`, `sync-engine-versions`, `publish-release` scoped to CLI
- [x] Root `LICENSE`; `prepack` copies README/LICENSE into `apps/cli`
- [x] Integration tests + docs updated
- [x] `bun run check`, `npm pack -w @kitsunekode/sweep --dry-run` (preflight passes except uncommitted-tree guard during WIP)

## Related completed work

The sweep Overhaul Roadmap (`sweep_overhaul_roadmap_ce1b8314`) phases P0–P6 are
**done**. This packaging pass is follow-up hygiene, not a reopening of those phases.

## Open follow-up (out of scope here)

- None — see deferred backlog in `.plans/overhaul-roadmap.md`
