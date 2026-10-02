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

## Resource and release decisions (2026-10-02, locally implemented)

- Use cumulative logical resource bounds and incremental metadata enumeration
  in both engines. Stop oversized scans as incomplete. Remove the JS scan's
  external `du` shortcut because its inode memory cannot share these bounds;
  record the apparent-sizing tradeoff in benchmarks. See
  [resource limits](resource-limits.md).
- Bun 1.4.2's `fs.Dir` buffers full directory listings. Use a credit-driven Node
  directory reader for the Bun JS path; never accept a Bun runtime pretending
  to be Node. Direct Node scans retain native incremental `opendir`.
- Standalone executables embed the matching host Rust engine as well as OpenTUI.
  Enable ESM bytecode, disable runtime dotenv/bunfig autoloading, extract the
  native engine lazily into a private owned directory, and smoke-test with an
  empty PATH. Keep npm bundles compatible with Node. Cross-compilation of this
  native asset requires a target runner, rather than embedding a host binary.
- Keep Changesets' scoped npm package tag. The release workflow creates a
  matching, immutable `vVERSION` alias for standalone downloads and dispatches
  the binary workflow explicitly. Only the binary workflow creates the GitHub
  release, avoiding duplicate package-tag and version-tag releases. Previews
  are marked prerelease and never update the stable Homebrew formula.
- Serialize publication without cancelling a running release. Require the full
  matching native matrix in CI and explicit preview dist-tags. These workflow
  changes require hosted qualification; no publication was performed locally.
