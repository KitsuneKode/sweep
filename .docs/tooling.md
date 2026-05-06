# Tooling

## Source-of-truth commands

- `bun run fmt` — format with `oxfmt`
- `bun run lint` — lint with `oxlint`
- `bun run typecheck` — `tsc --noEmit`
- `bun run test` — test suite
- `bun run build` — bundle CLI to `dist/sweep.js`
- `bun run preflight` — publish checks

## Notes

- Agent-facing docs should use `bun run test`, not `bun test`.
- The repo is already on `oxfmt` and `oxlint`.
- The repo now uses Bun workspaces for the internal package split.
- `turbo.json` and the Cargo workspace are scaffolded for the next architecture
  phase, but the root scripts still run directly for now.
- README remains user-facing; internal tooling policy should live here and in
  the root `AGENTS.md`.
