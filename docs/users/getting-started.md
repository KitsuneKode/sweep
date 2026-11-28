---
title: Getting started
description: Install Sweep and complete your first read-only review.
---

## Install

### Standalone binary

The standalone binary includes the terminal UI and native engine. It does not need Node.js or Bun.

macOS and Linux:

```sh
brew install kitsunekode/tap/sweep
# or:
curl -fsSL https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.sh | sh
```

Windows x64, PowerShell:

```powershell
irm https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.ps1 | iex
```

To inspect the Windows installer before running it:

```powershell
Invoke-WebRequest -Uri https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Scoop is available from 0.5.4:

```powershell
scoop bucket add kitsunekode https://github.com/KitsuneKode/scoop-bucket
scoop install sweep
```

The installers download the matching release asset, verify its SHA-256 checksum, test the staged binary with `--version`, and only then replace an existing install. [Platforms](platforms.md) covers direct release downloads, glibc and musl support, Alpine packages, SmartScreen, and build provenance verification.

### npm or Bun

Use Node.js 22.12 or newer for CLI commands:

```sh
npm install -g @kitsunekode/sweep
sweep --version
```

Use Bun for the full-screen terminal UI without a standalone binary:

```sh
bun add -g @kitsunekode/sweep
sweep ui .
```

You can try it without a global install:

```sh
bunx @kitsunekode/sweep ui .
npx @kitsunekode/sweep --dry-run .
```

`@opentui/core` is an optional dependency. Bun and Yarn 4 install it in normal installs. On Node older than 26.4, npm, pnpm, and Yarn 1 can leave it unlinked or unmet while still installing the CLI. CLI commands such as `sweep scan`, `sweep clean`, `sweep status`, `sweep plan`, and `sweep apply` still run on Node.js 22.12+. Use Bun or a standalone binary for the terminal UI.

## Scan before changing anything

Run this in a project folder, or replace `.` with another scan target:

```sh
sweep scan .
```

This only reports candidates. Default patterns include generated names such as `node_modules`, `.next`, `.turbo`, `target` in Cargo projects, and `*.tsbuildinfo`. Generic names such as `dist` and `build` are opt-in because they can contain authored files.

For a compact answer instead of a full plan:

```sh
sweep status .
```

Status reports reclaimable bytes, guarded artifacts, scan coverage, finished worktrees, and projects idle for the selected window. Use `sweep status . --json` in scripts.

## Preview a cleanup

```sh
sweep --dry-run .
```

Check the scan target, selected artifacts, risk tiers, and estimated sizes. `~` means a size is partial or approximate. Nothing is removed.

## Review in the terminal UI

```sh
sweep ui .
```

The projects view opens first. Projects are grouped as **Finished worktrees**, **Idle 30+ days**, **Worked on recently**, and **No activity found**. The queue starts empty.

1. Move with Up and Down.
2. Press Space on a project to queue its safe and caution artifacts.
3. Press Enter to open a project and review its artifacts.
4. Press `i` to queue safe artifacts in projects idle for at least 30 days. Projects with unknown activity show `?` and are never queued by this key.
5. Press `c` to review the whole queue.
6. Press `y` only after checking the target, paths, bytes, and deletion mode. Press Esc or `n` to cancel.

Press `b` for the full view, where you can browse folders, filter artifacts, edit patterns, use visual ranges, and save a plan. Press `b` again to return. Read [Terminal UI](terminal-ui.md) for every key.

## Your first cleanup

Choose a small project and close active build processes. Run:

```sh
sweep clean . --trash
```

Sweep asks for confirmation and moves selected artifacts into a `.sweep-trash-<timestamp>` directory under the scan target. This local trash is not the operating system recycle bin and still occupies disk space. Inspect it before deleting it. Read [Safety and trash](safety.md) before relying on recovery.

For permanent deletion, omit `--trash` after you are comfortable with the review:

```sh
sweep clean .
```

## Shell completions

Print the script for your shell:

```sh
sweep completions bash
sweep completions zsh
sweep completions fish
```

Save it where your shell already loads completions. Homebrew installs completions for supported shells. For zsh, the destination directory must be on `fpath`.

## If something looks wrong

Run read-only diagnostics first:

```sh
sweep doctor .
sweep doctor . --json
```

Doctor checks config trust, engine resolution, OpenTUI, filesystem identity support, held apply locks, and a small scan preview. [Troubleshooting](troubleshooting.md) starts from the message you see.
