# Native platform packages

Templates and release-time payloads for optional platform dependencies.
These directories are **not** Bun workspace members.

Two flows share this folder (separate subnamespaces — ids would collide):

- `native-packages/<engine-id>/package.json` — `@kitsunekode/sweep-engine-*`
  Rust engine binaries. Rewritten by `bun run engine:pack`; `bin/` generated
  and gitignored. Published by `.github/workflows/native-engine-release.yml`.
- `native-packages/cli/<id>/package.json` — `@kitsunekode/sweep-<id>`
  standalone CLI executables. Rewritten by
  `packages/cli-native/scripts/pack.ts`; `bin/` generated and gitignored.
  Built/published by `.github/workflows/cli-binaries.yml`.

See `.docs/tooling.md` and `.docs/release.md` for the release workflows.
