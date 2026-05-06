# Config

## Current implemented behavior

As of the current code:

- project config file name: `.sweeprc`
- project config format: JSON
- explicit config path: `--config <path>`
- global config path: `~/.config/sweep/config.json`

Config resolution order:

1. CLI overrides
2. Explicit config path if provided
3. Closest project `.sweeprc` found by walking up from the target directory
4. Global config file
5. Built-in defaults

Array fields are merged and deduplicated. Scalar values use the highest-priority
defined value.

## Important note

The planning docs discuss future directions such as `sweep.config.json` and
`.sweepignore`, but those are not implemented yet. Do not document them as
current behavior until the code changes.
