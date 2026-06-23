# Decision Log

## Locked direction

- Keep `sweep` as the public package.
- Center the product on automation/programmatic cleanup.
- Optimize for trust, UX clarity, and safety before cleverness.
- Evolve toward `scan`, `apply`, and `ui`.
- Use plan-backed apply with strict default revalidation.
- Keep dangerous candidates excluded by default from broad selection.
- Keep current docs thin at the root and move durable truth into `.docs/`.
- Treat the default human flow and the automation flow as one product, not two
  separate tools.
- Keep `sweep` as one public package even if the internals split later.

## Architecture direction

- Design for future package and engine boundaries early.
- Use a schema-first protocol as the stable long-term contract.
- Keep JS as the first reference engine.
- Treat Rust as a later engine behind the same contract, not a premature source
  of product semantics.
- Prefer a streaming scanner with bounded memory and a single traversal stream.
- Use stable candidate identities for plans, with explicit resolved candidate
  lists before apply.
- Support final JSON output and streamed NDJSON output for automation.
- Keep UI grouping and presentation out of the core contract where possible.
- Treat Linux, macOS, and Windows as first-class behavior targets.
- The public npm package is `apps/cli` (`@kitsunekode/sweep`); the repo root is a
  private orchestrator. Internal workspaces compile into `apps/cli/dist/` via
  the centralized bundler.

## Documentation direction

- `AGENTS.md` is the thin router.
- `.plans/` owns active planning and backlog.
- `.docs/` owns stable internal truth.
- `.reference/` owns supporting references.
