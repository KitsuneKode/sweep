---
title: Troubleshooting
description: Start from the error you see and recover without guessing what was deleted.
---

| Symptom                                     | What to do                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `sweep: command not found`                  | Check the package manager's global bin directory and PATH; open a new shell after installation                          |
| Rust engine unavailable                     | Run `sweep doctor .`; verify optional native dependencies and matching OS/architecture, or explicitly try `--engine js` |
| Bun JS reader says Node is missing          | Install Node on PATH or use the Rust engine; do not replace the bounded reader with whole-directory arrays              |
| UI needs Bun or OpenTUI                     | Use the runtime/peer described in [Getting started](getting-started.md), or a qualified standalone release              |
| UI requires an interactive TTY              | Run it directly in a terminal; use `scan --json` for redirected output                                                  |
| `Scan resource limit exceeded`              | Treat the scan as incomplete; narrow the target and rescan                                                              |
| Size shows `~`                              | Sizing was partial or approximate; investigate before cleanup, especially near the size ceiling                         |
| Item is blocked                             | Inspect the path and refusal; configuration cannot bypass protected-root/VCS checks                                     |
| Expected `dist` is missing                  | It is opt-in; review [Configuration](configuration.md) before enabling it                                               |
| Expected matches are absent                 | Check inherited `.sweeprc`, disabled patterns, ignores and depth using `doctor`                                         |
| Apply refuses changed size/type/path        | The tree changed since planning; inspect it and create a fresh plan                                                     |
| Permission error                            | Review permissions and the specific path; avoid escalating an unreviewed cleanup to administrator                       |
| Interrupted apply                           | Read the final outcomes, then re-scan; cancellation is not rollback                                                     |
| Engine timeout or missing final report      | Outcome can be unknown; inspect the filesystem before retrying                                                          |
| Claimed bytes differ from free-space change | Check trash, hardlinks, snapshots, sparse/compressed files and estimates                                                |

## Read-only diagnostics

```sh
sweep --version
sweep doctor . --json
sweep scan . --engine rust --json
```

Use the last command only where Rust is installed. If you compare JS, repeat with
`--engine js` on the same unchanged tree. Keep generated plans private until you
have redacted absolute paths. A diagnostic scan can still take time on a large
or slow filesystem; choose a small reproducer first.

Report bugs at [GitHub issues](https://github.com/KitsuneKode/sweep/issues).
Include expected behavior, actual behavior and whether any apply was attempted.

## A row remains after cleanup

Read the outcome first. `x` / `d` confirms removal of the focused or inspected
artifact; Enter opens confirmation for the queue. A single-item result can leave
other queued items untouched. The cursor then moves to a surviving artifact,
which may have the same name in another project. Compare full paths with `i`.

A symbolic-link artifact represents the link entry, not the directory it points
to. Removing it leaves the linked contents intact. Package installs, builds and
fixture generators can also recreate entries; pause them before cleanup and
rescan to check what exists now. Sweep's own `fixtures:sync` command recreates
the `tests/fixtures/risk-mix/target` test link.

If the same full path remains in the current session after an authoritative
deleted outcome, keep the report and report the discrepancy. Do not repeatedly
confirm deletion to work around it. Include the command, engine, entry type,
full-path comparison and any process writing to that tree; redact private paths
before sharing them.

## Legal POSIX backslash names under Bun

Some Bun 1.4.2 `realpath` calls fail on a literal backslash in a POSIX name,
even when the file is present. Sweep fails closed instead of substituting a
path. Use the Node CLI with `--engine js` for trash moves in those trees, or the
native engine for supported scan/permanent-delete workflows. The full-screen UI
requires Bun; it does not bypass failed canonicalization.
