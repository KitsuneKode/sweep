# @kitsunekode/sweep

## 0.2.0

### Minor Changes

- Trust-first cleanup improvements, engine parity coverage, and a redesigned interactive UI.

  **Trust & CLI**
  - Restore grouped scan summary and delete confirmation on `sweep` / `clean`
  - Default scan engine to `js`; fall back when Rust cannot honor config or CLI overrides
  - Fix `sweep ui` plan handoff, config parse exit codes, and `doctor` non-zero on warnings

  **Interactive UI**
  - Group artifacts by directory scope for monorepo-friendly review
  - Minimal single-line list with a context strip for full paths and match reasons

  **Testing & engines**
  - Colocate package unit tests; keep integration tests under `tests/integration`
  - Add golden engine-contract fixtures with optional JS/Rust parity checks

  **Docs**
  - Add `.docs/testing.md` and refresh README / workspace references

## 0.1.0

### Minor Changes

Initial release.

**Features**

- Recursive artifact cleanup for any project tree (`node_modules`, `dist`, `.next`, `target`, `.turbo`, and 10 more default patterns)
- Monorepo-aware — scans nested packages automatically, no double-counting
- Hard guardrails: blocks `/`, `/home`, `/usr`, home directory, shallow paths, path traversal, and null-byte injection
- Config file support: `.sweeprc` walked up from CWD, merged with `~/.config/sweep/config.json` and CLI flags
- `--dry-run` with exact recursive sizes, `--yes` for CI, `--force-large --yes` for oversized deletes
- TTY-aware output: spinner + colors in terminal, plain prefixed lines in CI/pipes
- Size estimation via batched `du` (single subprocess for all matched paths)
- Symlink-safe: `lstatSync` detection, `unlinkSync` removal — never follows links
- Pattern safety: all patterns (CLI and config file) validated before use
- Single bundled ESM binary, Node 18+ and Bun compatible
