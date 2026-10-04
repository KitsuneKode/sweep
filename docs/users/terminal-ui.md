---
title: Terminal UI
description: Review streaming results, select by scope, and confirm a single artifact or queue.
---

Open the UI in a terminal with interactive stdin and stdout:

```sh
sweep ui .
```

The left pane narrows the current scope. The right pane lists matched artifacts.
Results appear while scanning, then sizes fill in. A queued dot means selected;
it does not mean deleted. A size prefixed with `~` is incomplete or approximate.
An `INCOMPLETE` scan cannot apply or export a cleanup plan.

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
| `x` or `d`          | Request confirmation for just the focused artifact |
| Enter               | Request confirmation for the queued selection      |
| `s` / `a`           | Queue safe / visible safe+caution                  |
| `u`                 | Unqueue everything, including hidden artifacts     |
| `U` (Shift-U)       | Unqueue visible artifacts; keep hidden selections  |
| `o`                 | Cycle size, name and age sort                      |
| `r`                 | Rescan, including current pattern edits            |
| `p`                 | Open the pattern catalog                           |
| `S`                 | Save the current queue as a plan                   |
| `y`                 | Copy focused path via terminal clipboard support   |
| `?`                 | Show complete help                                 |
| Esc                 | Close or unwind one layer                          |
| `q` / Ctrl-C        | Quit; during apply, request cancellation           |

Arrow keys are the primary navigation. Vim-style aliases are available in help.
Mouse wheel moves the cursor as well as the viewport. The scrollbar supports
seeking; an item cannot stay selected off-screen because the viewport moved alone.

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
