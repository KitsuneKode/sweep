---
title: Roadmap
description: Prioritize trust, measurable responsiveness and a useful public release.
---

## Completed locally in the current source

Bounded discovery and sizing, safe integer arithmetic, bounded native streams,
cooperative apply cancellation and per-candidate receipts are implemented.
The UI streams discoveries and sizes, keeps incomplete scans blocked, and supports
confirmed deletion of the focused or inspected artifact. Linux million-entry,
sparse 200 GiB and read-only existing-tree comparisons have been recorded.
Scan-time root and candidate identities now survive saved plans, sizing and UI
rescans. Replaced entries are refused, and older plans require a fresh scan
before applying. Older native engines lacking identity checks cannot silently
handle the destructive request.

Native Linux cleanup now anchors removal to descriptors with mount-crossing
refusal and bounded directory handles. Linux bind-mount fixtures and actual
local CLI/native npm tarball installation passed for both engines. The UI keeps
folder focus during streamed sizing, supports whole/visible queue clearing and
releases strong caches on rescan/teardown. Native decoding yields in bounded
slices; synchronous startup failures remain recoverable scan errors.

These are local source results awaiting the applicable release gates. The runtime
matrix includes installed package qualification on Linux ARM64, both macOS
architectures and Windows, but configuration is not a successful hosted run.

## Next outcomes

| Priority | Goal                                     | Acceptance                                                                                                                                                  |
| -------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Qualify preview packages on every target | Installed npm/standalone scans, interrupts and real TTY selection pass on Linux/macOS/Windows and configured ARM64                                          |
| 1        | Strengthen destructive containment       | Document and test nested mounts, concurrent path swaps, permission failures and interrupted large deletion; prototype handle-relative deletion where needed |
| 1        | Finish release security evidence         | Review dependency advisories without assuming local unit tests establish dependency safety; qualify publisher configuration                                 |
| 2        | Improve streaming tail latency           | Profile parsing, validation, update batching and terminal painting; compare first-result latency and p95/p99 with slow consumers                            |
| 2        | Qualify memory across long sessions      | Repeated rescans, low-memory/FD limits, million-entry shapes and aborts stay within measured budgets without persistent growth                              |
| 2        | Ship this docs site                      | TanStack Start/Fumadocs build, search, mobile/keyboard checks and version labels pass independently of CLI packaging                                        |
| 3        | Make sharing useful and private          | Export an opt-in redacted summary with no absolute paths or automatic uploads                                                                               |
| 3        | Keep distribution compact                | Record compressed/unpacked package sizes; prevent docs assets and duplicate runtime dependencies entering CLI artifacts                                     |

Performance work should start from a measured bottleneck. More threads, async
mutexes or additional processes are not goals in themselves. Extra concurrency
must improve the target workload without making cancellation or memory worse.

## Bring useful value to people

Publish a preview when the target-platform safety checks pass. Show a short demo:
scan an old project, inspect one artifact, confirm trash or deletion, and show the
actual outcome. Include a reproducible workload with benchmark limits nearby.

Ask early users whether they understood the selection and could recover from an
error. Track completed safe cleanups, installation success and reproducible bug
reports before treating stars or screenshots as success. A fast first useful
scan and a trustworthy confirmation are the product's strongest introduction.
