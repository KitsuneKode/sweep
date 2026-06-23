# Engine native npm release

- **Status:** `done`
- **Scope:** engine
- **Created:** 2026-06-13
- **Updated:** 2026-06-24
- **Commit:** landed on `main`

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

| Phase              | Status | Notes                                                                                                  |
| ------------------ | ------ | ------------------------------------------------------------------------------------------------------ |
| Runtime resolution | done   | `sweepPackageRoot`, optional deps, `cwd` fix                                                           |
| Pack tooling       | done   | `engine:pack`, templates                                                                               |
| Version sync       | done   | `sync-engine-versions`, root optionalDependencies                                                      |
| CI publish         | done   | Matrix workflow + `publish-release.ts`                                                                 |
| Rust parity        | done   | Config, streaming, exact sizing, apply containment; byte-estimate drift documented in deferred backlog |

## Deferred (non-blocking)

- Directory size estimates may differ slightly between JS batched `du` and Rust metadata fallbacks
- Default engine stays `js` until published-binary CI verification is automated

## Invariants

- Never add `"."` to `workspaces.packages` while root scripts call `turbo run *`
- Do not add `native-packages/*` to Bun workspaces
