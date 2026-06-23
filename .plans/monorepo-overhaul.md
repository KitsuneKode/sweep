# Monorepo overhaul

- **Status:** `superseded`
- **Scope:** `repo`
- **Created:** 2026-06-13
- **Updated:** 2026-06-24
- **Commit:** landed on `main` (see subsequent overhaul + packaging commits)
- **Superseded by:** `.plans/packaging-restructure.md`, sweep Overhaul Roadmap (P0–P6)

## Summary

Restructure sweep into `apps/cli` + real packages, Turborepo orchestration, Rust
engine subprocess with parity harness, publish fix, trust/UX hardening.

This plan is **complete**. Packaging follow-up moved the published npm identity
from the repo root into `apps/cli` — see `.plans/packaging-restructure.md`.

## Execution status (final)

| Phase     | Item                                                     | Status |
| --------- | -------------------------------------------------------- | ------ |
| P0        | Publish path (lazy UI, dual bundle, CI build+preflight)  | Done   |
| P1        | `apps/cli`, `packages/display`, workspace deps, catalogs | Done   |
| P1        | Turborepo package tasks (`check`, `transit`)             | Done   |
| P1        | `makeProgram()` + handlers                               | Done   |
| P1        | Rust multi-crate workspace                               | Done   |
| P2        | Display UX, UI polish, Ajv plan validation, exit codes   | Done   |
| P3        | Parity harness (`insta`), `--engine auto\|js\|rust`      | Done   |
| P4        | `.docs/` expansion, `AGENTS.md` rewrite                  | Done   |
| Follow-up | Scripts in `apps/cli/scripts/`, `integration-tests` pkg  | Done   |
| Follow-up | Scanner: skip `.git`, Rust rayon walk                    | Done   |
| Packaging | Published package in `apps/cli`, `apps/cli/dist/`        | Done   |

## Remaining follow-up (not part of this plan)

- [ ] Forward `SweepConfig` to Rust engine (`--pattern`, `--ignore`, `--depth`)

## Verification (last run)

```bash
bun run check
bun run build    # apps/cli/dist/sweep.js + sweep-ui.js
bun run rust:check
```
