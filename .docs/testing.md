# Testing

How sweep tests are organized, how to run them locally, and how to exercise
interactive behavior (prompts, TUI) without guessing.

## Layout

| Location                          | What runs there                                                         |
| --------------------------------- | ----------------------------------------------------------------------- |
| `packages/core/src/*.test.ts`     | Config, scanner, guardrails, planner, engine, plan validation           |
| `packages/core/test-support/`     | Shared fixture seeding for core engine tests                            |
| `packages/protocol/src/*.test.ts` | Protocol types and shapes                                               |
| `packages/display/src/*.test.ts`  | Formatting and grouping helpers                                         |
| `packages/ui/src/*.test.ts`       | TUI state machine                                                       |
| `apps/cli/src/*.test.ts`          | Exit codes, `makeProgram()` factory                                     |
| `tests/integration/`              | Cross-package CLI, build, engine contract, seed script                  |
| `tests/fixtures/*/`               | Golden engine contract fixtures (`request.json` + `expected.plan.json`) |
| `tests/support/`                  | Helpers shared by integration tests (e.g. plan normalization)           |
| `crates/**`                       | Rust unit tests + `parity.rs` (cargo)                                   |

**Rule of thumb:** unit tests live next to the code they cover; `tests/` is only
for integration and engine parity.

## Commands

```bash
# Full gate (all workspace packages + integration)
bun run check

# Everything that has a test script
bun run test

# Single package
cd packages/core && bun test
cd apps/cli && bun test

# Integration only (from repo root)
cd packages/integration-tests && bun run test

# Rust
cargo test --workspace
```

Integration tests that invoke the bundled CLI require a prior build:

```bash
bun run build   # dist/sweep.js
bun run test
```

Turbo wires this via `test` → `dependsOn: ["^build"]`.

## Engine contract fixtures

Table-driven parity between the JS scanner and (optionally) the Rust binary.

Each fixture directory under `tests/fixtures/<name>/` contains:

- `request.json` — scan options (`exact`, `selectionPolicy`, …)
- `expected.plan.json` — normalized golden `ScanPlan`

`tests/integration/engine-contract.test.ts` runs every fixture against the JS
engine. Rust cases run only when `target/debug/sweep-engine` exists (skip
otherwise — CI Rust workflow builds it).

Regenerate a golden after intentional JS plan changes:

```bash
bun run scripts/sync-fixture-trees.ts
bun run scripts/generate-parity-fixture.ts -- tests/fixtures/node_modules-only
```

## Scan engines

| `--engine`     | Behavior                                                                     |
| -------------- | ---------------------------------------------------------------------------- |
| `js` (default) | TypeScript scanner — deterministic, honors `.sweeprc` and CLI flags          |
| `rust`         | Rust subprocess when compatible; otherwise falls back to JS with a warning   |
| `auto`         | Rust when a local `sweep-engine` binary exists, with the same fallback rules |

Rust scan only applies for default config with no `.sweeprc`, no CLI pattern/ignore/depth
overrides, default selection policy, and no progressive/exact scan modes. Deletion always
uses the JS engine.

```bash
cargo build -p sweep-engine-cli
bun run dev -- scan . --engine rust
```

Set `SWEEP_ENGINE_PATH` to point at a custom binary.

## Interactive prompts

### Default `sweep` (clean)

After scan, the CLI prints a grouped plan and asks:

```text
Delete N selected items (~X)? [y/N]
```

- **Yes** → deletes selected candidates
- **No / Enter** → aborts with exit code `1`

Non-interactive / CI:

```bash
sweep /path/to/project --yes          # skip confirmation
sweep /path/to/project --dry-run      # scan + plan only, no delete
```

`apply --plan` uses the same confirmation unless `--yes` is passed.

### Manual testing in a real terminal

```bash
bun install
bun run dev -- /tmp/my-fixture-project          # prompts before delete
bun run dev -- /tmp/my-fixture-project --yes    # no prompt
bun run dev -- scan /tmp/my-fixture-project     # scan only, no delete prompt
```

Create a throwaway tree:

```bash
mkdir -p /tmp/sweep-manual/node_modules
bun run dev -- /tmp/sweep-manual
```

### Automated prompt tests

`tests/integration/cli.test.ts` pipes `n\n` on stdin and asserts exit code `1`
and that files were not deleted. Use `--yes` in other integration cases so
tests stay non-interactive.

## TUI (`sweep ui`)

Requires a real TTY. Integration tests assert it **refuses** to run when stdout
is not a TTY. Manual check:

```bash
bun run dev -- ui /path/to/project   # in an interactive terminal only
```

## CI split

| Workflow                     | When it runs                                              | What it does                                                     |
| ---------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| `.github/workflows/ci.yml`   | Every push/PR to `main`                                   | `turbo check`, `build`, `preflight` (TypeScript)                 |
| `.github/workflows/rust.yml` | Changes under `crates/**`, `Cargo.*`, `tests/fixtures/**` | `cargo fmt --check`, `cargo test`, `cargo clippy`, release build |

TypeScript quality is always gated on `main`. Rust jobs are path-filtered so
crate-only work does not block the TS pipeline unnecessarily.

## Seeded scenarios

`scripts/seed-fixture.ts` creates rich trees under `/tmp` for engine tests:

```bash
bun run scripts/seed-fixture.ts -- --scenario monorepo
```

`packages/core/test-support/fixtures.ts` wraps this for Bun tests; integration
`seed-script.test.ts` verifies the script end-to-end.
