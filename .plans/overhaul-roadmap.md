# sweep Overhaul Roadmap

- **Status:** `done`
- **Scope:** `repo`
- **Created:** 2026-06-13
- **Updated:** 2026-06-24
- **Commit:** landed on `main`
- **Cursor plan:** `sweep_overhaul_roadmap_ce1b8314.plan.md` (superseded by this file)

## Goal

Trustworthy, fast, cross-platform artifact cleanup with a polished TUI, streaming scan
engine, sharp CLI UX, and a Rust subprocess that honors the same protocol contract.

## Phase status

| Phase | Scope            | Status | Notes                                                                                                              |
| ----- | ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| P0    | Monorepo hygiene | Done   | `lint-staged`, turbo fixture paths, workspace dep cleanup; publish moved to `apps/cli` (see packaging-restructure) |
| P1    | Trust & safety   | Done   | Apply containment (JS + Rust), Windows guardrails/junctions, `blocked` tier via protected VCS paths                |
| P2    | Streaming engine | Done   | Async scanner + hooks, async cleaner pool, batched `du`, `large-stream` benchmark, abort during sizing             |
| P3    | React TUI        | Done   | `app.tsx` on `@opentui/react`, tests, risk filter, help overlay, dangerous/blocked selection guards                |
| P4    | CLI UX           | Done   | Shared handlers, `--json`/`--quiet`/`--verbose`, doctor `EXIT.WARN`, global error handlers, no double-print        |
| P5    | Rust parity      | Done   | Guardrails, streaming NDJSON, exact sizing, batched `du`, `SweepConfig` forwarding, apply containment tests        |
| P6    | Daily-driver     | Done   | `sweep init`, `sweep clean`, richer doctor/help, docs refresh, optional-peer install story                         |

## Post-roadmap enhancements (also landed)

- Workspace `node_modules` stub detection and cleaner scan display (`candidate-insights`)
- Repo `.sweeprc` ignores `tests/fixtures` and `apps/cli/dist` for dogfooding

## Deferred backlog (not blocking roadmap completion)

| Item                                                                  | Why deferred                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| Default engine `auto` when published Rust binaries are verified in CI | Trust: JS remains default (`--engine js`)                    |
| Schema codegen as single source of truth for Rust + TS                | Hand-maintained schemas still pass contract tests            |
| Windows CI contract matrix                                            | Guardrails implemented; no dedicated Windows runner yet      |
| Desktop-scale memory caps / spill-to-disk streaming                   | Benchmark exists; no hard memory ceiling product requirement |
| Rust apply concurrent deletes                                         | Sequential apply is correct; JS uses bounded pool            |

## Verification

```bash
bun run check
bun run rust:check
bun run build
bun run preflight
```

## Related plans

- [`.plans/packaging-restructure.md`](packaging-restructure.md) — publish layout (done)
- [`.plans/monorepo-overhaul.md`](monorepo-overhaul.md) — superseded by this roadmap
- [`.plans/engine-native-npm-release.md`](engine-native-npm-release.md) — native engine npm scaffold (done; parity follow-ups in deferred backlog)
