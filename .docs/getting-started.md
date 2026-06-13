# Getting Started (Contributors)

## Prerequisites

- [Bun](https://bun.sh) 1.3+ (matches `packageManager` in root `package.json`)
- Node.js ≥ 18 (for preflight smoke tests and `npm link` consumers)
- Rust toolchain (only if editing `crates/`)

## Install

```bash
git clone https://github.com/KitsuneKode/sweep.git
cd sweep
bun install --frozen-lockfile
```

## Daily development

```bash
# Run CLI from source (no build)
bun run dev -- --help
bun run dev -- scan . --dry-run

# Full quality gate
bun run check

# Production bundle
bun run build
node dist/sweep.js --version
```

See [.docs/tooling.md](tooling.md) for the full command reference.

## Link and try globally

Use this when you want the real `sweep` binary on your PATH while hacking on
the repo.

```bash
# From the repo root, after install
bun run build          # ensures dist/sweep.js exists
npm link               # registers @kitsunekode/sweep globally

# In any project directory
sweep --version
sweep scan . --dry-run
sweep ui .             # requires a TTY

# When finished
npm unlink -g @kitsunekode/sweep
# or from the repo root: npm unlink
```

### Link troubleshooting

| Symptom                               | Fix                                                      |
| ------------------------------------- | -------------------------------------------------------- |
| `sweep: command not found` after link | Ensure npm global bin is on your `PATH`                  |
| Stale behavior after edits            | Re-run `bun run build` — linked CLI runs `dist/sweep.js` |
| OpenTUI errors in `sweep ui`          | Build first; UI ships as `dist/sweep-ui.js`              |
| Want source without linking           | Use `bun run dev -- <args>` instead                      |

### Unlink

```bash
# Remove global link to this checkout
npm unlink -g @kitsunekode/sweep

# Reinstall the published package if needed
npm install -g @kitsunekode/sweep
```

## Rust workspace (optional)

```bash
cargo test --workspace
cargo clippy --workspace -- -D warnings
```

## Before opening a PR

```bash
bun run check
bun run build
bun run preflight
```

CI runs `turbo run //#quality --affected`, `turbo run build`, and preflight on
every push (see `.github/workflows/ci.yml`).
