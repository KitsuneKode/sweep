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
