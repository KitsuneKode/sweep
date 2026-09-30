# Tooling

## Source-of-truth commands

Root `package.json` delegates to Turborepo. Task logic lives in workspace
packages (`apps/cli`, `packages/*`).

### Quality gate (run before merge)

```bash
bun run check          # turbo: fmt:check + lint + test + typecheck (all packages)
bun run build          # turbo: bundle CLI → apps/cli/dist/
bun run preflight      # turbo: publish smoke tests (after build)
```

### Day-to-day

| Command                              | What it does                                            |
| ------------------------------------ | ------------------------------------------------------- |
| `bun run dev -- <args>`              | Run CLI from source via `scripts/dev.ts` (no build)     |
| `bun run build`                      | Turbo → bundle publish artifacts to `apps/cli/dist/`    |
| `cd apps/cli && bun run build:watch` | Rebuild `dist/` on source changes (prod-like testing)   |
| `bun run fmt`                        | `turbo run fmt` (per-package `oxfmt`)                   |
| `bun run lint`                       | `turbo run lint` (per-package `oxlint`)                 |
| `bun run typecheck`                  | `turbo run typecheck`                                   |
| `bun run test`                       | `turbo run test` (unit tests per package + integration) |
| `bun run clean`                      | `turbo run clean`                                       |

### Rust (when editing `crates/`)

```bash
bun run rust:check     # fmt:check + strict clippy + test (run before merge)
bun run rust:fmt       # cargo fmt --all (writes)
bun run rust:fmt-check # cargo fmt --all --check
bun run rust:lint      # cargo clippy --workspace --locked -- -D warnings
bun run rust:test      # cargo test --workspace --locked
bun run engine:build:debug        # produces target/debug/sweep-engine
bun run engine:build              # release binary
```

These route through Turborepo's **experimental Cargo workspace support**
(`futureFlags.experimentalCargoWorkspaces` + `experimentalTaskCommand`): each
crate in `crates/` is a Turbo package named after its Cargo `[package] name`,
and `[workspace.metadata] name = "sweep-rust"` in `Cargo.toml` creates the
synthetic workspace package. `sweep-rust#test` is `cargo test --workspace
--locked`, `sweep-rust#lint` is the strict clippy override (`-D warnings`),
`sweep-rust#fmt:check` is `cargo fmt --all --check`, and
`sweep-engine-cli#build` / `sweep-engine-cli#build:release` produce the debug
and release `sweep-engine` binaries. Cargo dependency edges are real graph
edges (`sweep-engine-cli#build` waits on `sweep-engine#build` etc.), so Turbo
caches per crate and inputs track only the crate plus its Cargo deps - a
`sweep-types` edit no longer busts every Rust task.

Workspace lints in `Cargo.toml` deny `clippy::unwrap_used` and
`clippy::expect_used`. Formatting uses `rustfmt.toml`; toolchain pins `rustfmt`
and `clippy` in `rust-toolchain.toml`.

#### Crate layout (not an antipattern)

The Cargo workspace is five small crates (~900 lines total today):

| Crate              | Role                                            |
| ------------------ | ----------------------------------------------- |
| `sweep-types`      | Protocol types aligned with `packages/protocol` |
| `sweep-errors`     | Structured error codes                          |
| `sweep-fs`         | Directory walk and sizing helpers               |
| `sweep-engine`     | Scan/plan/apply library (no I/O framing)        |
| `sweep-engine-cli` | Thin `sweep-engine` binary + parity tests       |

This is a normal Rust split: library vs CLI, types/errors/fs at the edges. It is
slightly more granular than a two-crate setup would require at current size, but
it is not wrong - it keeps compile boundaries clear and matches how larger CLIs
are structured. Only `sweep-engine-cli` ships to npm (via platform packages).

The five **npm** `@kitsunekode/sweep-engine-*` packages are unrelated to this -
they are per-OS binaries (Turbo-style optional deps), not extra Rust crates.

### Native engine npm packages (Turbo-style)

The Rust binary ships as optional platform packages (`@kitsunekode/sweep-engine-*`).
Root `optionalDependencies` on the CLI package are synced via `bun run sync-engine-versions`
(after `changeset version`).

| Command                                      | Purpose                                                 |
| -------------------------------------------- | ------------------------------------------------------- |
| `bun run engine:build`                       | Release build of `sweep-engine`                         |
| `bun run engine:pack -- --platform linux-64` | Pack binary into `native-packages/linux-64/`            |
| `bun run engine:verify`                      | Smoke-test local binary                                 |
| `bun run sync-engine-versions`               | Align CLI optionalDep + template versions with apps/cli |

**Runtime resolution** (`packages/core/src/rust-engine.ts`):

1. `SWEEP_ENGINE_PATH`
2. Installed optional `@kitsunekode/sweep-engine-{platform}-{arch}`
3. `target/debug` or `target/release` under repo root (dev)
4. `sweep-engine` on `PATH`

**Release CI:** `.github/workflows/release.yml` builds all five platforms, packs
artifacts, then `scripts/publish-release.ts` publishes native packages before
`@kitsunekode/sweep`. Reusable workflow: `native-engine-release.yml`.

**Do not** add `native-packages/*` to Bun workspaces - they are publish-time
artifacts only.

## Turborepo

`turbo.json` defines the task graph:

- `transit` - dependency-order cache invalidation without blocking on `^build`
  (each package defines `"transit": "exit 0"` so `^transit` resolves in the graph)
- `build` - depends on `^build`; `apps/cli` outputs `dist/**` (see `scripts/bundle.ts`)

The published npm package is `@kitsunekode/sweep` in `apps/cli`. The private root
(`sweep-monorepo`) must **not** be listed in `workspaces.packages` (never add `"."`).
Root `package.json` scripts are orchestrators (`turbo run build`, etc.).

- `typecheck`, `lint`, `fmt`, `fmt:check` - depend on `transit`
- `test` - depends on `transit` and `^build` (CLI bundle for integration tests)
- `check` - aggregates `fmt:check`, `lint`, `test`, `typecheck` (`fmt` writes;
  `fmt:check` is the read-only `oxfmt --check` variant so `check` fails CI on
  unformatted files instead of silently rewriting them)
- `check:affected` - same gate, only packages/tasks affected by git changes
  (`turbo run check --affected`; optional `--affected-base=origin/main` in CI)
- Cargo built-in task names (`build`, `test`, `check`, `lint`, `format`,
  `clean`, `dev`) collide with the JS task names - `turbo run test` unfiltered
  would run both Bun tests and `cargo test`, and would fail for contributors
  without a Rust toolchain. **Convention: root scripts always scope selection**
  - `--filter "@kitsunekode/*"` on the JS gates, explicit
    `turbo run "sweep-rust#<task>"` / `"sweep-engine-cli#build"` for Rust. Task
    `dependsOn` edges still cross languages where declared:
    `packages/integration-tests`' `test` waits on `sweep-engine-cli#build` so
    the debug engine binary exists before engine-native contract tests.
- `//#`-style root tasks are gone - the Cargo workspace packages replaced
  them. If one is ever reintroduced, remember Turbo resolves `//#name` to a
  **plain-named** root script (`name`, not `//#name`), and Turbo 2.11's loop
  detection rejects a script that calls `turbo run` back into the same task
  suffix.

Local cache eviction is on: `cacheMaxAge: 14d`, `cacheMaxSize: 10GB`. Cached
task logs are quiet (`outputLogs: "new-only"`).

The Cargo workspace flags are `futureFlags` - experimental and reversible. If
the feature is ever removed upstream, the fallback is `//#` root tasks or
direct `cargo` scripts; the `rust:*` script names should stay the public
surface either way.

**Edge cases this introduces, and how they're handled:**

- **No Rust toolchain → every turbo command fails.** Package discovery runs
  `cargo metadata` before any task or filter is evaluated, so even
  `bun run fmt` dies with `failed to run \`cargo metadata\``. The Rust
toolchain is a hard dev prerequisite (see `getting-started.md`); the
`--filter "@kitsunekode/*"` convention only scopes *which tasks run\*, not
  whether cargo must exist.
- **`devEngines` vs npm-in-repo.** npm 11+ enforces `devEngines` by walking up
  to the workspace root, so `runtime: bun` would make _every_ `npm` invocation
  inside the repo fail (`EBADDEVENGINES`) - including `npm pack` and the
  `npm publish` calls in `scripts/publish-release.ts`. Both fields therefore
  carry `onFail: "warn"`: npm prints the mismatch as a warning and proceeds,
  which keeps trusted publishing and `npm pack` working while still telling
  anyone running `npm install` they're in a Bun workspace.
- **`bun run clean` never touches `target/`.** Turbo registers no `clean`
  task on the Cargo workspace package, so `cargo clean` is deliberately
  unreachable from the JS scripts.

Package-specific overrides live in per-package `turbo.json` files (e.g.
`apps/cli` for bundle inputs/outputs,
`packages/integration-tests` for fixture paths and `sweep-engine-cli#build`).

### Bun dependency catalog

Shared third-party versions are pinned once in root `package.json` under
`workspaces.catalog`. Workspace packages reference them with `"catalog:"`:

```json
"devDependencies": {
  "typescript": "catalog:",
  "oxlint": "catalog:",
  "turbo": "catalog:"
}
```

Run `bun install` after catalog changes to refresh the lockfile.

#### Bun TypeScript types

Install `@types/bun` (recommended by Bun; shim over canonical `bun-types`).
Pin it in the catalog and add `"@types/bun": "catalog:"` to every workspace that
runs `typecheck` or `bun test`. Shared tsconfig uses `"types": ["bun"]`.

#### Publish manifests

Use `"catalog:"` only in workspace `dependencies` / `devDependencies`. Published
packages (e.g. `apps/cli`) must use **literal semver** in `peerDependencies` and
`optionalDependencies` - npm consumers do not understand `catalog:`.

CI runs (typescript job):

```bash
bunx turbo run check build preflight --filter "@kitsunekode/*" --continue
```

The rust job runs `turbo run "sweep-rust#fmt:check" "sweep-rust#lint"
"sweep-rust#test" --continue`, and the cross-platform job typechecks and
builds the CLI bundle on macOS/Windows.

See `.github/workflows/ci.yml` and `.github/workflows/native-engine-release.yml`.

Test layout, prompts, and engine parity: [.docs/testing.md](testing.md).

## Notes

- Agent-facing completion gate: `bun run check` (see `AGENTS.md`).
- The repo uses Bun workspaces (`apps/*`, `packages/*`) and Turborepo for
  orchestration and caching.
- `oxfmt` and `oxlint` are the formatters and linters.
- README remains user-facing; internal tooling policy lives here and in
  `AGENTS.md`.
- Local dev and `npm link`: [.docs/getting-started.md](getting-started.md)
