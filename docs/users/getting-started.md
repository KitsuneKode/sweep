---
title: Getting started
description: Install Sweep and complete your first read-only review.
---

## Install

For command-line scans and cleanup, use Node.js 20.3 or newer:

```sh
npm install -g @kitsunekode/sweep
sweep --version
```

If you use Bun:

```sh
bun add -g @kitsunekode/sweep @opentui/core
sweep --version
```

The npm package includes bundled JavaScript and selects a matching optional Rust
engine package for supported platforms. Keep optional dependencies enabled if you
want the native engine. [Platforms](platforms.md) explains fallback requirements.

The npm-installed full-screen UI needs Bun and `@opentui/core`. Install the
optional UI peer where your Sweep installation can resolve it. If you only need
scans and saved plans, Node is enough. A qualified standalone release embeds
these dependencies; see the release's checksum and platform instructions.

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

Inspect an artifact with `i`. Press `x` to request deletion of that artifact,
then read the confirmation. Nothing is removed until you confirm.

## Your first cleanup

Choose a small project and close active build processes. Run:

```sh
sweep clean . --trash
```

Sweep asks for confirmation and moves selected items into a `.sweep-trash-*`
directory under the target. This uses local disk space; it is not the operating
system recycle bin. Read [Safety and trash](safety.md) before relying on recovery.

Use `sweep doctor .` if configuration or engine selection is unclear.
