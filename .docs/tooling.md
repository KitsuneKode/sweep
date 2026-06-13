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
cargo build -p sweep-engine-cli   # produces target/debug/sweep-engine
cargo test --workspace
cargo clippy --workspace -- -D warnings
```

## Turborepo

`turbo.json` defines the task graph:

- `transit` — dependency-order cache invalidation without blocking on `^build`
- `build` — depends on `^build`; outputs root `dist/**`
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
