---
title: Getting started
description: Install Sweep and complete your first read-only review.
---

## Install

Pick the line for how you install software. Every route except npm gives you
one self-contained program with the terminal UI built in: no Node, Bun or Rust
needed.

| You use                     | Install                                                                                             | You get                         |
| --------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------- |
| Arch Linux (and Manjaro, …) | `yay -S sweep-cli-bin` or `paru -S sweep-cli-bin`                                                   | Everything, updated by pacman   |
| Homebrew (macOS, Linux)     | `brew install kitsunekode/tap/sweep`                                                                | Everything, updated by brew     |
| Any Linux or macOS          | the install script below                                                                            | Everything                      |
| Windows                     | `sweep-win-x64.exe` from the [latest release](https://github.com/KitsuneKode/sweep/releases/latest) | Everything                      |
| Node.js                     | `npm install -g @kitsunekode/sweep`                                                                 | Commands; the UI also needs Bun |
| Bun                         | `bun add -g @kitsunekode/sweep @opentui/core`                                                       | Everything                      |

Check it worked with `sweep --version`.

### Arch Linux

`sweep-cli-bin` installs the released binary for x86_64 or aarch64 and checks
it against the release's checksum. Use your AUR helper:

```sh
yay -S sweep-cli-bin        # or: paru -S sweep-cli-bin
```

or build it by hand:

```sh
git clone https://aur.archlinux.org/sweep-cli-bin.git
cd sweep-cli-bin && makepkg -si
```

It conflicts with the AUR's `sweep` (an audio editor) and `sweep-bin` (a
minesweeper game): all three install `/usr/bin/sweep`.

### Homebrew

```sh
brew install kitsunekode/tap/sweep
```

`brew upgrade sweep` updates it; `brew uninstall sweep` removes it.

### Install script

```sh
curl -fsSL https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.sh | sh
```

It downloads the binary for your system, checks its SHA-256, and installs it
to `~/.local/bin` (set `SWEEP_INSTALL_DIR` to choose another folder). Run it
again to update.

### npm or Bun

```sh
npm install -g @kitsunekode/sweep                 # commands, on Node.js 20.3+
bun add -g @kitsunekode/sweep @opentui/core       # commands and the terminal UI
```

The package picks the precompiled Rust engine for your platform as an optional
dependency; keep optional dependencies enabled to use it. On Node, every
command works, but `sweep ui` needs Bun and `@opentui/core`.
[Platforms](platforms.md) explains the fallbacks.

### Updating and removing

| Installed with | Update                        | Remove                         |
| -------------- | ----------------------------- | ------------------------------ |
| AUR            | your helper's update (`yay`)  | `sudo pacman -R sweep-cli-bin` |
| Homebrew       | `brew upgrade sweep`          | `brew uninstall sweep`         |
| Install script | run it again                  | `rm ~/.local/bin/sweep`        |
| npm / Bun      | `npm i -g @kitsunekode/sweep` | `npm rm -g @kitsunekode/sweep` |

Sweep keeps preferences and history in its configuration directory:
`~/.config/sweep` (or `$XDG_CONFIG_HOME/sweep`), `%APPDATA%\sweep` on Windows.
Remove it too for a clean slate.

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
