# `sweep` Product and Architecture Roadmap

Status: in_progress
Scope: product
Created: 2026-05-06
Updated: 2026-05-06
Commit: uncommitted

## Goal

Turn the grill-session product and architecture decisions into a staged roadmap
that can be executed without relying on chat memory.

## Locked Product Decisions

- Public package remains `sweep`.
- Product center is automation-first cleanup with strong trust and guardrails.
- Human UX still matters deeply: rich feedback by default and a stronger UI when
  needed.
- The primary product promise is trust, not raw speed theater.
- UI remains cleanup-first, not a general disk explorer.

## Locked UX Decisions

- Command model evolves toward `scan`, `apply`, and `ui`.
- Plain `sweep` in a TTY should start scanning immediately and show progressive
  results.
- Full-screen interaction should be explicit via `sweep ui` and `-i`.
- TUI search should be lightweight and fast over structured candidate fields,
  not a heavy fuzzy-finder dependency.
- Dangerous candidates should be excluded by default from broad selection and
  require explicit inclusion.
- Confirmation should be risk-aware and escalate to typed confirmation for
  higher-risk actions.
- Non-interactive flows should support both final JSON and streamed NDJSON
  output.

## Locked Architecture Decisions

- Design for a future multi-package or workspace layout early.
- Use a schema-first protocol as the long-term contract boundary.
- Keep a JS reference engine first; Rust comes later behind the same contract.
- Optimize scanning for time-to-first-result with bounded memory.
- Use a single traversal stream with bounded worker pools.
- Use adaptive size refinement instead of blocking on exact size everywhere.
- Use plan-backed apply, strict default revalidation, and risk tiers with
  rule-level explanations.
- Keep grouping mostly in the UI layer; the core should emit hints, not own the
  whole presentation model.
- Keep Linux, macOS, and Windows as first-class behavior targets.
- Prefer one public package with internal package or crate boundaries later.

## Recommended Phases

### Phase 1: Contract and Repo Restructure

- Define the target workspace layout and package boundaries.
- Write the first protocol docs for candidates, risks, plan/apply, and event
  streams.
- Separate current implementation facts from future direction in docs.
- Decide the first saved-plan and event-stream shapes before touching UI work.

Progress:

- Internal workspace split is in place.
- First protocol package exists.
- First saved-plan and event-stream shapes are implemented in the CLI.

### Phase 2: CLI Surface Refactor

- Introduce the `scan` and `apply` model in the CLI.
- Add structured final JSON output and streamed NDJSON output.
- Introduce stable candidate identities, plan compilation, and apply
  revalidation.

Progress:

- `scan --json`, `scan --json-stream`, and `apply --plan` now exist.
- Legacy default cleanup flow still exists at plain `sweep`.
- Saved plans now carry default selections and aggregate risk counts.
- Revalidation now checks symlink and entry-type drift, but can still grow
  stricter in later passes.
- `scan -> plan` and `apply plan` now have shared core-engine entrypoints, so
  the CLI is no longer the only place where those semantics live.
- Seeded tmp-fixture tooling now exists for monorepo-style scenario tests and
  future engine parity checks.
- Selection policy is now explicit in the plan contract, and the CLI can opt
  dangerous candidates in via `--select` and `--include-dangerous`.
- Apply and revalidation failures now have stable structured failure codes, and
  the fixture tooling includes a first mixed-risk scenario for parity tests.
- The seeded fixture tooling now also includes a larger workspace-matrix
  scenario so plan shape and risk counts can be compared across engines on a
  more realistic tree.
- First JSON Schema artifacts now exist for `ScanPlan` and `ApplyReport`, so
  alternate engines have a versionable machine-readable contract to target.

### Phase 3: Policy and Selection Model

- Add risk tiers with rule-level reasons.
- Add rule-based selection that compiles into explicit candidate lists.
- Formalize dangerous-by-default-excluded behavior.
- Add policy hooks for fail-fast and drift handling modes.

### Phase 4: UI Foundation

- Add `sweep ui` as an explicit mode.
- Build streamed candidate display, search, selection, grouping hints, and
  risk-aware confirmation on shared planner semantics.

### Phase 5: Engine Experimentation

- Freeze the protocol enough to benchmark alternate engines.
- Prototype a Rust engine behind the same contract.
- Promote it only if it clearly wins without increasing support burden too much.

## Verification

- Each implementation phase should leave durable docs updated in `.docs/`.
- No product-critical decision should live only in a plan file after it is
  accepted.
- Before engine experimentation begins, protocol and planner docs should be
  precise enough to compare JS and Rust behavior directly.
