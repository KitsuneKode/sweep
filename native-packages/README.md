# Native engine platform packages

Templates and release-time payloads for `@kitsunekode/sweep-engine-*` optional
dependencies. These directories are **not** Bun workspace members.

- `package.json` files are rewritten by `bun run engine:pack` before publish.
- `bin/` is generated at pack time and is gitignored.

See `.docs/tooling.md` for the release workflow.
