# Architecture

## Current state

The repo is a Bun workspace monorepo. The private root (`sweep-monorepo`) orchestrates
workspaces; the published npm package is `@kitsunekode/sweep` in `apps/cli`. Internal
workspaces compile into `apps/cli/dist/` via the centralized bundler.

### Layering

| Layer           | Location             | Responsibility                             |
| --------------- | -------------------- | ------------------------------------------ |
| Protocol        | `packages/protocol/` | Shared types, JSON Schema artifacts        |
| Core engine     | `packages/core/`     | Config, guardrails, scan, plan, apply      |
| Display         | `packages/display/`  | Terminal formatting and progressive output |
| UI              | `packages/ui/`       | OpenTUI selection flow and state           |
| CLI             | `apps/cli/`          | Commander program, handlers, entrypoint    |
| Rust experiment | `crates/sweep-*/`    | Alternate engine behind the same contract  |

### Data flow

```
CLI flags / config
       ↓
  packages/core (scan → plan → apply)
       ↓
  packages/protocol (ScanPlan, ApplyReport, ScanEvent)
       ↓
  packages/display (stdout)  or  packages/ui (interactive)
```

- `apps/cli/src/handlers/` maps subcommands (`scan`, `apply`, `ui`, default
  clean) to core engine calls.
- `sweep ui` scans via core, then hands plan editing to `packages/ui`; final
  selection compiles back to explicit candidate IDs.
- `scripts/seed-fixture.ts` and [packages/test-fixtures/src/fixtures.ts](../packages/test-fixtures/src/fixtures.ts) seed parity scenarios
  for integration tests and future JS-vs-Rust checks.

### Commands (implemented)

- `sweep` - default cleanup flow with prompt and guardrails
- `sweep scan` - scan only; `--json` and `--json-stream` for automation
- `sweep apply --plan` - apply a saved plan with revalidation
- `sweep ui` - OpenTUI interactive selection (TTY required)
- `sweep inspect --plan` - read-only plan provenance and totals
- `sweep stats` - retained cleanup history and estimated removed/moved totals
- `sweep completions` - static bash/zsh/fish completion scripts
- `sweep init` / `sweep doctor` - scaffolding and environment checks

## Intended direction

The accepted direction is clearer package and engine boundaries with a
schema-first contract:

- public package: `@kitsunekode/sweep` (`apps/cli`)
- internal boundaries: protocol, core engine, display, CLI app, UI, Rust engine
- execution model: `scan`, `apply`, and `ui`, with plan-backed apply and strict
  default revalidation

See [.docs/workspace-layout.md](workspace-layout.md) for the directory map and
[.docs/product-direction.md](product-direction.md) for product intent.

## Long-term architecture decisions

- The long-term contract should be schema-first.
- A JS implementation should remain the reference behavior initially.
- Alternative engines, including Rust, should implement the same external
  contract rather than redefining product behavior.
- The interactive UI should stay a thin shell over the shared plan contract:
  local cursor/filter state is okay, but final selection must compile back into
  explicit candidate IDs.
- Selection policy should stay explicit in the plan contract so alternate
  engines can produce the same selected candidate sets from the same scan.
- The scan engine should stream candidates progressively, prefer time-to-first
  result over end-of-run theatrics, and keep memory bounded.
- The planner should compile user or UI selection rules into explicit candidate
  lists before apply.
- The core should emit rich candidate entities and grouping hints, but the UI
  should own grouping and presentation behavior.
- The non-interactive surface should support both final JSON snapshots and
  streamed NDJSON events.
- Candidate identity should be stable enough for saved plans and strict
  revalidation.
- Revalidation and apply failures should use stable structured failure codes so
  JS and Rust engines can be compared by behavior, not just free-form text.
- `ScanPlan` and `ApplyReport` should have first-class JSON Schema artifacts so
  engines in different languages can target the same machine-readable contract.
- Shared protocol defs and streaming scan events should also have schema
  artifacts so the full non-interactive contract is explicit.
- Seeded fixture scenarios should cover both small targeted failures and larger
  mixed workspace trees so engine parity can be checked at multiple scales.
- Optional fields let both engines grow the contract without a protocol bump.
  `modifiedMs` is the first: the artifact's own mtime in epoch milliseconds, one
  `lstat` per match. Both engines fill it, the schemas allow it, and the parity
  normalizers drop it because timestamps differ per checkout. Anything that
  reads it must treat "absent" as unknown, never as zero.
- Artifact matching should evolve from flat patterns toward artifact definitions
  with richer semantics.
- Saved plans should carry candidate lists, default selections, and aggregate
  risk counts so apply does not need to rediscover intent.

## Performance direction

### Implemented scan transport and UI lifecycle

The native NDJSON bridge bounds each UTF-8 line before buffering it,
structurally validates every event, and requires a matching start, discovered
and sized candidates, and consistent completion counts and bytes. A malformed
or truncated stream fails the scan instead of returning a partial executable
plan. Cancellation and non-EPIPE request-write failures stop the child process.
Engine emit is buffered: found/updated candidates batch into
`candidates_found`/`candidates_updated` lines that flush on a 16 ms heartbeat,
at 64 pending, immediately on the first batch, on cadence inside `push`,
and once at completion. A scoped timer flushes sparse pending batches even
when no later event arrives; it exits before the terminal completion event.

`estimatedBytes` is honest about completeness: `bytesKnown === false` marks a
partial lower bound when part of a subtree was unreadable (also the pre-size
stub state during a stream). `summary.exact` is only true when exact sizing
was requested and every candidate's size is known; the UI marks partial rows
with `~`.

The TUI reveals the first candidate immediately, then coalesces discoveries and
size updates by ID over a 60 ms window, flushing at 200 pending candidates. Each
scan generation owns its timer and cancels it on abort or completion. Discovery
order remains pinned until final enrichment, and manual selection decisions
survive that reconciliation. The strip reports unresolved sizes separately from
found artifacts. A failed generation stays incomplete after its error is
dismissed; apply and plan export require successful finalization. A completed
scan with skipped directories remains usable and is explicitly labeled partial.

Rust discovery uses a fixed LIFO/steal worker pool (at most eight threads).
Sizing uses one shared eight-thread Rayon pool across candidates and nested
subdirectories. Its external dispatcher admits at most 32 candidate jobs,
behind a 256-entry channel. Directory subdivision batches at 64 paths and
three parallel levels; deeper sizing uses a local LIFO, and leaf metadata does
not retain one allocated path per file. Hardlink dedupe is per artifact;
visited-directory identities, admitted paths and candidates share explicit
resource budgets with sizing. See [resource limits](resource-limits.md) for
numbers, failure behavior and the difference between logical charges and RSS.
Worker panic stops the walk and propagates failure; idle workers back off
instead of spinning indefinitely. JS uses one global 16-worker traversal queue,
incremental 32-entry enumeration, and 32-name metadata batches; abort listeners
are removed on exit and sparse sizing batches flush on a 16 ms timer. Both
engines use budgeted apparent metadata sizing, with no external `du` shortcut.
Node uses native `opendir`; Bun's array-backed `fs.Dir` is bypassed with one
bounded Node enumeration child per operation. Missing Node fails explicitly
when selecting JS under Bun. Standalone builds embed a matching Rust engine,
which is extracted lazily into an owned private temporary directory; help and
version do not extract it. The npm distribution keeps Node-compatible bundles.
Apparent mode counts file
and symlink lengths once per inode inside each artifact; directory metadata is
excluded. Cross-artifact totals remain estimates rather than physical reclaim. Both engines recheck queued directories and avoid intentionally
following leaf symlinks; pathname-to-open races remain a documented limitation.

Queue totals cache by candidate, selection and visible-list identity, so cursor
moves and progress ticks reuse totals. Selection changes reuse structural grouping and sorting and update selection
counts. Scope indexing is iterative and separately bounded; exceeding its
budget suppresses only the folder index with visible feedback, retaining every
candidate in the main list. Rendering still needs real-terminal qualification.

- Optimize for time-to-first-result.
- Keep memory bounded.
- Prefer a single traversal stream with bounded worker pools.
- Use adaptive size refinement instead of blocking on exact size for every
  candidate.

## Cross-platform direction

- Treat Linux, macOS, and Windows as first-class targets for behavior.
- Correctness must not depend on Unix-only shell utilities.
- Platform-specific accelerators are acceptable, but only as optional fast
  paths that do not change semantics.

## Safety direction

- Hard guardrails remain non-negotiable.
- Risk should be represented with tiers plus rule-level reasons.
- Dangerous selections should require stronger interaction or flags.
- Apply should support both inline convenience and saved-plan execution, but
  always compile to explicit candidate sets before deletion.
- Apply revalidation should reject entries whose symlink or entry type no longer
  matches the saved plan.

## Apply-time safety model

The gap between scan and apply is a trust boundary - the tree may have changed.
Both engines re-validate before deleting:

- **Lexical containment** - every candidate path must resolve inside the plan
  target (`isPathWithinRoot` / `is_path_within_root`); the target root itself
  and VCS metadata segments are reported as `protected_path` failures rather
  than deleted.
- **Type drift** - symlink-state or entry-type changes since the plan are
  rejected (`changed_symlink_state` / `changed_entry_type`).
- **Realpath containment** - a lexical check alone misses an ancestor swapped
  to a symlink after scanning (`proj/sub` → `/etc` would make `rm` recurse
  outside the target). Both engines canonicalize the target root and each
  non-symlink candidate and require real containment. Every candidate also has
  its canonical parent checked for containment and VCS metadata. A symlink
  leaf is unlinked without canonicalizing or following its target.
- **Size ceiling** - `sweep apply --plan` enforces `maxSizeGB` just like the
  interactive flows; a saved plan is not a trusted lane around the cap
  (`--force-large --yes` to bypass, matching `clean`). Before destructive apply,
  both engines refresh selected, revalidated, deduplicated entries using the
  plan's sizing mode and refuse unknown totals or observations above the cap.
  This is a pre-apply observation ceiling, not an atomic physical-reclaim cap:
  concurrent changes after sizing remain possible. Preview totals stay estimates. Confirmation labels selected size, and
  progress/summary report estimated removed or moved bytes rather than promised
  physical reclaim.
- **Interrupted deletes** - SIGINT during apply stops scheduling new work,
  lets in-flight removals finish, and reports exactly what was deleted
  (exit 1). Native apply uses an explicit plan/start/cancel NDJSON channel,
  not process termination. On Unix its child runs in a separate process group
  so terminal SIGINT reaches the host without killing the report writer. On
  Windows a console handler sets the same atomic cancellation flag. It sends
  begin/deleted events and a final report with
  one outcome per unique selected ID: deleted, failed, covered by a completed
  ancestor/duplicate operation, or unattempted. The host drains that report
  before exit. A 30-second cancellation watchdog reports unknown outcomes if
  force-kill is necessary. A process failure or malformed report after apply
  begins also reports unknown outcomes; destructive operations are never
  automatically retried.
  Engines without this capability are refused before native apply starts;
  upgrade the native package or explicitly choose JS. Scan cancellation still
  terminates its read-only child.
- **Plan files are untrusted** - `loadPlan` requires a regular file under
  256 MB, then validates against the ScanPlan schema. Engine apply reports
  are validated against the ApplyReport schema for the same reason:
  `SWEEP_ENGINE_PATH` can point the subprocess at any binary.
- **Nested + duplicate candidates** - `deduplicateNestedEntries` drops any
  entry inside a retained parent (and exact-path repeats from crafted
  plans) so one path is never deleted or counted twice.

### Trash mode

`--trash` turns apply into a move: `clean()` renames each entry into
`<target>/.sweep-trash-<iso-timestamp>/` preserving the target-relative
path. Renames are same-filesystem and atomic; `rename` on a symlink moves
the link, never the target, so trashing a symlink stays unlink-equivalent
in safety terms. Nested dedupe still applies - a retained parent's move
carries its children. The trash root is rmdir'd if every move fails (no
bare husks). Trash dirs are default-ignored (`ignore: [".sweep-trash-*"]`)
so they can't be re-selected; the user purges by deleting the dir. Trash
is JS-engine only - the CLI falls back from `--engine rust` with a warning.
`relative()` refuses entries outside `trashRoot` (defense in depth under
the apply-time containment checks).

### History

`executePlanDeletion` appends one JSONL line per apply to
`<configDir>/history.jsonl` (ts, targetDir, engine, deleted, bytesFreed,
failed, interrupted, trashDir). Best-effort: a failed write never fails the
apply. `sweepConfigDir()` resolves `$XDG_CONFIG_HOME/sweep` (or
`%APPDATA%/sweep`, else `~/.config/sweep`) - `SWEEP_CONFIG_DIR` overrides
it entirely, which is how tests and `bun run dev` keep user state clean.
`readHistory` opens and fstats the same regular handle, reading at most 8 MiB
across the active log and newest archives. Symlinks and malformed/oversized
records are rejected; POSIX files are private (0600). Rotation renames whole
logs after 16 MiB to unique archives, retaining four, instead of rewriting a
concurrently appended inode. Windows privacy follows the config directory ACL.
Stats describe this retained window and estimated removed or moved bytes,
not lifetime totals or measured physical reclaim. Best-effort history is not
a crash-durable recovery journal.

### Terminal-output safety

Filenames are attacker-controlled bytes. POSIX names may contain ESC and
other control characters, so every path/name that reaches a terminal is
escaped `ls -b`-style (`\xNN`, `\uNNNN`) by `sanitizeTerminalText` in
`packages/protocol` - applied in the display layer, the TUI row/line
builders, and guardrail/error messages (`printError` sanitizes centrally,
keeping `\n`/`\t` for composed messages). A hostile `node_modules`-matching
directory cannot inject ANSI into scan output, the TUI, or error text.

### Selection and matcher costs

UI rows cache ordering/group membership independently of selection. Selection
changes reuse item rows and refresh header counts; queued/unqueued filters still
recompute membership. Sidebar topology/order is cached per candidate generation
and selected statistics use one postorder pass. Content caches are bounded.
Glob question marks consume Unicode scalars in both engines, with Unicode
lowercasing on case-insensitive platforms; pattern limits count scalars too.
Native iterator/file-type errors count the directory as partially skipped once.
Async pools stop claiming jobs on failure and drain admitted work before rejecting.
