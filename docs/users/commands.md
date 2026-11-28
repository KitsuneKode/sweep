---
title: Commands and saved plans
description: Use read-only commands first and apply an explicit reviewed plan.
---

Paths default to the current directory when a command accepts one. Quote paths containing spaces. `sweep --help` and `sweep <command> --help` show the options supported by your installed version.

| Command                          | What it does                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `sweep scan .`                   | Lists candidates without deleting                                            |
| `sweep status .`                 | Summarizes reclaimable bytes, coverage, idle projects, and guarded artifacts |
| `sweep plan .`                   | Writes a saved-plan JSON document to stdout                                  |
| `sweep ui .`                     | Opens the interactive projects view                                          |
| `sweep clean .` or `sweep .`     | Scans, selects, confirms, and applies                                        |
| `sweep inspect --plan plan.json` | Reviews a saved plan without applying it                                     |
| `sweep apply --plan plan.json`   | Validates and applies a saved plan                                           |
| `sweep init .`                   | Scans, asks about opt-in patterns, and writes `.sweeprc`                     |
| `sweep doctor .`                 | Reports configuration, environment, engine trust, and a dry scan             |
| `sweep stats`                    | Shows retained cleanup history                                               |
| `sweep recover --journal path`   | Reads an apply journal without retrying or restoring                         |
| `sweep schema`                   | Exports the JSON Schemas embedded in the installed CLI                       |
| `sweep completions zsh`          | Prints completions for zsh; bash and fish are also supported                 |

## Status

`sweep status .` is read-only. It scans and reduces the result to a compact answer:

- `reclaimableBytes`: safe plus caution bytes.
- `protectedCount` and `protectedBytes`: dangerous and blocked artifacts, reported separately.
- `complete`, `skippedDirs`, `bytesPartial`, and `partialByteCount`: scan and sizing coverage.
- `idle`: projects whose activity is proven outside the idle window, with exact `windowMs`, `windowLabel`, per-project `idleMs`, and `idle.kinds` bytes.
- `finishedWorktrees`: clean merged worktrees quiet for at least 24 hours. These are excluded from `idle` to avoid double counting.
- `branchMissingWorktrees`: worktrees whose tracking branch is missing. They are never treated as finished.
- `uniqueReclaimableBytes`: estimated freed bytes after shared hardlinks are counted once, when available.

A project whose activity cannot be proven is not called idle. `--idle <age>` changes the idle window for status. The default is 30 days. Sub-day windows such as `--idle 12h` keep their exact duration.

A compact JSON example:

```json
{
  "protocolVersion": "1",
  "targetDir": "/home/example/projects",
  "complete": true,
  "reclaimableBytes": 61489152,
  "uniqueReclaimableBytes": 41287680,
  "safeBytes": 61000000,
  "cautionBytes": 489152,
  "protectedCount": 2,
  "protectedBytes": 1048576,
  "idle": {
    "windowLabel": "30+ days",
    "projects": 3,
    "bytes": 20971520,
    "kinds": []
  }
}
```

The real output also includes scan coverage, worktree summaries, kind totals, and the top idle projects. Fields that do not apply can be omitted.

## Save, inspect, and apply

```sh
sweep plan . > sweep-plan.json
sweep inspect --plan sweep-plan.json
sweep apply --plan sweep-plan.json --dry-run
```

After reviewing the same target and selections:

```sh
sweep apply --plan sweep-plan.json
```

Saved plans contain paths, candidate IDs, selections, provenance, filesystem identities, and size metadata. Treat them as local operational data. Applying validates the target and every selected path again. A saved plan is not a signature and not proof that a plan from another person is trustworthy.

Without `--yes`, `sweep apply --plan` confirms interactively with the resolved scan target, artifact count, estimated size, and dangerous artifact count. Dangerous paths are listed before the prompt.

## Frequently used options

| Option                                        | Purpose                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `--dry-run`, `-n`                             | Preview cleanup or saved-plan apply                                            |
| `--trash`                                     | Move artifacts into local trash inside the scan target                         |
| `--yes`, `-y`                                 | Skip the plain CLI confirmation                                                |
| `--engine auto`, `rust`, or `js`              | Choose the engine; auto prefers a trusted Rust engine                          |
| `--resource-profile balanced` or `low-memory` | Choose scan resource allowances                                                |
| `--pattern name`, `-p name`                   | Add an artifact name or name glob; repeatable                                  |
| `--disabled-pattern name`                     | Disable a pattern for this run; repeatable                                     |
| `--ignore path`, `-i path`                    | Exclude names, globs, or relative path prefixes                                |
| `--depth n`                                   | Limit discovery depth; `-1` means unlimited                                    |
| `--config path`                               | Use an explicit JSON config file                                               |
| `--select default`, `safe`, `all`, or `none`  | Choose initial selection policy                                                |
| `--idle 30d`                                  | Select only artifacts in projects idle that long; also `2w`, `3m`, `1y`, `12h` |
| `--include-dangerous`                         | Allow dangerous candidates in the selection policy                             |
| `--allow-dangerous`                           | With `--yes`, let dangerous artifacts be removed after they are listed         |
| `--max-size-gb gib`                           | Set a run-specific size ceiling in GiB; `none` disables a configured ceiling   |
| `--force-large`                               | Override the size ceiling and require `--yes`                                  |
| `--json`                                      | Structured output for commands that support it                                 |
| `--json-stream`                               | NDJSON scan events for `sweep scan`                                            |
| `--quiet`, `-q`                               | Reduce incidental output                                                       |
| `--verbose`                                   | Show per-candidate scan output                                                 |
| `--no-color`                                  | Disable terminal colors                                                        |
| `--view projects` or `full`                   | Choose the starting terminal UI view                                           |
| `--theme auto`, `dark`, or `light`            | Choose the terminal UI theme                                                   |
| `--plan path`                                 | Select a saved plan for `apply` or `inspect`                                   |
| `--journal path`                              | Select a journal for `recover`                                                 |
| `--force`, `-f`                               | Replace an existing `.sweeprc` in `sweep init` after review                    |

`--select all` still does not select blocked paths. Dangerous matches require explicit dangerous inclusion. A `--yes` run with dangerous artifacts selected refuses unless `--allow-dangerous` is also passed. Git-tracked content and project files are always blocked.

## Idle and activity confidence

Every artifact carries the last proven activity time for its project when that time can be established. Sweep reads git metadata and a bounded walk of the project's own non-generated source files. Build output timestamps never make a project look active.

If activity cannot be proven, the project shows idle `?`. Causes include unreadable folders, a bounded walk reaching its limit, a symlinked directory Sweep will not follow, future-dated files, or no readable activity signal. Unknown projects are never treated as idle and `--idle` never selects them.

## Size ceilings

There is no default size ceiling. A numeric `maxSizeGB` in config remains effective. Use `--max-size-gb 600` for one deliberately reviewed run. Use `--max-size-gb none` to disable a configured ceiling for that run. Apply measures current sizes again before removal. If current sizing is incomplete or the reviewed ceiling is exceeded, apply refuses before removal.

`--force-large` is a noninteractive override and requires `--yes`. The terminal UI always confirms and offers a one-operation override instead. Neither override disables path, identity, mount, or resource checks.

## Widget output (0.6.0)

`sweep widget --json` and `sweep widget --json-stream` are planned for 0.6.0. They will provide bounded read-only snapshots for desktop widgets. They are not available in 0.5.x. Use `sweep status --json` for current status-line and script integrations.

## Exit status

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| 0    | Successful command                                      |
| 1    | Aborted operation                                       |
| 2    | Guardrail rejection, including scan resource exhaustion |
| 3    | Invalid configuration or plan                           |
| 4    | Other failure                                           |
| 5    | Warning result                                          |

For apply, also inspect the apply report. Interruption can produce a mixture of deleted, failed, covered, and unattempted candidates. Never interpret partial output or an unconfirmed process termination as a complete successful cleanup.
