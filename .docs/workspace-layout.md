# Workspace Layout

The repo is a Bun workspace monorepo with Turborepo orchestration. The root
package `sweep-monorepo` is **private** and only orchestrates workspaces. The
published npm package is `@kitsunekode/sweep` in `apps/cli`.

## Top-level map

```
sweep/
├── apps/cli/              # Published @kitsunekode/sweep (bundled to apps/cli/dist/)
├── packages/
│   ├── core/              # Engine: config, scan, plan, apply
│   ├── engine-native/     # Native engine pack scripts (private)
│   ├── protocol/          # Shared types + JSON Schema
│   ├── display/           # Terminal presentation helpers
│   ├── ui/                # OpenTUI interactive mode (source only; bundled by CLI build)
│   └── typescript-config/ # Shared tsconfig
├── native-packages/       # Platform npm package templates (not a workspace)
├── crates/sweep-*/        # Rust engine experiment (Cargo workspace)
├── tests/                 # Bun test suite
├── scripts/               # bundle, release, fixtures
├── turbo.json             # Task graph
└── package.json           # Private root orchestrator
```

## Apps

### `apps/cli` (`@kitsunekode/sweep`)

- `src/cli.ts` — Commander `makeProgram()` and global options.
- `src/bin.ts` — Node shebang entry (bundled to `apps/cli/dist/sweep.js`).
- `src/handlers/` — `scan`, `apply`, `clean`, `plan`, `ui`, `doctor`.
- `scripts/build.ts` — produces `apps/cli/dist/sweep.js` and `apps/cli/dist/sweep-ui.js`.
- `scripts/preflight.ts` — publish guardrails for this package.
- Depends on `core`, `display`, `protocol`, and `ui`.

## Packages

| Package                                | Responsibility                                           |
| -------------------------------------- | -------------------------------------------------------- |
| `@kitsunekode/sweep-protocol`          | `ScanPlan`, `ApplyReport`, `ScanEvent`, schemas          |
| `@kitsunekode/sweep-core`              | Config resolution, guardrails, scanner, planner, cleaner |
| `@kitsunekode/sweep-engine-native`     | Pack scripts for platform npm packages (private)         |
| `@kitsunekode/sweep-display`           | Bytes formatting, spinners, progressive scan output      |
| `@kitsunekode/sweep-ui`                | OpenTUI app and selection state (bundled into CLI dist)  |
| `@kitsunekode/sweep-typescript-config` | Base `tsconfig` for workspaces                           |

## Rust workspace

| Crate              | Role                                         |
| ------------------ | -------------------------------------------- |
| `sweep-types`      | Shared Rust types aligned with protocol      |
| `sweep-errors`     | Structured error codes                       |
| `sweep-fs`         | Filesystem helpers                           |
| `sweep-engine`     | Engine library                               |
| `sweep-engine-cli` | `sweep-engine` binary for parity experiments |

CI runs Rust checks only when `crates/` or related paths change (see
`.github/workflows/rust.yml`).

## Build and publish path

Bundling is centralized in `scripts/bundle.ts` (Bun's `Bun.build()` API). The
CLI package owns all publish artifacts:

- `apps/cli/scripts/build.ts` → `apps/cli/dist/sweep.js` + `apps/cli/dist/sweep-ui.js`
- UI source lives in `packages/ui/src/` and is bundled by the CLI build (React inlined into `sweep-ui.js`; `@opentui/core` external)

`bun run build` goes through Turborepo (`apps/cli` `build` task). Implementation lives in
`scripts/bundle.ts`; `apps/cli/scripts/build.ts` is the thin wrapper the turbo graph calls.

1. UI bundle → `apps/cli/dist/sweep-ui.js` (lazy-loaded by CLI; `@opentui/core` external peer).
2. CLI bundle → `apps/cli/dist/sweep.js` (Node ESM; `./sweep-ui.js` external).
3. `apps/cli/package.json` `files: ["dist", "README.md", "LICENSE"]` — only those ship to npm (`prepack` copies README/LICENSE from repo root).
4. Optional `@kitsunekode/sweep-engine-*` platform packages ship the Rust binary.
5. `prepublishOnly` runs `turbo run check build preflight`.

## Turborepo tasks

Root scripts delegate to Turborepo where caching helps:

- `bun run build` → `turbo run build`
- `bun run typecheck` → `turbo run typecheck`
- `bun run check` → `turbo run check` (fmt, lint, test, typecheck)

Per-package `lint`, `fmt`, and `typecheck` run inside their workspaces via
turbo. Root `bun run test` runs the integration test package against `tests/`.

## Tests

- `tests/integration/` — cross-package CLI, build, engine contract, and seed-script tests.
- `packages/*/src/*.test.ts` and `apps/cli/src/*.test.ts` — colocated unit tests per package.
- `crates/sweep-engine-cli/tests/` — Rust CLI integration tests.
- `tests/fixtures/` and `scripts/seed-fixture.ts` — seeded parity scenarios.

## What is not published

All workspaces except `apps/cli` are `"private": true`. Consumers install
`@kitsunekode/sweep` from npm and receive the bundled `apps/cli/dist/` artifacts
plus an optional native engine package for their OS/arch when supported.
