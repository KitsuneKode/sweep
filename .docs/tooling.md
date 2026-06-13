# Tooling

## Source-of-truth commands

Root `package.json` delegates to Turborepo. Task logic lives in workspace
packages (`apps/cli`, `packages/*`).

### Quality gate (run before merge)

```bash
bun run check          # turbo: fmt + lint + test + typecheck (all packages)
bun run build          # turbo: bundle CLI → dist/
bun run preflight      # turbo: publish smoke tests (after build)
```

### Day-to-day

| Command                 | What it does                                            |
| ----------------------- | ------------------------------------------------------- |
| `bun run dev -- <args>` | Run CLI from source (`apps/cli/src/bin.ts`)             |
| `bun run fmt`           | `turbo run fmt` (per-package `oxfmt`)                   |
| `bun run lint`          | `turbo run lint` (per-package `oxlint`)                 |
| `bun run typecheck`     | `turbo run typecheck`                                   |
| `bun run test`          | `turbo run test` (unit tests per package + integration) |
| `bun run clean`         | `turbo run clean`                                       |

### Rust (when editing `crates/`)

```bash
bun run rust:check     # fmt --check + clippy + test (run before merge)
bun run rust:fmt       # cargo fmt --all
bun run rust:lint      # cargo clippy --workspace -- -D warnings
bun run rust:test      # cargo test --workspace
cargo build -p sweep-engine-cli   # produces target/debug/sweep-engine
cargo build --release -p sweep-engine-cli
```

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
it is not wrong — it keeps compile boundaries clear and matches how larger CLIs
are structured. Only `sweep-engine-cli` ships to npm (via platform packages).

The five **npm** `@kitsunekode/sweep-engine-*` packages are unrelated to this —
they are per-OS binaries (Turbo-style optional deps), not extra Rust crates.

### Native engine npm packages (Turbo-style)

The Rust binary ships as optional platform packages (`@kitsunekode/sweep-engine-*`).
Root `optionalDependencies` versions are synced via `bun run sync-engine-versions`
(after `changeset version`).

| Command                                      | Purpose                                         |
| -------------------------------------------- | ----------------------------------------------- |
| `bun run engine:build`                       | Release build of `sweep-engine`                 |
| `bun run engine:pack -- --platform linux-64` | Pack binary into `native-packages/linux-64/`    |
| `bun run engine:verify`                      | Smoke-test local binary                         |
| `bun run sync-engine-versions`               | Align optionalDep + template versions with root |

**Runtime resolution** (`packages/core/src/rust-engine.ts`):

1. `SWEEP_ENGINE_PATH`
2. Installed optional `@kitsunekode/sweep-engine-{platform}-{arch}`
3. `target/debug` or `target/release` under repo root (dev)
4. `sweep-engine` on `PATH`

**Release CI:** `.github/workflows/release.yml` builds all five platforms, packs
artifacts, then `scripts/publish-release.ts` publishes native packages before
`@kitsunekode/sweep`. Reusable workflow: `native-engine-release.yml`.

**Do not** add `native-packages/*` to Bun workspaces — they are publish-time
artifacts only.

## Turborepo

`turbo.json` defines the task graph:

- `transit` — dependency-order cache invalidation without blocking on `^build`
- `build` — depends on `^build`; outputs root `dist/**`

**Important:** The published npm package lives at the repo root (`@kitsunekode/sweep`),
but it must **not** be listed in `workspaces.packages` (never add `"."`). Root
`package.json` scripts are orchestrators (`turbo run build`, etc.). If turbo
treats the root as a workspace package, each `build` spawns another `turbo run
build` and forks until the machine runs out of processes.

- `typecheck`, `lint`, `fmt` — depend on `transit`
- `test` — depends on `transit` and `^build` (CLI bundle for integration tests)
- `check` — aggregates `fmt`, `lint`, `test`, `typecheck`

CI runs:

```bash
bunx turbo run check --affected
bunx turbo run build
bunx turbo run preflight
```

See `.github/workflows/ci.yml` and `.github/workflows/rust.yml`.

Test layout, prompts, and engine parity: [.docs/testing.md](testing.md).

## Notes

- Agent-facing completion gate: `bun run check` (see `AGENTS.md`).
- The repo uses Bun workspaces (`apps/*`, `packages/*`) and Turborepo for
  orchestration and caching.
- `oxfmt` and `oxlint` are the formatters and linters.
- README remains user-facing; internal tooling policy lives here and in
  `AGENTS.md`.
- Local dev and `npm link`: [.docs/getting-started.md](getting-started.md)
