# Tooling

## Source-of-truth commands

Root `package.json` delegates to Turborepo. Task logic lives in workspace
packages (`apps/cli`, `packages/*`).

### Quality gate (run before merge)

```bash
bun run check          # turbo: fmt + lint + test + typecheck (all packages)
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

**Do not** add `native-packages/*` to Bun workspaces — they are publish-time
artifacts only.

## Turborepo

`turbo.json` defines the task graph:

- `transit` — dependency-order cache invalidation without blocking on `^build`
  (each package defines `"transit": "exit 0"` so `^transit` resolves in the graph)
- `build` — depends on `^build`; `apps/cli` outputs `dist/**` (see `scripts/bundle.ts`)

The published npm package is `@kitsunekode/sweep` in `apps/cli`. The private root
(`sweep-monorepo`) must **not** be listed in `workspaces.packages` (never add `"."`).
Root `package.json` scripts are orchestrators (`turbo run build`, etc.).

- `typecheck`, `lint`, `fmt` — depend on `transit`
- `test` — depends on `transit` and `^build` (CLI bundle for integration tests)
- `check` — aggregates `fmt`, `lint`, `test`, `typecheck`
- `check:affected` — same gate, only packages/tasks affected by git changes
  (`turbo run check --affected`; optional `--affected-base=origin/main` in CI)
- Rust engine tasks (`//#engine:build`, `//#rust:fmt`, etc.) cache per `crates/**`
  inputs instead of busting all JS tasks via `globalDependencies`

Package-specific overrides live in per-package `turbo.json` files (e.g.
`apps/cli` for bundle inputs/outputs,
`packages/integration-tests` for fixture paths and `//#engine:build:debug`).

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
