# Getting Started (Contributors)

## Prerequisites

- [Bun](https://bun.sh) 1.4.2+ (matches `devEngines` in root `package.json`)
- Node.js ≥ 18 (preflight, `npm link`, and bounded JS enumeration under Bun)
- Rust toolchain (via rustup - `rust-toolchain.toml` pins stable + rustfmt +
  clippy). Required, not optional: Turborepo runs `cargo metadata` while
  discovering the Cargo workspace, so **every** `turbo run …` command - even
  the JS-only gates - fails without `cargo` on `PATH`.

## Install

```bash
git clone https://github.com/KitsuneKode/sweep.git
cd sweep
bun install --frozen-lockfile   # required - links apps/cli and package workspaces
```

For repeated local installs, Bun documents an optional shared virtual store:

```toml
# bunfig.toml (local opt-in)
[install]
linker = "isolated"
globalStore = true
```

See [Bun's global store](https://bun.com/docs/pm/global-store). This changes
dependency installation/storage, not traversal or UI latency. Workspace,
patched and lifecycle-script dependencies can remain local. The repo does not
enable it globally: qualify the install layout and shared cache on your machine
before changing CI or deleting existing node_modules. No HTTP or SQLite runtime
has been added for install or startup optimization.

## Daily development

```bash
# Run CLI from source (no build) - pass args after --
bun run dev -- --help
bun run dev -- scan . --dry-run

# Interactive UI (requires a real TTY + Bun; loads packages/ui from source)
bun run dev -- ui .

# Production-like CLI (bundled output - needed for node-only smoke tests)
bun run build
node apps/cli/dist/sweep.js --version

# Full quality gate
bun run check

# Rebuild bundles on file changes (only when testing dist/ artifacts)
cd apps/cli && bun run build:watch
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
| Stale behavior after edits               | Re-run `bun run build` - linked CLI runs `apps/cli/dist/sweep.js`            |
| OpenTUI errors in `sweep ui`             | Build first; UI ships as `apps/cli/dist/sweep-ui.js`                         |
| `Cannot find package 'commander'` on dev | Run `bun install` at repo root (`scripts/dev.ts` retries this automatically) |
| `bun run dev` ignores your args          | Use `bun run dev -- <args>` from repo root                                   |

## Rust engine (optional)

Build the subprocess binary when working on `crates/`, then opt in explicitly:

```bash
cargo build -p sweep-engine-cli
bun run dev -- scan . --engine rust --json
```

The CLI defaults to `--engine auto`: an available Rust binary is preferred,
otherwise it uses JS. Use `--engine js` to explicitly choose the reference
engine, or `--engine rust` to require the native engine.

## Before opening a PR

```bash
bun run check
bun run build
bun run preflight
cargo test --workspace    # if you touched crates/
```
