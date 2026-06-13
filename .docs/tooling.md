# Tooling

## Source-of-truth commands

### Quality gate (preferred before merge)

- `bun run check` — alias for `bun run quality`; runs Turborepo `//#quality`
  (format, lint, tests, and workspace typechecks)

### Format and lint

- `bun run fmt` — format `apps`, `packages`, `tests`, `scripts` with `oxfmt`
- `bun run lint` — lint the same tree with `oxlint`
- `bun run lint:fix` — auto-fix where supported

### Typecheck and test

- `bun run typecheck` — `turbo run typecheck` across workspaces
- `bun run test` — `bun test tests` (root integration suite)
- `bun run test:watch` — watch mode for tests

### Build and publish

- `bun run dev` — run CLI from source (`apps/cli/src/bin.ts`)
- `bun run build` — `turbo run build`; bundles to `dist/sweep.js` and `dist/sweep-ui.js`
- `bun run preflight` — publish guardrails (dist smoke tests, package.json checks)
- `bun run pack:preview` — `npm pack --dry-run`

### Rust (when editing `crates/`)

- `cargo test --workspace`
- `cargo clippy --workspace -- -D warnings`

## Turborepo

`turbo.json` defines the task graph:

- `build` — depends on `^build`; outputs `dist/**`
- `typecheck`, `lint`, `test` — depend on `topo`
- `//#quality` — root fmt, lint, test, plus all workspace typechecks

CI runs affected quality checks:

```bash
bunx turbo run //#quality --affected
bunx turbo run build
```

See `.github/workflows/ci.yml` and `.github/workflows/rust.yml`.

## Notes

- Agent-facing docs should use `bun run test`, not bare `bun test` without the
  `tests` path, when documenting the canonical command.
- The repo uses Bun workspaces (`apps/*`, `packages/*`) and Turborepo for
  orchestration and caching.
- `oxfmt` and `oxlint` are the formatters and linters; Biome is not in use.
- README remains user-facing; internal tooling policy lives here and in
  `AGENTS.md`.
- Local dev and `npm link` workflow: [.docs/getting-started.md](getting-started.md)
