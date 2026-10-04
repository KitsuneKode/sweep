---
title: Configuration
description: Use .sweeprc to choose matches, exclusions, depth and cleanup size limits.
---

Sweep reads JSON from `.sweeprc`; no extension or YAML configuration is implied.
Create a starter file with `sweep init .`, or write:

```json
{
  "patterns": ["dist"],
  "disabledPatterns": [".turbo"],
  "ignore": ["packages/vendor-patched"],
  "maxSizeGB": 10,
  "depth": -1
}
```

`dist` is opt-in and remains dangerous because the name can contain authored work.
Do not add broad patterns such as `*` unless you understand every possible match.

| Field              | Behavior                                                 |
| ------------------ | -------------------------------------------------------- |
| `patterns`         | Adds names or name globs to built-in defaults            |
| `disabledPatterns` | Subtracts patterns from the merged set                   |
| `ignore`           | Excludes artifact names, globs or relative path prefixes |
| `maxSizeGB`        | Cleanup size ceiling; defaults to 10                     |
| `depth`            | Discovery depth; defaults to -1, unlimited               |

`maxSizeGB` is a deletion guardrail, not a scan memory limit. Resource-budget
settings are currently not CLI flags or `.sweeprc` fields.

## Resolution order

For scalar settings, highest priority wins:

1. Command-line options.
2. Explicit `--config` file, when supplied.
3. Nearest project `.sweeprc` found by walking upward from the scan target.
4. Global config.
5. Built-in defaults.

Pattern and ignore arrays merge and deduplicate across applicable layers;
disabled patterns are subtracted afterward. Scanning a nested project can inherit
an ancestor's config. Use `sweep doctor .` to investigate unexpected behavior.

Global config is `~/.config/sweep/config.json` on Linux/macOS, honoring
`XDG_CONFIG_HOME`, and `%APPDATA%\sweep\config.json` on Windows.
`SWEEP_CONFIG_DIR` overrides the config directory and also determines history
storage. Use it for isolated automation.

## Match rules

Patterns match entry names, not full paths. `*` matches zero or more characters;
`?` matches one character. For example, `*.tsbuildinfo` matches
`tsconfig.tsbuildinfo`. This is not shell brace expansion or a recursive `**`
path-glob interface.

Use an ignore prefix such as `packages/vendor-patched` to exclude a subtree;
a trailing slash is normalized. Preview any new pattern with `sweep scan .`
and inspect the resulting paths before cleanup.

In the UI, `p` opens the catalog. Its `w` action writes a project config without
silently overwriting an existing one. Follow the displayed overwrite instruction
only after reviewing that file.
