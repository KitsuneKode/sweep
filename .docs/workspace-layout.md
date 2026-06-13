# Workspace Layout

The repo is a Bun workspace monorepo with Turborepo orchestration. The root
package `@kitsunekode/sweep` is what gets published to npm; everything else is
internal.

## Top-level map

```
sweep/
├── apps/cli/              # Published CLI surface (bundled to dist/)
├── packages/
│   ├── core/              # Engine: config, scan, plan, apply
│   ├── protocol/          # Shared types + JSON Schema
│   ├── display/           # Terminal presentation helpers
│   ├── ui/                # OpenTUI interactive mode
│   └── typescript-config/ # Shared tsconfig
├── crates/sweep-*/        # Rust engine experiment (Cargo workspace)
├── tests/                 # Bun test suite
├── scripts/               # build, preflight, fixtures
├── dist/                  # Publish output (not committed)
├── turbo.json             # Task graph
└── package.json           # Root workspace + npm publish manifest
```

## Apps

### `apps/cli` (`@kitsunekode/sweep-cli`)

- `src/cli.ts` — Commander `makeProgram()` and global options.
- `src/bin.ts` — Node shebang entry (bundled to `dist/sweep.js`).
- `src/handlers/` — `scan`, `apply`, `clean`, `plan`, `ui`, `doctor`.
- Depends on `core`, `display`, `protocol`, and `ui`.

## Packages

| Package                                | Responsibility                                           |
| -------------------------------------- | -------------------------------------------------------- |
| `@kitsunekode/sweep-protocol`          | `ScanPlan`, `ApplyReport`, `ScanEvent`, schemas          |
| `@kitsunekode/sweep-core`              | Config resolution, guardrails, scanner, planner, cleaner |
| `@kitsunekode/sweep-display`           | Bytes formatting, spinners, progressive scan output      |
| `@kitsunekode/sweep-ui`                | OpenTUI app and selection state                          |
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

1. `apps/cli` `build` script runs `scripts/build.ts`.
2. Bun bundles `apps/cli/src/bin.ts` → `dist/sweep.js`.
3. UI entry bundles separately → `dist/sweep-ui.js` (lazy-loaded by CLI).
4. Root `package.json` `files: ["dist"]` — only `dist/` ships to npm.
5. `prepublishOnly` runs quality, build, and `scripts/preflight.ts`.

## Turborepo tasks

Root scripts delegate to Turborepo where caching helps:

- `bun run build` → `turbo run build`
- `bun run typecheck` → `turbo run typecheck`
- `bun run check` → `turbo run //#quality` (fmt, lint, test, workspace typechecks)

Per-package `lint` and `typecheck` run inside their workspaces. Root `fmt` and
`lint` still target `apps`, `packages`, `tests`, and `scripts` directly.

## Tests

- `tests/` — primary Bun test tree (config, guardrails, scan/plan/apply, UI state).
- `crates/sweep-engine-cli/tests/` — Rust CLI integration tests.
- `tests/fixtures/` and `scripts/seed-fixture.ts` — seeded parity scenarios.

## What is not published

All `apps/*` and `packages/*` workspaces are `"private": true`. Consumers install
`@kitsunekode/sweep` from npm and receive only the bundled `dist/` artifacts.
