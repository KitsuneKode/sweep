---
title: Commands and saved plans
description: Use read-only commands first and apply an explicit reviewed plan.
---

Paths default to the current directory when a command accepts a path.
Quote paths containing spaces. `sweep --help` and `sweep <command> --help` show
the options supported by your installed version.

| Command                          | What it does                                    |
| -------------------------------- | ----------------------------------------------- |
| `sweep scan .`                   | Lists candidates without deleting               |
| `sweep status .`                 | What could be freed now, summarised; `--json`   |
| `sweep plan .`                   | Writes a saved-plan JSON document to stdout     |
| `sweep ui .`                     | Opens the interactive review UI                 |
| `sweep clean .` or `sweep .`     | Scans, selects, confirms, and applies           |
| `sweep inspect --plan plan.json` | Reviews a saved plan without applying           |
| `sweep apply --plan plan.json`   | Validates and applies a saved plan              |
| `sweep init .`                   | Creates a starter `.sweeprc`                    |
| `sweep doctor .`                 | Reports configuration, environment and dry scan |
| `sweep stats`                    | Shows retained cleanup history                  |
| `sweep completions zsh`          | Prints completions; also supports bash and fish |

## Status for scripts and widgets

`sweep status . --json` is a scan boiled down to a few hundred bytes: what could
be freed, which kinds hold it (`node_modules`, `target`, `.next`), the idle
projects holding the most, and how many items are protected. Only safe and
caution items count as space; dangerous and blocked ones are reported as
`protectedCount` and never added to a size. A project whose last activity could
not be read is not called idle. `idle.kinds` says what the idle bytes are made of,
so a bar drawn from it adds up to the idle total. `--idle <age>` sets the idle window here (30
days by default). It is read-only.

## Save and review

```sh
sweep plan . > sweep-plan.json
sweep inspect --plan sweep-plan.json
sweep apply --plan sweep-plan.json --dry-run
```

After reviewing the same target and selections:

```sh
sweep apply --plan sweep-plan.json
```

Saved plans contain paths, candidate IDs, selections and provenance. Treat them
as local operational data. Applying revalidates the filesystem; a saved plan is
not permission to follow an arbitrary changed path. Inspecting is not a signature
check or proof that a plan from another person is trustworthy.

## Frequently used options

| Option                                       | Purpose                                           |
| -------------------------------------------- | ------------------------------------------------- |
| `--dry-run`, `-n`                            | Preview cleanup or saved-plan apply               |
| `--trash`                                    | Move items into target-local trash                |
| `--engine auto`, `rust`, or `js`             | Choose the engine; auto prefers available Rust    |
| `--pattern name`, `-p name`                  | Add an artifact name or name glob; repeatable     |
| `--disabled-pattern name`                    | Disable a pattern for this run; repeatable        |
| `--ignore path`, `-i path`                   | Exclude names, globs or relative path prefixes    |
| `--depth n`                                  | Limit discovery depth; `-1` means unlimited depth |
| `--config path`                              | Use an explicit JSON config file                  |
| `--select default`, `safe`, `all`, or `none` | Choose initial selection policy                   |
| `--idle 30d` (`2w`, `3m`, `1y`)              | Select only artifacts in projects idle that long  |
| `--include-dangerous`                        | Allow dangerous candidates in selection policy    |
| `--allow-dangerous`                          | With `--yes`, let dangerous items be removed      |
| `--json`                                     | Structured output for commands that support it    |
| `--quiet`, `-q`                              | Reduce incidental output                          |
| `--no-color`                                 | Disable terminal colors                           |

`--select all` still does not select blocked paths and requires explicit dangerous
inclusion for dangerous matches. A `--yes` run with dangerous items selected
refuses unless `--allow-dangerous` is also passed. Git-tracked content and
project files are always blocked. Read the plan's actual selection before applying.

Every artifact carries when its project was last worked on: git metadata (index,
HEAD, reflog, and merge/commit state) plus a bounded walk of the project's own
non-generated source files, never its build output. A rebuild does not make a
forgotten project look busy, and editing a nested source file keeps the project
active. If a project's activity cannot be proven (for example, the bounded
source check hits its depth, directory, or entry limit, hits an unreadable
folder, or finds no readable signal), its idle time is shown as unknown (`?`),
it is never treated as idle, and `--idle` never selects it. `--idle 30d` keeps
the selection to projects proven untouched for 30 days; active and unknown
projects stay listed, unselected. The scan report shows each project's idle
time, warns when the selection includes projects worked on today, and shows how
much would be cleared from idle projects alone.

`--yes` skips the plain CLI confirmation. `--force-large` overrides the configured
size ceiling and requires `--yes`; these are deliberate automation options, not
recommended first-run defaults. The UI always confirms its apply actions.

`--cold` is a developer benchmarking option. It refreshes engine probing and
attempts an OS page-cache drop where permitted. It is not a normal performance
optimization, and a failed cache drop does not prove cold-storage behavior.

## Exit status

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| 0    | Successful command                                      |
| 1    | Aborted operation                                       |
| 2    | Guardrail rejection, including scan resource exhaustion |
| 3    | Invalid configuration or plan                           |
| 4    | Other failure                                           |
| 5    | Warning result                                          |

For apply, also inspect the report: interruption can produce a mixture of deleted,
failed, covered and unattempted candidates. Never interpret partial output or an
unconfirmed process termination as a complete successful cleanup.
