---
title: Terminal UI
description: Review streaming results, select by scope, and confirm a single artifact or queue.
---

Open the UI in a terminal with interactive stdin and stdout:

```sh
sweep ui .
```

The left pane narrows the current scope. The right pane lists matched artifacts.
Results appear while scanning, then sizes fill in. A checked box (`[x]`) means queued;
it does not mean deleted. The next symbol shows risk: `✓` safe, `!` caution,
`✗` dangerous, and `⊘` blocked. Risk and queue state remain distinct when a row
is focused or color is disabled. A size prefixed with `~` is incomplete or approximate.
An `INCOMPLETE` scan cannot apply or export a cleanup plan.

The sidebar separates items from bytes: `535 of 3,192 items queued` can be
`99% of bytes` when a few large artifacts contain almost all the measured
data. This is queue coverage, not deletion or scan completion. During a scan,
the meter instead labels sizing progress; the number of discoveries can still
grow. Partial byte estimates do not display an exact coverage percentage.

Fresh interactive scans start with an empty queue. Choose **Queue safe items**
for recognized safe artifacts in the current view, or use individual checkboxes.
Selection is explicit even when a scanner's default plan policy proposes items.

Enter opens the focused item's details or browses a folder. **Review queue (N)**
opens confirmation for the **whole queue**. Ctrl+Enter is a shortcut when the
terminal sends that chord distinctly; the button and Ctrl+K / F2 menu work without it.
`x` or `d` opens confirmation
for **only this item**, including inside inspect. The single-item dialog says
how many other items stay queued, and the result says how many remain queued.
Inside confirmation, press `y` to proceed or `n` / Esc to cancel. Enter gives
a reminder; it does not confirm a destructive operation.

While applying, Sweep shows preparation, completed artifact operations,
elapsed time and the active path. A large directory can remain at `0 of 1`
completed artifacts while work continues inside it. Press `m` to pause or resume
loader animation; counts, elapsed time and cancellation continue either way.
Supported native Linux engines also show successful entries removed
inside that artifact, including files, directories and symlinks. This count
is not a byte percentage or an estimate of physical disk space reclaimed.
Other backends show elapsed activity without inventing a per-file count.
The final report decides which artifacts completed.

Esc, Ctrl+C or the stop control requests cancellation and keeps the UI open
for the report. Completed deletions are not undone. Continuous writers or
path changes can leave an artifact partially removed; pause builds and sync
jobs in the selection before cleaning.

To review larger artifacts first without hiding them by default, use `/` and
enter `>1MiB`, or sort by size. Small or empty artifacts remain available for
deliberate cleanup. Filters narrow the view; applying the queue still includes
queued items outside that view.

## Projects first

`sweep ui` opens on your projects, not on a wall of folders. Each row is one
project (a git work tree, or the nearest folder with a manifest), grouped into
**Idle 30+ days** and **Worked on recently**, biggest first. The line at the top
says how much you can reclaim, how much of it sits in idle projects, and once
you queue something, how much is queued.

- Space queues a whole project's safe and caution items, or unqueues them.
- Enter opens a project to show its artifacts by path; Space then queues one.
- `i` queues every safe item in projects idle 30+ days.
- `b` switches to the full view: folder tree, columns, risk legend, removal by
  item, ranges and patterns. `b` again comes back. The queue is shared.

The header names DRY RUN and TRASH modes in both views. To open on the full
view, run `sweep ui --view full`.

## Everyday controls

| Key                 | Action                                             |
| ------------------- | -------------------------------------------------- |
| Up / Down           | Move the artifact cursor                           |
| Home / End          | First / last row                                   |
| Page Up / Page Down | Move one viewport                                  |
| Space               | Queue or unqueue the focused artifact              |
| Tab / Shift+Tab     | Change pane focus                                  |
| `/`                 | Filter candidates                                  |
| `i`                 | Inspect path, kind, reasons and selection          |
| Ctrl+K / F2         | Search actions, settings and shortcuts             |
| Ctrl+O              | Switch to another folder (fuzzy search or a path)  |
| Backspace           | Browse one folder up; from the top, all folders    |
| `f`                 | Filter by risk, kind, size or age                  |
| `x` or `d`          | Request confirmation for just the focused artifact |
| Enter               | Open item details or browse a folder               |
| Ctrl+Enter          | Review the queued selection, where supported       |
| `s` / `a`           | Queue safe / visible safe+caution                  |
| `u`                 | Unqueue everything, including hidden artifacts     |
| `U` (Shift-U)       | Unqueue visible artifacts; keep hidden selections  |
| `o`                 | Cycle size, name and age sort                      |
| `m`                 | Pause or resume activity animation                 |
| `r`                 | Rescan, including current pattern edits            |
| `p`                 | Open the pattern catalog                           |
| `S`                 | Save the current queue as a plan                   |
| `y`                 | Copy focused path via terminal clipboard support   |
| `?`                 | Show complete help                                 |
| Esc                 | Close or unwind one layer                          |
| `q` / Ctrl-C        | Quit; during apply, request cancellation           |

Arrow keys are the primary navigation. Vim-style aliases are available in help.
Modified letters do not activate plain-letter actions: Ctrl+S does not queue
items, and Ctrl+Y does not confirm removal. Text inputs retain their editing
chords. Ctrl+U / Ctrl+D page lists; Ctrl+C cancels active work.
Mouse wheel moves the cursor as well as the viewport. The scrollbar supports
seeking; an item cannot stay selected off-screen because the viewport moved alone.

## Switching folders

Ctrl+O opens **switch folder** without leaving the session. It lists the
folder one level up, folders you cleaned before, projects inside the current
folder (two levels deep) and projects beside it. Type to fuzzy-match, or type
a path such as `~/code` or `../api` to go anywhere; a path completes from the
folders around it. Enter rescans there.

A switch runs the same checks as `sweep ui <path>`: protected roots and
unreadable folders are refused in the card, and the new folder's own `.sweeprc`
applies. The queue starts empty; nothing queued in the previous folder is
removed. A switch waits while a cleanup is running. Recent folders come from
the cleanup history Sweep already keeps; the switcher stores nothing new.

## Color and motion preferences

Sweep uses the terminal's font and size. Theme selection (`t`) cycles dark,
light and automatic backgrounds. A nonempty `NO_COLOR` environment variable
uses neutral colors; symbols and labels still identify risk, focus and queue state.
Theme, sorting and animation changes are saved on normal session exit in
`ui-preferences.json` under Sweep's configuration directory. Paths, selections,
filters and deletion modes are not saved there. Invalid or unsafe preference
files use defaults. If saving fails, Sweep reports it without changing the
cleanup outcome. A hard-killed session may lose unsaved appearance changes.

To start with loader animation paused:

```sh
SWEEP_REDUCED_MOTION=1 sweep ui .
```

PowerShell uses `$env:SWEEP_REDUCED_MOTION = '1'` before running `sweep ui .`.
The `m` key changes the animation preference. It also
works during confirmation and deletion. Search and pattern inputs keep `m`
as ordinary text. Keyboard navigation, queue changes and dialogs appear instantly.

The inspector shows the scan root and artifact path separately, wraps long
values and keeps its action hints visible. Page Up / Page Down scroll its details.

## Mouse controls and actions

- Click an artifact name to focus it; repeated name clicks do not queue it.
- Click its checkbox to queue or unqueue it. Right-clicks and drags do not toggle selection.
- Click a folder name to browse it, its arrow to expand it, or its checkbox to toggle eligible subtree items.
- Choose **Actions** or press Ctrl+K / F2, then type an action or shortcut to find filtering, selection, sorting, patterns and appearance settings.
- Use **Previous** and **Next** to reach every menu page by mouse. Keyboard arrows and Tab also navigate it.
- **Current folder details** shows the full path and current filtered counts when the sidebar label is shortened.

Folder checkboxes exclude dangerous and blocked items. They leave separately
queued dangerous items untouched when toggling off; use **Clear queue in this
view** or **Clear whole queue** to clear those selections explicitly.
The queue covers the whole target. Browsing and filters change the view, not the
queue; confirmation names queued items outside the current view. Confirmation
captures the reviewed IDs and paths, and applying leaves the browsed folder intact.
At less than 40 columns or 12 rows, confirmation asks you to resize before
authorizing removal. Cancelling remains available.

If you configured a size ceiling, confirmation offers **Override size ceiling**
(`f`). It applies only to this reviewed operation, then resets. You still confirm
the same item IDs and paths. The override does not disable protected-path,
identity, mount or resource checks. Use **Restore size ceiling** to reverse the
choice before confirming. There is no default byte ceiling.

## Remove just the item you inspected

1. Move to an artifact and press `i`.
2. Read its full path and match reasons.
3. Press `x` or `d` inside inspect.
4. Read the one-artifact confirmation and choose delete or trash.
5. Confirm with `y`, or use Esc to cancel.

Inspect pins the artifact ID it displays. This action does not add the current
scope, a collapsed group, or other queued items to the request. Group headers,
blocked candidates and incomplete scans cannot use it. It removes a matched file
or directory artifact; Sweep is not a general-purpose file browser.

## Work with scopes and filters

In the scope pane, Right expands a folder and then moves to its first child;
Left collapses it or moves to its visible parent. Size updates keep the cursor
on the same folder while ordering changes. `u` works from either the artifact
list or scope pane. During scanning it also prevents later discoveries from
automatically repopulating the queue. `U` affects currently visible artifacts;
new discoveries still follow the scan's normal selection policy.

Entering a scope changes what you see. Space on a scope queues or unqueues its
eligible subtree. Hiding an item with a filter does not necessarily unqueue it:
read the confirmation's queued totals before applying a whole selection.

Terms are separated by spaces and combined. Examples:

```text
kind:target
path:apps/ >100MB
older:30d is:queued
risk:dangerous !path:vendor/
```

Use `older:`, `newer:`, `is:symlink`, `is:stub`, `is:unqueued` and size comparisons
when useful. Unknown modification times do not match age filters. Bulk selection
and visual ranges skip dangerous and blocked entries; deliberately select risky
items one at a time if you have verified them.

## Feedback and recovery

Sizes and counts update progressively, while rows keep discovery order until the
scan finishes. Esc closes one layer at a time and never quits. In the confirmation,
`t` switches deletion versus local trash. Read the displayed verb before `y`.

After a scan error, dismissing the dialog keeps the scan incomplete. Narrow the
root and rescan. During apply, cancellation stops new candidates after the current
operation settles; already deleted contents cannot be restored by cancellation.

Queue and single-artifact deletion stay in the interactive session. The apply
view shows an animated activity indicator, elapsed time, the current artifact,
completed removal counts and estimated bytes removed or moved. Counts describe
whole artifacts, not a percentage of files inside an active directory.

Press Ctrl-C to stop admitting new removals. The view changes to **Stopping**
and remains open until in-flight work settles and its report arrives. Completed
deletions are not undone. The list removes confirmed deleted or covered rows,
retains failed and unattempted rows, and shows the final outcome counts. If the
backend returns no reliable report, rescan before another apply.

Before applying, confirmation shows the configured GiB ceiling and previews
high-risk items before smaller safe items, with risk labels and estimated sizes.
Current size is checked again before removal unless an explicit launch override
was authorized. Validation and sizing show their current path and item progress.
A known size refusal or lock conflict removes nothing and keeps the queue; reduce
the queue, adjust the reviewed ceiling, or inspect the held session. An unknown
outcome still requires a rescan. Ctrl-C stops scheduling without rolling back
completed deletions.

If the interactive view fails during removal, Sweep stops scheduling work and
waits for the engine's report before closing the terminal. The exit summary keeps
known deletion counts and reports the view failure. If the engine report is also
unavailable, it marks the filesystem outcome unknown; inspect the recovery journal
and disk before retrying.

The artifact pane labels the folder being viewed and the current sort order.
In the sidebar, `›` beside a checkbox marks that active view. The highlighted
keyboard row is only a navigation cursor: Up / Down and scrollbar dragging do
not browse or queue it. Enter or clicking its name opens the folder.
