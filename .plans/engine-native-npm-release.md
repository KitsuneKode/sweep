# Engine native npm release

- **Status:** in_progress
- **Scope:** engine
- **Created:** 2026-06-13
- **Updated:** 2026-06-13
- **Commit:** uncommitted

## Goal

Ship `sweep-engine` via Turbo-style optional platform npm packages so
`--engine rust` works after `npm install @kitsunekode/sweep`.

## Layout

| Path                                          | Role                                                               |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `packages/core/src/native-platforms.ts`       | Platform ids, npm names, cargo targets                             |
| `packages/core/src/rust-engine.ts`            | Runtime binary resolution + subprocess                             |
| `packages/engine-native/`                     | Pack / verify scripts (private workspace)                          |
| `native-packages/`                            | Per-platform `package.json` templates + packed `bin/` (gitignored) |
| `scripts/sync-engine-versions.ts`             | Lock optionalDep versions to root                                  |
| `scripts/publish-release.ts`                  | Native publish → prepublish → changeset publish                    |
| `.github/workflows/native-engine-release.yml` | Matrix build + artifact merge                                      |
| `.github/workflows/release.yml`               | Calls native workflow, then changesets                             |

## Phases

| Phase              | Status      | Notes                                              |
| ------------------ | ----------- | -------------------------------------------------- |
| Runtime resolution | done        | `sweepPackageRoot`, optional deps, `cwd` fix       |
| Pack tooling       | done        | `engine:pack`, templates                           |
| Version sync       | done        | `sync-engine-versions`, root optionalDependencies  |
| CI publish         | done        | Matrix workflow + `publish-release.ts`             |
| Rust parity        | in_progress | Config forwarding done; tree sizing + apply remain |

## Known Rust parity gaps (non-blocking for npm scaffold)

- Directory size estimates use metadata in Rust, not full tree `du` (byte estimates may differ)
- `apply` parity incomplete per `monorepo-overhaul.md`

Do not change default engine to `auto` until contract tests pass on published binaries.

## Invariants

- Never add `"."` to `workspaces.packages` while root scripts call `turbo run *`
- Do not add `native-packages/*` to Bun workspaces
