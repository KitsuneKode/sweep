# Config

## Current implemented behavior

As of the current code:

- project config file name: `.sweeprc`
- project config format: JSON
- explicit config path: `--config <path>`
- global config path: `~/.config/sweep/config.json` (`%APPDATA%\sweep\config.json` on Windows)

Config resolution order (scalars — highest priority wins):

1. CLI overrides
2. Explicit config path if provided
3. Closest project `.sweeprc` found by walking up from the target directory
4. Global config file
5. Built-in defaults

Array merge behavior:

- `patterns` — merged and deduplicated from defaults + global + project + CLI
- `disabledPatterns` — merged from global + project + CLI, then subtracted from `patterns`
- `ignore` — merged from all layers; applied as name-level or path-prefix excludes at scan time

## Fields

| Field              | Purpose                                                | Default |
| ------------------ | ------------------------------------------------------ | ------- |
| `patterns`         | Extra artifact names/globs to add to defaults          | `[]`    |
| `disabledPatterns` | Default or merged patterns to disable for this project | `[]`    |
| `ignore`           | Skip matched artifacts by name or relative path prefix | `[]`    |
| `maxSizeGB`        | Size guardrail threshold                               | `10`    |
| `depth`            | Max scan depth (-1 = unlimited)                        | `-1`    |

Example `.sweeprc`:

```json
{
  "patterns": [".custom-output"],
  "disabledPatterns": ["dist"],
  "ignore": ["packages/vendor-patched"],
  "maxSizeGB": 10,
  "depth": -1
}
```

Use `disabledPatterns` to turn off a default like `dist`. Use `ignore` to skip specific
matches (by artifact name or path prefix such as `packages/vendor`).

### Filename rationale

The file is `.sweeprc` — plain JSON, no extension. This is deliberate:

- One unambiguous name across Linux/macOS/Windows (no `.rc.json` vs `.rc` divergence).
- Dotfile convention keeps it out of the way at the repo root.
- `sweep init` writes it; sweep never rewrites or deletes a config file on its own.

### Patterns that are safe to trust

Defaults cover common build outputs only (`node_modules`, `dist`, `build`, `out`,
`.next`, `.turbo`, `target`, `coverage`, …). Sweep will never invent targets: anything
not matched by the merged pattern set is invisible to the tool. To widen scope, add
explicit patterns in `.sweeprc`; to narrow, use `disabledPatterns`.

## Safety model (applies to every command)

1. **Nothing is deleted without an explicit user action.** Scan/plan/UI are read-only.
2. **Blocked paths are hard-locked** — VCS internals and protected roots cannot be
   selected for deletion in any mode.
3. **Dangerous-tier items require individual selection plus a red confirmation dialog**
   naming the count and stating the action is irreversible.
4. **Bulk select (`a`) covers safe + caution only** — dangerous items can never enter a
   selection through a bulk shortcut.
5. **Size guardrail**: totals above `maxSizeGB` refuse to proceed without
   `--force-large --yes`.
6. Every candidate path is revalidated inside the target directory immediately before
   deletion; failures abort that path, not the run.

## Important note

The planning docs discuss future directions such as `sweep.config.json` and
`.sweepignore`, but those are not implemented yet. Do not document them as
current behavior until the code changes.
