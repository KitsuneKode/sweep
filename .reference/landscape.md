# Cleanup Tool Landscape

Useful comparison points for `sweep`, from a 2025 competitive pass.

## Direct competitors (artifact cleanup)

- `npkill` — closest match: finds and interactively deletes `node_modules`.
  Single-ecosystem, no plan artifact, no safety tiers. Sweep's queue-first +
  confirm-always + plan/revalidate flow is the trust edge.
- `kondo` — broad multi-ecosystem cleanup (cargo, node, maven, …) with a TUI.
  No streaming preview, no trash mode, weaker confirmation story.
- `Dustoff` — richer JS/TS TUI cleanup UX inspiration.
- `purgeit`, `cleard` — small-scope single-purpose variants.

## Adjacent (disk usage, not cleanup)

- `gdu`, `dua-cli`, `ncdu`, `dust`, `diskonaut` — full-tree disk analyzers.
  Useful benchmarks for traversal speed and TUI density, but they answer
  "what's big" where sweep answers "what's safe to delete". Any public
  comparison must state this task difference explicitly.
- `gomi`, `rip2`, `trashy` — trash/undo semantics worth stealing for
  `sweep restore`.

## Where sweep should win

- Risk tiers + candidate reasons (`why this is safe to delete`).
- Plan artifacts: export, revalidate-before-apply, realpath containment.
- Progressive TUI: rows during traversal, sizes streaming in live.
- Dual engines with parity checks; `--engine auto` picks Rust when present.
- Trash mode + restore story (still incomplete — see roadmap).

## Benchmark honesty rules

- Compare equivalent tasks only: sweep's pattern-matched scan vs a full-tree
  `du`/`dust` pass is not apples-to-apples — label it.
- Separate batch (plan JSON) from stream (NDJSON + hooks) measurements.
- Report medians over ≥5 interleaved runs after warmup; record corpus size,
  filesystem, OS, and versions. `hyperfine` integration is the direction for
  published numbers.

This file is intentionally lightweight. It is not the source of truth for
product direction; `.docs/product-direction.md` and `.docs/decision-log.md`
own accepted project decisions.
