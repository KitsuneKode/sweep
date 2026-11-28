---
title: Getting started
description: Install Sweep and complete your first read-only review.
---

## Install

### Standalone binary (no Node or Bun required)

macOS and Linux (glibc 2.17+; Linux musl/Alpine downloads ship starting in
`v0.5.4+`, where minimal Alpine images need `apk add libstdc++ libgcc` before
`install.sh` because the musl standalone is dynamically linked):

```sh
brew install kitsunekode/tap/sweep
# or:
curl -fsSL https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.sh | sh
```

Windows (x64, PowerShell):

```powershell
irm https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.ps1 | iex
```

Or download and inspect `install.ps1` first (respects execution policy):

```powershell
Invoke-WebRequest -Uri https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

[Scoop](https://scoop.sh) support (`https://github.com/KitsuneKode/scoop-bucket`)
will be available starting in `v0.5.4+`:

```powershell
# Available from v0.5.4+:
scoop bucket add kitsunekode https://github.com/KitsuneKode/scoop-bucket
scoop install sweep
```

The standalone installers verify SHA-256 checksums and test `--version` on the
staged binary before replacing any existing install. You can also verify GitHub
build provenance attestations on any downloaded release binary or `.gz` archive
with the GitHub CLI (substitute `vX.Y.Z` with the release tag you downloaded):

```sh
gh attestation verify sweep-linux-x64.gz -R KitsuneKode/sweep --signer-workflow KitsuneKode/sweep/.github/workflows/cli-binaries.yml --source-ref refs/tags/vX.Y.Z
```

### npm or Bun

For command-line scans and cleanup, use Node.js 22.12 or newer:

```sh
npm install -g @kitsunekode/sweep
sweep --version
```

If you use Bun:

```sh
bun add -g @kitsunekode/sweep
sweep --version
```

The npm package includes bundled JavaScript and selects a matching optional Rust
engine package (including separate glibc and musl packages on Linux) for
supported platforms. Keep optional dependencies enabled if you want the native
engine. [Platforms](platforms.md) explains the Linux ABI floor and fallback
requirements.

The full-screen UI runs on Bun. `@opentui/core` is an optional dependency of
`@kitsunekode/sweep`: Bun (`bun add -g @kitsunekode/sweep`,
`bunx @kitsunekode/sweep ui .`) and Yarn 4 install it automatically. On Node
older than 26.4, pnpm and Yarn 1 skip linking it (Yarn 1 prints an engine
warning), and npm leaves `@opentui/core` unmet and may still extract a
`@opentui/core-<platform>` package unless `--omit=optional` is passed. In every
case, `sweep` installs and runs CLI commands (`sweep`, `sweep scan`,
`sweep clean`, `sweep plan`, `sweep apply`) on Node.js 22.12+. A standalone
release embeds the UI and native engine in one executable with no Node or Bun
required; see the release's checksum and platform instructions.

## Scan one project

Run this in a project you know, or replace `.` with its path:

```sh
sweep scan .
```

This only reports matches. Defaults include canonical generated names such as
`node_modules`, `.next`, `.turbo`, and `target`. Generic names such as `dist` and
`build` are opt-in because they can also contain authored files.

## Review a proposed cleanup

```sh
sweep clean . --dry-run
```

Check the target path, selected items and estimated size. Rebuilding dependencies
or build caches takes time even when their contents are regenerable.

For a visual review in an interactive terminal:

```sh
sweep ui .
```

The queue starts empty. The largest artifacts appear first. Choose **Queue safe
items**, or use the checkboxes to pick individual artifacts. Enter opens an
item's details; folder names change the view without changing your selection.
Choose **Review queue**, check its paths and deletion mode, then confirm. Nothing
is removed before confirmation. **Actions** (F2) exposes settings and shortcuts;
you can complete the review with the mouse.

To remove only one artifact, open its details and choose **Review removal**.
Other queued items stay queued. Watch the outcome rather than repeatedly
confirming: cancellation stops remaining work and does not restore completed
deletions. Read [Terminal UI](terminal-ui.md) for the complete interaction model.

## Your first cleanup

Choose a small project and close active build processes. Run:

```sh
sweep clean . --trash
```

Sweep asks for confirmation and moves selected items into a `.sweep-trash-*`
directory under the target. This uses local disk space; it is not the operating
system recycle bin. Read [Safety and trash](safety.md) before relying on recovery.

Use `sweep doctor .` if configuration or engine selection is unclear.
