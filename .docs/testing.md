# Testing

How sweep tests are organized, how to run them locally, and how to exercise
interactive behavior (prompts, TUI) without guessing.

## Layout

| Location                          | What runs there                                                         |
| --------------------------------- | ----------------------------------------------------------------------- |
| `packages/core/src/*.test.ts`     | Config, scanner, guardrails, planner, engine, plan validation           |
| `packages/test-fixtures/src/`     | Shared fixture seeding for core and integration tests                   |
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
bun run build   # apps/cli/dist/sweep.js
bun run test
```

Turbo wires this via `test` → `dependsOn: ["^build"]`.

> [!WARNING]
> Never run bare `tsc -b` in this repo. The package typecheck is `tsc
--noEmit`; a bare build emits `.js` next to each `.ts` source, Bun resolves
> the stale `.js` over your edits, and `bun test` double-registers every
> compiled `*.test.js`. Symptoms: changes "not taking" in tests, or test
> counts doubling. Clean up by deleting untracked `.js` that have a `.ts`
> sibling.

## Engine contract fixtures

Table-driven parity between the JS scanner and (optionally) the Rust binary.

Each fixture directory under `tests/fixtures/<name>/` contains:

- `request.json` - scan options (`exact`, `selectionPolicy`, …)
- `expected.plan.json` - normalized golden `ScanPlan`

`tests/integration/engine-contract.test.ts` runs every fixture against the JS
engine. Rust cases run only when `target/debug/sweep-engine` exists (skip
otherwise - CI Rust workflow builds it).

Regenerate a golden after intentional JS plan changes:

```bash
bun run scripts/sync-fixture-trees.ts
bun run scripts/generate-parity-fixture.ts -- tests/fixtures/node_modules-only
```

## Scan engines

| `--engine`       | Behavior                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `auto` (default) | Rust when a `sweep-engine` binary resolves, otherwise JS - no flags needed                 |
| `rust`           | Rust subprocess; honors `.sweeprc` and CLI scan flags (`--pattern`, `--ignore`, `--depth`) |
| `js`             | TypeScript scanner - deterministic, honors `.sweeprc` and CLI flags                        |

Rust scan uses the native engine for progressive hooks (`onEntry` / `onEntrySized`) and exact
sizing when the `sweep-engine` binary is available. `apply` resolves the same way; `--trash`
always runs on the JS engine (Rust apply has no trash support) with a warning when it has to
fall back.

```bash
cargo build -p sweep-engine-cli
bun run dev -- scan . --engine rust
```

Set `SWEEP_ENGINE_PATH` to point at a custom binary.

### Engine A/B comparison

Inside `sweep ui`, `E` swaps the scan engine and rescans the same tree in place.
The completion notice reports the new engine's time against the previous run
(`rust 273ms vs js 311ms`), and the header chip keeps the active engine's last
duration (`rust·263ms`). `E` is global but never fires while a text field owns
the keyboard.

For repeatable numbers outside the TUI:

```bash
bun run bench                                    # every tests/fixtures/ tree
bun run bench -- path/to/tree --runs 9           # a specific tree
bun run bench -- --synth /tmp/big                # synthesize a deep tree first
bun run bench -- --json                          # machine-readable rows
```

Runs are interleaved after one warmup each so page-cache bias lands evenly;
the verdict line compares medians and the parity column hashes the sorted
candidate-path set on both engines (a count match alone can hide swapped or
duplicated candidates).

The no-hook fast path matters for honest numbers: `scanToPlanViaRust` only
streams NDJSON when `onEntry`/`onEntrySized`/`onProgress` are provided. With
no hooks the engine writes one plan JSON, which is what `clean`/`plan`/`apply`
and this bench exercise. The TUI path streams, so its timings include
per-candidate serialization.

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

### Driving the TUI headlessly

`packages/ui` tests render the real `SweepApp` through OpenTUI's `testRender`.
Three harness gotchas have each cost a false alarm - know them before trusting
a weird frame:

- **`pressKey("down")` types the literal letters** `d`/`o`/`w`/`n` - which fire
  `o` (sort) and `w` (collapse all). Use `mockInput.pressArrow("down")` or the
  raw sequence `"\x1B[B"`. Same for `pressKey("space")` - send `" "`.
- **`Esc` needs a real-time wait** (~25ms). The input parser holds a bare ESC
  for `DEFAULT_TIMEOUT_MS` (20ms) to disambiguate from escape sequences, and
  the fake test clock never fires it. `await` a real `setTimeout` after
  `pressEscape`.
- **`flush()` waits for scheduler idle**, which can never settle if anything
  schedules a delayed render. `renderOnce()` drains React and paints - prefer
  it in settle loops.

Cursor keys skip group headers: a `down` from a header lands on the first
item. The footer context line is `✓ <kind> <size> <path>` for an item, or the
group summary (`<label> · N items · <size>`) when the cursor sits on a header -
`No matching artifacts.` only appears when the filtered list is genuinely
empty.

## CI split

| Workflow                        | When it runs                      | What it does                                                                                                      |
| ------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`      | Every push/PR to `main`           | `fixtures:sync`, `turbo check`, `build`, `preflight`, and Rust                                                    |
| `.github/workflows/release.yml` | Push to `main` or manual dispatch | Changesets version PR or npm publish; native matrix required for an untagged version with no unapplied changesets |

To smoke-test the native engine matrix without publishing, run the **Native engine release**
workflow manually from GitHub Actions (`workflow_dispatch` on `native-engine-release.yml`).

Parity fixture trees (`node_modules/`, `dist/`, etc.) are gitignored globally; CI
materializes them with `bun run fixtures:sync` before engine tests run. Golden
`expected.plan.json` files must use stable candidate ids (`bun run fixtures:validate-goldens`);
regenerate with `bun run scripts/generate-parity-fixture.ts -- tests/fixtures/<name>`.

## Engine latency benchmark

Build the release binary, then compare the streaming APIs on generated small,
wide, dense and nested single-artifact fixtures:

```bash
bun run engine:build
bun run packages/core/benchmarks/engine-comparison.ts --samples 100 --warmups 3 --output /tmp/sweep-bench.json
```

`SWEEP_ENGINE_PATH` can pin a different binary. Runs alternate engine order,
assert candidate and byte parity in both sizing modes, and record raw samples plus p50/p95/p99
for completion, first discovery, first sized result, and a 5 ms event-loop
heartbeat. Results use a warm filesystem cache and include Rust process startup
and the native stream bridge. They exclude CLI startup, TUI rendering, apply,
cold-cache behavior and memory measurement; an empirical p99 from 100 local
samples is not a production latency guarantee. Use a quiet machine and report
the runtime, CPU, platform, binary and fixture shape with any published result.

Use `--scenarios fat,flat,wide --fat-files 100000` for scale qualification.
`fat` distributes files into groups of 64 inside one artifact; `flat` puts every
file directly in that artifact, where directory-level parallelism cannot help.
To measure the project filesystem rather than `/tmp` (which may be tmpfs):

```bash
mkdir -p target/benchmark-fixtures
bun run packages/core/benchmarks/engine-comparison.ts --scenarios fat,flat,wide --fat-files 20000 --fixture-parent target/benchmark-fixtures --samples 100 --warmups 3 --resource-samples 2 --output /tmp/sweep-large-bench.json
```

Linux records a separate `du -sb` reference for single-artifact scenarios and
asserts apparent-byte parity. `--resource-samples` defaults to zero and requires
Linux GNU `/usr/bin/time`; it runs separate fresh-process probes. Their maximum
RSS includes startup and is per-process high-water accounting, not aggregate
concurrent process memory or proof of no leaks. Temporary fixture creation and
removal are excluded from scan timing. A binary SHA-256 identifies the measured
release build. Runs with fewer than 100 samples are smoke/gate measurements;
the reported nearest-rank p99 can equal the maximum and is not a p99 estimate
with useful tail confidence.

## Seeded scenarios

`scripts/seed-fixture.ts` creates rich trees under `/tmp` for engine tests:

```bash
bun run scripts/seed-fixture.ts -- --scenario monorepo
```

[packages/test-fixtures/src/fixtures.ts](../packages/test-fixtures/src/fixtures.ts) wraps this for Bun tests; integration
`seed-script.test.ts` verifies the script end-to-end.

### Apply and remediation checks

`packages/core/src/engine.test.ts` exercises duplicate/nested IDs, pre-abort,
live native cancellation, closed initial control channels and changed-size
ceilings on disposable trees. Packaged-engine release CI runs these tests on
every native runner, including ARM64 and Windows. A configured workflow is not
a successful hosted result. The probe timeout, bounded history tail, private
rotation, Unicode globs and hard-link scopes have focused regressions too.

```bash
bun run packages/core/benchmarks/edge-parity.ts
bun run packages/core/benchmarks/apply-comparison.ts --samples 7 --output /tmp/sweep-apply.json
bun run packages/ui/benchmarks/state-pipeline.ts
```

Apply measurements include refreshed size guards, validation, native control
startup and deletion; fixture creation/removal is excluded. Seven samples
report exploratory medians/maxima, not qualified p99. UI state measurements
exclude terminal rendering. See [remediation evidence](../.plans/codebase-audit-2026-10-01/remediation.md).

## Resource and standalone qualification

On Linux, use an owned fixture parent with enough space/inodes. `/tmp` quotas
can be smaller than statvfs reports. The harness cleans up only its own tree:

```bash
bun run engine:build
python3 scripts/resource-stress.py --files 100000 --repeats 5 --fixture-parent .plans --output /tmp/sweep-resources.json
# Opt-in: approximately 4 GiB of filesystem blocks and a million inodes
python3 scripts/resource-stress.py --files 1000000 --repeats 2 --fixture-parent .plans --output /tmp/sweep-million.json
bun run packages/core/benchmarks/engine-comparison.ts --scenarios small,wide,fat,flat --fat-files 20000 --fixture-parent .plans --samples 100 --warmups 3 --output /tmp/sweep-latency.json
```

The harness limits descriptors to 64, samples combined host/child RSS with a
512 MiB kill watchdog, repeats scans without forced GC, reads native streams
slowly, and verifies explicit quota failure. The watchdog is test tooling, not
a shipped memory cap. Tiny injected budget, cancellation, raw filename, deep
scope and large ID group regressions also run in `bun run check` / `rust:check`.

Dated evidence: [100k resource runs](../.plans/codebase-audit-2026-10-01/resource-stress-100k.json),
[million-entry runs](../.plans/codebase-audit-2026-10-01/resource-stress-million.json),
[latency samples](../.plans/codebase-audit-2026-10-01/engine-results-resource-bounds.json).
The Bun JS measurement includes its Node enumeration worker startup/IPC.

Standalone builds require a release Rust engine built on the same platform:

```bash
bun run scripts/build-standalone.ts "" target/sweep-bytecode
bun run scripts/smoke-standalone.ts target/sweep-bytecode
bun run scripts/build-standalone.ts "" target/sweep-plain --no-bytecode
python3 scripts/bench-standalone.py --bytecode target/sweep-bytecode --plain target/sweep-plain --output /tmp/sweep-startup.json
```

The smoke scan empties PATH and checks candidate/byte parity. The startup
comparison alternates 30 process launches after three warmups, measuring
`--version` with the static UI import. It excludes native extraction and TTY
rendering. [Local bytecode evidence](../.plans/codebase-audit-2026-10-01/standalone-bytecode.json)
is an exploratory median/max comparison, not a portable speedup claim.
