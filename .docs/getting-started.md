# Getting Started (Contributors)

## Prerequisites

- [Bun](https://bun.sh) 1.3+ (matches `packageManager` in root `package.json`)
- Node.js ≥ 18 (for preflight smoke tests and `npm link` consumers)
- Rust toolchain (only if editing `crates/` or using `--engine rust`)

## Install

```bash
git clone https://github.com/KitsuneKode/sweep.git
cd sweep
bun install --frozen-lockfile   # required — links apps/cli and package workspaces
```

## Daily development

```bash
# Run CLI from source (no build) — note the `--` when using flags
bun run dev -- --help
bun run dev -- scan . --dry-run

# Full quality gate
bun run check

# Production bundle
bun run build
node apps/cli/dist/sweep.js --version
```

Alternatively, from `apps/cli/`:

```bash
cd apps/cli
bun run dev -- scan . --dry-run
```

See [.docs/tooling.md](tooling.md) for the full command reference.

## Link and try globally

```bash
bun run build          # ensures apps/cli/dist/sweep.js exists
bun run link:global    # registers @kitsunekode/sweep globally (from apps/cli)

sweep --version
sweep scan . --dry-run
sweep ui .             # requires a TTY

bun run unlink:global
```

### Link troubleshooting

| Symptom                                  | Fix                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `sweep: command not found` after link    | Ensure npm global bin is on your `PATH`                                      |
| Stale behavior after edits               | Re-run `bun run build` — linked CLI runs `apps/cli/dist/sweep.js`            |
| OpenTUI errors in `sweep ui`             | Build first; UI ships as `apps/cli/dist/sweep-ui.js`                         |
| `Cannot find package 'commander'` on dev | Run `bun install` at repo root (`scripts/dev.ts` retries this automatically) |
| `bun run dev` ignores your args          | Use `bun run dev -- <args>` from repo root                                   |

## Rust engine (optional)

Build the subprocess binary when working on `crates/`, then opt in explicitly:

```bash
cargo build -p sweep-engine-cli
bun run dev -- scan . --engine rust --json
```

The CLI defaults to `--engine js` for deterministic behavior. Use `--engine auto`
only when you want Rust when a local debug binary exists (or `SWEEP_ENGINE_PATH`
is set).

## Before opening a PR

```bash
bun run check
bun run build
bun run preflight
cargo test --workspace    # if you touched crates/
```
