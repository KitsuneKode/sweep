# sweep

> Clear the build output of projects you stopped working on. Nothing you wrote, and nothing you did not choose.

[![CI](https://github.com/KitsuneKode/sweep/actions/workflows/ci.yml/badge.svg)](https://github.com/KitsuneKode/sweep/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@kitsunekode/sweep)](https://www.npmjs.com/package/@kitsunekode/sweep)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

`sweep` finds `node_modules`, `target`, `.next`, `.turbo` and other build output
across a folder of projects, tells you which projects nobody has touched in
months, and removes only what you pick. A scan never changes your disk.

```bash
npx @kitsunekode/sweep --dry-run ~/Projects   # see what it would clear; changes nothing
```

Or install it and review in the terminal UI with `sweep ui ~/Projects`:

```
  sweep  ~/Projects                                                         31.0 GiB free

  57.4 GiB you can reclaim  ·  112 projects  ·  586 MiB idle 30+ days, i queues it

  Idle 30+ days                                                26 projects  ·  586.3 MiB
  › ○  template-nextjs-monorepo   244.7 MiB    30d   templates     .turbo · .next +1
    ○  kata-machine               194.5 MiB    7mo   dsa           node_modules
       + 18 more projects  ·  2.3 MiB

  Worked on recently                                            86 projects  ·  56.9 GiB
    ○  sweep                        4.9 GiB     3m   cli-tools     ! 23 caution  target +4
```

Space queues a project, Enter opens it, `i` queues every idle project,
Ctrl+Enter (or the Ctrl+K menu) reviews the queue. Every removal is confirmed and ends in a receipt.

## Why sweep

- **It knows what you still use.** Each project's idle time comes from its git
  history and its own files, never from its build output, so a reinstall does
  not make a forgotten project look busy. `sweep --idle 30d` selects only
  projects nobody has touched for a month.
- **It will not remove your work.** Anything git tracks, project files (`src`,
  manifests, lockfiles, `.env*`), version-control folders and system roots are
  blocked whatever a pattern or flag says. Each path is checked again right
  before removal.
- **It is fast.** A Rust engine finds and sizes 4,000 artifacts across 65,000
  folders in under a second, and the terminal UI fills in while it scans.
- **It fits scripts and agents.** Plans are JSON you can save, inspect and
  apply later; exit codes are stable; [`llms.txt`](https://sweep.kitsunekode.in/llms.txt)
  and an agent skill teach coding agents the same safe workflow.

## Install

```bash
brew install kitsunekode/tap/sweep     # macOS and Linux
curl -fsSL https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.sh | sh
npm install -g @kitsunekode/sweep      # commands only, Node.js 20.3+
bun add -g @kitsunekode/sweep @opentui/core   # commands and the terminal UI
```

Homebrew and the install script fetch one self-contained binary with the
terminal UI built in (no Node or Bun needed, checksums verified). From npm,
every command runs on Node; `sweep ui` also needs Bun and `@opentui/core`.
Linux (x64, arm64), macOS (x64, arm64) and Windows (x64) are supported.

For coding agents: `npx skills add KitsuneKode/sweep`.

## Use it

```bash
sweep ui ~/Projects          # review and choose, projects first
sweep --dry-run              # see what a cleanup would remove; changes nothing
sweep --idle 30d             # clean only projects idle for 30 days or more
sweep --trash                # move to a local trash folder instead of deleting
sweep init                   # look around, then write a .sweeprc from your answers
```

| Command                       | What it does                                               |
| ----------------------------- | ---------------------------------------------------------- |
| `sweep` / `sweep clean`       | Scan, show what would go, confirm, remove                  |
| `sweep ui`                    | Interactive review; `--view full` opens the folder view    |
| `sweep scan`                  | Scan only; `--json` for a plan, `--json-stream` for events |
| `sweep plan`                  | Write a saved plan to stdout for a later `apply`           |
| `sweep apply --plan <file>`   | Apply a saved plan after re-checking every path            |
| `sweep inspect --plan <file>` | Show a plan's contents and totals without applying it      |
| `sweep init`                  | Scan, ask about each opt-in pattern, write `.sweeprc`      |
| `sweep stats`                 | Totals from your cleanup history                           |
| `sweep doctor`                | Check config, tools and engine                             |
| `sweep completions <shell>`   | Shell completions for bash, zsh or fish                    |

Common options: `--dry-run`, `--trash`, `--idle <age>`, `--yes` (skip the
prompt), `--pattern <name>`, `--ignore <name or path>`, `--json`. Removing
dangerous items without a prompt also needs `--allow-dangerous`, and every one is
named before it goes. [All commands and options](https://sweep.kitsunekode.in/docs/users/commands).

## What it cleans

On by default, because nobody writes these by hand: `node_modules`, `.next`,
`.nuxt`, `.svelte-kit`, `.turbo`, `.vite`, `.parcel-cache`, `.nyc_output`,
`target` (beside a `Cargo.toml`) and `*.tsbuildinfo`.

Opt in to generic names that can hold your own files (`dist`, `build`, `out`,
`coverage`, `__pycache__`, `.venv`, `.gradle` and more) with `sweep init`, a
`.sweeprc`, or `--pattern`. They are never pre-selected.

## Safety, in short

- Scans, plans, dry runs and browsing in the terminal UI never write.
- Blocked items cannot be queued at all; dangerous items only one at a time,
  behind a red confirmation.
- Every path is re-checked right before removal: a folder replaced, moved or
  turned into a symlink since the scan is refused, not removed.
- Symlinks are removed as links, never followed.
- Ctrl+C stops scheduling new removals; the receipt lists completed, failed
  and unattempted items separately.

[The full safety model](https://sweep.kitsunekode.in/docs/users/safety).

## Documentation

[sweep.kitsunekode.in/docs](https://sweep.kitsunekode.in/docs) covers the
terminal UI and its keys, configuration, automation and agents, trash and
recovery, troubleshooting and the measured benchmarks.

## Exit codes

`0` success · `1` aborted · `2` refused by a guardrail · `3` invalid config or
plan · `4` failure · `5` doctor warnings.

## License

MIT
