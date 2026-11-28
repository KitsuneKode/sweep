---
title: Terminal UI
description: Review projects, queue artifacts deliberately, and confirm every removal.
---

Open the UI in a terminal with interactive stdin and stdout:

```sh
sweep ui .
```

The **projects view** is the default. The **full view** is available with `b` or at startup:

```sh
sweep ui . --view full
```

Both views share one queue. Results stream in while scanning. A checked row means queued, not deleted. Risk is shown with `✓` safe, `!` caution, `✗` dangerous, and `⊘` blocked. A size prefixed with `~` is partial or approximate. An incomplete scan cannot apply or export a saved plan.

Direction C+ visual refresh work is planned for 0.6.0. The interaction contract on this page remains the stable contract: Esc unwinds, destructive actions confirm, and the queue is explicit.

## Projects view

The projects view groups artifacts by the project that owns them. A project is a git work tree when one exists, otherwise the nearest folder with a project manifest. Your home folder is never adopted as a project.

Sections are:

- **Finished worktrees**: clean linked worktrees whose commits are proven merged and whose project has been quiet for at least 24 hours.
- **Idle 30+ days**: projects whose last proven activity is outside the idle window.
- **Worked on recently**: projects with proven recent activity.
- **No activity found**: projects whose activity could not be proven. They show `?` and are never treated as idle.

The header shows reclaimable bytes from safe and caution artifacts. Guarded bytes from dangerous and blocked artifacts are shown separately. Once you queue artifacts, the header and bars show the queued share.

Linked worktrees name their repository. `app · merged` means the worktree is proven merged. `app · branch missing` means its remote tracking branch is missing and it is never treated as finished. `app · worktree` means no finished-state proof applies. Sweep removes build output only, never the worktree or branch.

### Projects view keys

| Key                                    | Action                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------- |
| Up / Down or `k` / `j`                 | Move the project or artifact cursor                                         |
| Page Up / Page Down or Ctrl+U / Ctrl+D | Move one viewport                                                           |
| Home / End or `g` / `G`                | First or last row                                                           |
| Space                                  | Queue or unqueue the project or focused artifact; open a folded section row |
| Enter                                  | Open artifact details, a project, or a folded section                       |
| Right / `l`                            | Open a project or folded section                                            |
| Left / `h`                             | Close an opened project or return to its row                                |
| `i`                                    | Queue safe artifacts in projects idle 30+ days                              |
| `x` or `d`                             | Request confirmation for only the focused artifact or project               |
| `c` or Ctrl+Enter                      | Review the whole queue                                                      |
| `s`                                    | Queue safe artifacts                                                        |
| `a`                                    | Queue visible safe and caution artifacts                                    |
| `u`                                    | Clear the whole queue                                                       |
| `U`                                    | Clear visible queued artifacts and keep hidden selections                   |
| `/`                                    | Filter artifacts                                                            |
| `f`                                    | Open risk, kind, size, age, and queue filters                               |
| `o`                                    | Cycle size, name, and age sort                                              |
| `1` / `2` / `3` / `4`                  | Show all, safe, caution, or dangerous risk tiers                            |
| `S`                                    | Save the queue as a plan                                                    |
| `b`                                    | Switch to the full view                                                     |
| `r`                                    | Rescan                                                                      |
| `E`                                    | Switch between the JavaScript and Rust engines and rescan                   |
| `t`                                    | Cycle dark, light, and auto themes                                          |
| `m`                                    | Pause or resume activity animation                                          |
| Ctrl+O                                 | Switch scan folder                                                          |
| Ctrl+K or F2                           | Search actions and settings                                                 |
| `?`                                    | Show help                                                                   |
| Esc                                    | Close one layer or unwind one narrowing step                                |
| `q` or Ctrl+C                          | Quit; during apply, request cancellation                                    |

In the projects view, `i` means idle queue. Artifact inspection opens with Enter on an artifact row. Keys used only by the full view, such as `v`, `y`, and `p`, do not act on hidden rows in the projects view.

## Full view

The full view has a folder scope pane and an artifact list. Use it when you need folder-level review, custom patterns, visual ranges, or artifact-level inspection.

Folder checkboxes affect eligible artifacts in that subtree. Dangerous and blocked artifacts are excluded from bulk gestures. A hidden artifact can remain queued even when it is outside the current folder or filter. Confirmation names queued artifacts outside the visible view.

### Full view keys

| Key                                    | Action                                                        |
| -------------------------------------- | ------------------------------------------------------------- |
| Up / Down or `k` / `j`                 | Move the artifact or folder cursor                            |
| Page Up / Page Down or Ctrl+U / Ctrl+D | Move one viewport                                             |
| Home / End or `g` / `G`                | First or last row                                             |
| Tab / Shift+Tab                        | Move between artifact list, sidebar, and search               |
| Space                                  | Queue or unqueue the focused artifact, folder scope, or group |
| Enter                                  | Open item details, browse a folder, or fold a group           |
| `i`                                    | Inspect path, kind, risk reasons, and selection state         |
| `x` or `d`                             | Request confirmation for only the focused artifact            |
| `c` or Ctrl+Enter                      | Review the whole queue                                        |
| `s`                                    | Queue safe artifacts                                          |
| `a`                                    | Queue visible safe and caution artifacts                      |
| `u`                                    | Clear the whole queue                                         |
| `U`                                    | Clear visible queued artifacts and keep hidden selections     |
| `v`                                    | Start or cancel a visual range; Space applies it              |
| `1` / `2` / `3` / `4`                  | Show all, safe, caution, or dangerous risk tiers              |
| `h` / Left                             | Collapse a group or folder                                    |
| `l` / Right                            | Expand a group or folder                                      |
| `w` / `e`                              | Collapse or expand all groups in the artifact list            |
| `/`                                    | Filter artifacts                                              |
| `f`                                    | Open filter facets                                            |
| `o`                                    | Cycle size, name, and age sort                                |
| `p`                                    | Open the pattern catalog                                      |
| `S`                                    | Save the queue as a plan                                      |
| `y`                                    | Copy the focused path when the terminal supports it           |
| Backspace                              | Browse one folder up                                          |
| `b`                                    | Return to the projects view                                   |
| `r`                                    | Rescan                                                        |
| `E`                                    | Switch engines and rescan                                     |
| `t`                                    | Cycle theme                                                   |
| `m`                                    | Pause or resume activity animation                            |
| Ctrl+O                                 | Switch scan folder                                            |
| Ctrl+K or F2                           | Search actions and settings                                   |
| `?`                                    | Show help                                                     |
| Esc                                    | Close one layer or unwind one narrowing step                  |
| `q` or Ctrl+C                          | Quit; during apply, request cancellation                      |

Ctrl+U and Ctrl+D page lists. Text inputs keep their editing chords. Modified letters do not trigger plain-letter actions: Ctrl+S does not save a plan, and Ctrl+Y does not confirm removal.

## Confirmation and apply

Every destructive action opens a confirmation. `c` reviews the whole queue. `x` or `d` reviews only the focused artifact, or only the focused project in the projects view. Other queued artifacts stay queued.

Inside confirmation:

- `y` proceeds after the dialog is visible.
- `n`, `q`, or Esc cancels.
- `t` switches permanent deletion and local trash.
- `f` overrides a configured size ceiling for this reviewed operation when an override is allowed.
- Enter only reminds you to choose. It never confirms removal.

The confirmation names the scan target, count, estimated bytes, dangerous artifacts, deletion mode, and size ceiling. Paths and candidate IDs are captured from that review. Applying leaves the browsed folder or filter unchanged.

During apply, Sweep shows elapsed time, completed artifact operations, and the active path. Supported native Linux engines can also show entries removed inside the active artifact. That count is not a byte percentage. A large directory can remain at `0 of 1` completed artifacts while work continues inside it.

Ctrl+C or Esc during apply requests cancellation. Sweep stops scheduling new artifacts and waits for the apply report. Completed deletions are not rolled back. Read the final counts for deleted, covered, failed, and unattempted artifacts. If no trustworthy report arrives, treat the outcome as unknown and rescan before retrying.

## Filters and search

Press `/` and type space-separated terms. Every term must match. Examples:

```text
kind:target
path:apps/ >100MiB
older:30d is:queued
risk:dangerous !path:vendor/
```

Useful operators include `kind:`, `risk:`, `path:`, `older:`, `newer:`, `is:queued`, `is:unqueued`, `is:symlink`, `is:stub`, and size comparisons. Unknown modification times do not match age filters. Filtering changes the view, not the queue.

Press `f` to choose facets with counts and sizes. This is often clearer than typing a query when reviewing large trees.

## Pattern catalog

Press `p` in the full view to edit which artifact names Sweep scans for. Space or Enter toggles the focused catalog pattern. `/` filters the catalog. `a` adds a custom pattern. `d` or `x` removes a custom pattern. `w` or `W` reviews and saves changes to `.sweeprc`.

Catalog entries such as `dist`, `build`, and `.venv` remain dangerous because their names can hold authored files. Enabling a pattern only makes it visible. It never makes it safe by default. Read [Configuration](configuration.md) before saving pattern changes.

## Switching folders

Ctrl+O opens the folder switcher. It lists the parent folder, folders you cleaned before, projects inside the current folder, and projects beside it. Type to fuzzy-match, or enter a path such as `~/code` or `../api`.

A switch runs the same guardrails as starting `sweep ui <path>`. Protected roots and unreadable folders are refused. The new folder's `.sweeprc` applies. The queue starts empty. Nothing queued in the previous folder is removed. A switch waits while cleanup is running.

## Size cache

After a completed scan, the UI stores measured artifact sizes in `size-cache.json` under Sweep's configuration directory. The next scan can show a size as soon as the artifact is found, marked `~`, then replace it with a fresh measurement.

A cached size is used only for the same filesystem identity. A replaced folder starts unknown. The CLI and every removal always measure fresh. Delete `size-cache.json` to clear it.

## Color, graphics, and motion

Sweep uses the terminal's font and size. Themes are:

- `auto`: follows the terminal background and transparency.
- `dark`: Sweep's solid dark canvas.
- `light`: Sweep's solid light canvas.

Pass `--theme auto`, `--theme dark`, or `--theme light`, or set `SWEEP_THEME`. Inside the UI, `t` cycles themes. A nonempty `NO_COLOR` uses neutral colors, and symbols and labels still carry meaning.

Start with activity animation paused:

```sh
SWEEP_REDUCED_MOTION=1 sweep ui .
```

Press `m` to pause or resume activity animation during the session. Keyboard navigation, queue changes, and dialogs do not wait for animation.

Theme, sort, and animation preferences are saved on normal session exit in `ui-preferences.json` under Sweep's configuration directory. Paths, queues, filters, and deletion modes are not saved there.

## Mouse controls

- Click an artifact name to focus it. Click its checkbox to queue or unqueue it.
- Click a folder name to browse it, its arrow to expand it, or its checkbox to toggle eligible subtree artifacts.
- Mouse wheel moves the cursor as well as the viewport. The scrollbar supports seeking.
- Footer key hints and action menu entries can be clicked. Mouse actions use the same code path as keyboard actions.

At less than 40 columns or 12 rows, confirmation asks you to resize before authorizing removal. Cancellation remains available.

## Scan and apply failures

After a scan error, dismissing the dialog keeps the scan incomplete. Narrow the scan target and press `r` to rescan. Export and apply stay blocked for that scan generation.

If the interactive view fails during removal, Sweep stops scheduling work and waits for the engine report before closing. If the report is unavailable, the filesystem outcome is unknown. Inspect the recovery journal and disk before retrying. Read [Safety and trash](safety.md) for interruption and recovery rules.
