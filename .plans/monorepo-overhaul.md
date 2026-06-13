# Monorepo overhaul

- **Status:** `in_progress`
- **Scope:** `repo`
- **Created:** 2026-06-13
- **Updated:** 2026-06-13
- **Commit:** `898f14d` (branch `feat/monorepo-overhaul`, 13 scoped commits)
- **Cursor plan:** `sweep_monorepo_overhaul_11eee2d6.plan.md`

## Summary

Restructure sweep into `apps/cli` + real packages, Turborepo orchestration, Rust
engine subprocess with parity harness, publish fix, trust/UX hardening.

## Execution status

### Done (implemented, verified locally)

| Phase     | Item                                                               | Evidence                                           |
| --------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| P0        | Publish path (lazy UI, dual bundle, CI build+preflight)            | `node dist/sweep.js --help`, `tests/build.test.ts` |
| P1        | `apps/cli`, `packages/display`, workspace deps, catalogs           | `package.json` workspaces.catalog                  |
| P1        | Turborepo package tasks (`check`, `transit`, no root `//#quality`) | `turbo.json`, `bun run check` → 131 tests          |
| P1        | `makeProgram()` + handlers                                         | `apps/cli/src/cli.ts`                              |
| P1        | Rust multi-crate workspace                                         | `crates/sweep-*`                                   |
| P2        | Display UX, UI polish, Ajv plan validation, exit codes             | `tests/plan-validation.test.ts`                    |
| P3        | Parity harness (`insta`), `--engine auto\|js\|rust`                | `crates/sweep-engine-cli/tests/parity.rs`          |
| P4        | `.docs/` expansion, `AGENTS.md` rewrite                            | `.docs/workspace-layout.md`                        |
| Follow-up | Scripts in `apps/cli/scripts/`, `integration-tests` pkg            | `apps/cli/scripts/build.ts`                        |
| Follow-up | Scanner: skip `.git`, Rust rayon walk                              | `tests/scanner.test.ts`, `sweep-fs`                |

### Not done / follow-up

- [x] **Land on git** — `898f14d` on `feat/monorepo-overhaul` (13 scoped commits)
- [ ] Forward `SweepConfig` to Rust engine (`--pattern`, `--ignore`, `--depth`)
- [ ] Rust `apply_plan` implementation
- [ ] Parity fixtures `basic` and `monorepo` (currently `#[ignore]`)
- [ ] Mark plan `done` + set `Commit:` SHA after merge to `main`

## Verification (last run)

```bash
bun run check    # 20 turbo tasks, 131 tests pass
bun run build    # dist/sweep.js + sweep-ui.js
cargo test --workspace && cargo clippy --workspace -- -D warnings
```

## Why Cursor may still show “not built”

1. **No commit** — implementation exists only as working tree changes.
2. **Plan lived in `.cursor/plans/`** — repo `.plans/` had no execution record until this file.
3. **Follow-up wave** (catalogs, script moves, perf) was not added to the original Cursor plan todos.
