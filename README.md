# sweep

> Clean build output from projects you no longer use, without removing your work.

[![CI](https://github.com/KitsuneKode/sweep/actions/workflows/ci.yml/badge.svg)](https://github.com/KitsuneKode/sweep/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@kitsunekode/sweep)](https://www.npmjs.com/package/@kitsunekode/sweep)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Sweep finds `node_modules`, `target`, `.next`, caches, and other generated artifacts across a folder of projects. It shows which projects are idle, what each artifact costs to rebuild, and what you can reclaim. Scanning never writes to disk. Removal only happens after you choose artifacts and confirm them, and every path is checked again before it is removed.

<!-- TODO(0.6.0): replace with C+ redesign screenshot when #167 merges. -->

![Sweep terminal UI demo](assets/demo.gif)

## Install

| Channel            | Command or asset                                                                                      | Notes                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| npm                | `npm install -g @kitsunekode/sweep`                                                                   | Node.js 22.12 or newer. CLI commands work without the optional UI dependency.                                                     |
| Bun                | `bun add -g @kitsunekode/sweep`                                                                       | Installs the optional UI dependency in normal Bun installs.                                                                       |
| bunx               | `bunx @kitsunekode/sweep ui .`                                                                        | Try the terminal UI without a global install.                                                                                     |
| Homebrew           | `brew install kitsunekode/tap/sweep`                                                                  | Standalone macOS and Linux binary with shell completions.                                                                         |
| Scoop (from 0.5.4) | `scoop bucket add kitsunekode https://github.com/KitsuneKode/scoop-bucket` then `scoop install sweep` | Windows x64.                                                                                                                      |
| `install.sh`       | `curl -fsSL https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.sh \| sh`                | Standalone macOS and Linux installer. Verifies the checksum and staged binary before replacing an existing install.               |
| `install.ps1`      | `irm https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.ps1 \| iex`                     | Standalone Windows x64 installer. Download and inspect the script first if you prefer.                                            |
| GitHub Releases    | [Release assets](https://github.com/KitsuneKode/sweep/releases)                                       | Standalone binaries for Linux glibc 2.17+ (x64, arm64), Linux musl (x64, arm64, from 0.5.4), macOS (x64, arm64), and Windows x64. |

Release assets are available raw and as `.gz` archives, each with a `.sha256` sidecar. Verify the checksum before running a direct download:

```sh
sha256sum sweep-linux-x64.gz
cat sweep-linux-x64.gz.sha256
```

Release binaries also carry GitHub build provenance attestations. Substitute `vX.Y.Z` with the release tag you downloaded:

```sh
gh attestation verify sweep-linux-x64.gz -R KitsuneKode/sweep --signer-workflow KitsuneKode/sweep/.github/workflows/cli-binaries.yml --source-ref refs/tags/vX.Y.Z
```

The standalone binary includes the terminal UI and native engine. It does not need Node.js or Bun. The npm package runs CLI commands on Node.js 22.12+ and uses optional native engine packages when available. For package manager edge cases, musl notes, and Windows SmartScreen details, read [Getting started](https://sweep.kitsunekode.in/docs/users/getting-started) and [Platforms](https://sweep.kitsunekode.in/docs/users/platforms).

## Quick start

| Command             | What it does                                                                  |
| ------------------- | ----------------------------------------------------------------------------- |
| `sweep --dry-run .` | Scans the current folder and previews the removal without changing anything.  |
| `sweep ui .`        | Opens the interactive projects view for review and selection.                 |
| `sweep status`      | Shows reclaimable bytes, guarded artifacts, idle projects, and scan coverage. |
| `sweep clean`       | Scans, asks for confirmation, then removes the selected artifacts.            |
| `sweep init`        | Scans first, asks about opt-in patterns, then writes a `.sweeprc`.            |
| `sweep doctor .`    | Checks configuration, engine trust, OpenTUI, and a read-only scan.            |

For a disposable first run, use `sweep --trash` instead of permanent deletion. Local trash is a `.sweep-trash-<timestamp>` folder inside the scan target, not the operating system recycle bin.

## What it cleans

Enabled by default because these names are machine-created and canonical: `node_modules`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.vite`, `.parcel-cache`, `.nyc_output`, `target` in Cargo projects, and `*.tsbuildinfo`.

Generic names stay opt-in because they can hold authored files: `dist`, `build`, `out`, `coverage`, `__pycache__`, `.venv`, `.gradle`, and others. Enable them with `sweep init`, `.sweeprc`, or `--pattern`. They are never pre-selected as safe.

## Safety in short

- Sweep never removes git-tracked files, project files such as manifests and `.env*`, version-control internals, operating-system roots, your home folder, or tool and package-manager homes. A directory candidate containing a git repository is at least dangerous and cannot be silently selected.
- Scans, saved plans, dry runs, and browsing in the terminal UI do not write to the scanned tree. Real cleanup always confirms unless you deliberately pass `--yes` in automation.
- Unknown is not selected. A project with unknown activity shows idle `?` and is excluded from `--idle`. A repository whose tracked status cannot be verified is never pre-selected and is checked again before removal.
- `--trash` moves artifacts into local trash instead of permanently deleting them. It still uses disk space until you remove that trash folder.
- There is no size ceiling by default. A configured ceiling is enforced against fresh measurements taken immediately before apply. Use `--max-size-gb <gib>` for one run or `--max-size-gb none` to remove a configured ceiling deliberately.
- On macOS and Linux, the native engine and every directory above it must be owned by you or root and must not be group- or world-writable. Under `sudo`, the invoking user from `SUDO_UID` is also accepted. The engine content is fingerprinted and checked again before destructive use. If these checks fail, `--engine auto` falls back to the JavaScript engine. Homebrew prefixes with group-writable folders therefore use the JavaScript engine until their permissions are tightened.

Read the full [safety model](https://sweep.kitsunekode.in/docs/users/safety).

## Numbers you can trust

Reclaimable means safe plus caution artifacts. Dangerous and blocked artifacts are shown separately as guarded and never added to reclaimable totals.

A `~` prefix means sizing is partial or approximate. Scan coverage is explicit when folders were skipped or bytes are incomplete.

Package managers such as pnpm and Bun can hardlink one store file into many `node_modules` directories. Sweep counts shared inodes once. When shared hardlinks reduce what removal can free, reports show `about X freed` beside the apparent size.

## Automation and agents

Use `sweep scan --json` or `sweep plan` for a saved plan, `sweep scan --json-stream` for progressive events, and `sweep apply --plan` after review. `sweep status --json` gives a compact summary. `sweep doctor --json` reports environment and trust checks. `sweep schema` exports the protocol schemas embedded in the installed CLI.

Exit codes are stable: `0` success, `1` aborted, `2` guardrail refusal, `3` invalid config or plan, `4` failure, and `5` doctor warnings.

`sweep widget --json` (0.6.0) will provide a bounded read-only snapshot for desktop widgets and panels. It is not available in 0.5.x.

Read [Automation and streaming JSON](https://sweep.kitsunekode.in/docs/users/automation). Coding agents can install the project skill with `npx skills add KitsuneKode/sweep`.

## Platforms

| Platform          | Support                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Linux x64 glibc   | glibc 2.17+                                                                                  |
| Linux arm64 glibc | glibc 2.17+                                                                                  |
| Linux x64 musl    | From 0.5.4. Minimal Alpine images need `apk add libstdc++ libgcc` for the standalone binary. |
| Linux arm64 musl  | From 0.5.4. Minimal Alpine images need `apk add libstdc++ libgcc` for the standalone binary. |
| macOS x64         | Standalone, npm, and Bun                                                                     |
| macOS arm64       | Standalone, npm, and Bun                                                                     |
| Windows x64       | Standalone, npm, and Bun. Windows ARM64 is not shipped.                                      |

The interactive UI needs a real terminal. The npm UI path needs Bun with the optional OpenTUI dependency. The standalone binary embeds both the UI and native engine.

## Documentation

- [Getting started](https://sweep.kitsunekode.in/docs/users/getting-started)
- [Terminal UI](https://sweep.kitsunekode.in/docs/users/terminal-ui)
- [Commands and saved plans](https://sweep.kitsunekode.in/docs/users/commands)
- [Safety and trash](https://sweep.kitsunekode.in/docs/users/safety)
- [Automation](https://sweep.kitsunekode.in/docs/users/automation)
- [Platforms and large trees](https://sweep.kitsunekode.in/docs/users/platforms)
- [Troubleshooting](https://sweep.kitsunekode.in/docs/users/troubleshooting)

## Contributing

Read [CONTRIBUTING](https://sweep.kitsunekode.in/docs/developer/contributing) for local setup, verification commands, and release rules. Report bugs in [GitHub issues](https://github.com/KitsuneKode/sweep/issues).

## License

[MIT](LICENSE)
