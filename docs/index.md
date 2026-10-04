---
title: Sweep documentation
description: Find disposable build output, review it, and clean up deliberately.
---

Sweep finds build artifacts across project trees so you can review what takes
space and remove the items you choose. It supports a plain CLI, saved plans,
streaming JSON, and an interactive terminal UI.

Start with a read-only scan. You do not need to configure anything to see
candidates, and finding an item never means it has already been deleted.

## Choose your next step

| I want to…                            | Read                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| Install and try a safe first scan     | [Get started](users/getting-started.md)                             |
| Review and remove one artifact        | [Use the terminal UI](users/terminal-ui.md)                         |
| Decide what Sweep is allowed to match | [Configure Sweep](users/configuration.md)                           |
| Understand deletion and recovery      | [Safety and trash](users/safety.md)                                 |
| Use Sweep in scripts                  | [Commands](users/commands.md) and [automation](users/automation.md) |
| Understand platform and memory limits | [Platforms and large trees](users/platforms.md)                     |
| Resolve an error                      | [Troubleshooting](users/troubleshooting.md)                         |
| Assess performance claims             | [Benchmarks](developer/benchmarks.md)                               |
| Help improve the project              | [Contribute](developer/contributing.md)                             |
| See what comes next                   | [Roadmap](developer/roadmap.md)                                     |

## Documentation status

These pages describe the current source checkout, reviewed on October 3, 2026.
Some improvements are awaiting a release. An installed older package may differ;
check `sweep --version` and `sweep --help` before following a new option or shortcut.
Platform release jobs are configured, but local Linux results alone do not certify
every downloadable package or terminal.
