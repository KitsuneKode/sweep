# Config

## Current implemented behavior

As of the current code:

- project config file name: `.sweeprc`
- project config format: JSON
- explicit config path: `--config <path>`
- global config path: `~/.config/sweep/config.json`

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

| Field              | Purpose                                                |
| ------------------ | ------------------------------------------------------ |
| `patterns`         | Extra artifact names/globs to add to defaults          |
| `disabledPatterns` | Default or merged patterns to disable for this project |
| `ignore`           | Skip matched artifacts by name or relative path prefix |
| `maxSizeGB`        | Size guardrail threshold (default 10)                  |
| `depth`            | Max scan depth (-1 = unlimited)                        |

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

## Important note

The planning docs discuss future directions such as `sweep.config.json` and
`.sweepignore`, but those are not implemented yet. Do not document them as
current behavior until the code changes.
