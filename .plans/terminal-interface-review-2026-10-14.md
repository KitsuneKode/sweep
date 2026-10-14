# Terminal review evidence

Scope: first scan → select artifacts → browse folders → inspect/review → apply or
cancel → receipt. Includes narrow terminals, long/Unicode paths, empty queue,
refusal, resize, keyboard/mouse parity and the private folder-page API. This is
not a claim of whole-repository or physical assistive-technology qualification.

## Changes and checks

| Area                | Evidence                                                                                | Result                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Selection authority | app.apply-break tests; cloned reviewed plan; single vs queue; outside-view warning      | Only the reviewed IDs/paths/identity reach apply; scope stays unchanged after report             |
| Commands            | app render tests with Ctrl+K/F2, filtered actions, mouse paging and keyboard activation | Action search traps background shortcuts; query must commit before activation                    |
| Folder hierarchy    | ScopeSidebar tests with 10,000 folders, separate name/arrow/checkbox gestures           | Viewport-only nodes; cursor movement/drag does not browse or queue                               |
| Pointer geometry    | ActionButton, ArtifactList and layout tests; sidebar drag to last row                   | Left release activates buttons; drags/right click do not toggle; scrollbar hit cells match paint |
| Narrow/resize       | layout and apply-break tests; Modal native percentage bounds                            | No stale fixed viewport sizing; unreadable confirmation refuses until resized                    |
| Copy and hierarchy  | Context row names viewed folder and sort; paths precede optional policy detail          | Repeated sidebar risk summary, clear button and filter-example noise removed                     |
| Preferences         | exact four-key validation, bounded private file, atomic save tests                      | Theme/sort/motion only; no saved paths, queue or deletion authorization                          |
| Optional cap        | Linux PTY, Rust and JS; refusal followed by explicit per-review override                | No mutation on refusal; one item removed; other queued item preserved                            |
| Native pages        | Rust/host reference tests; forged metadata closes generation                            | Resource bounds unchanged; private API remains gated from production reducers                    |

Use the existing better-interface, layout, writing, color and OpenTUI conventions.
Terminal text/cell geometry, symbols, visible cursor state and keyboard parity are
the relevant checks here. DOM/ARIA, touch/device and browser WCAG claims are not
substitutes for terminal evidence. Existing colors and motion tokens were reused.
Row navigation, disclosure, consent and resize stay immediate. Activity uses the
existing paused-motion path and static counters; no decorative transition added.

React Doctor was run on the changed source. It reports native OpenTUI properties
on JSX `text`/`input` as unknown DOM properties; replacing them with HTML props
would break the terminal renderer. Its parent-effect warnings refer to the
appearance-only callback retained by the non-React session owner. Two stale
callback dependency findings were corrected. The action search has a visible
modal title; DOM label heuristics do not validate native input accessibility.
The diagnostic score is not a release or accessibility certification.

## Measurements and boundaries

Receipts: `.scratch/qualification/guided-review-2026-10-13/native-index.json` and
`.scratch/qualification/guided-review-2026-10-14/`. These are ignored local
evidence artifacts, not package contents.

One 5,000-artifact/5,000-folder synthetic UI stream before the final simplification
completed in 746 ms, after in 676 ms. Median input-to-paint was 26.3 and 25.3 ms;
RSS samples were 245 and 251 MiB. These are individual observations with fewer
than 100 input samples, not a proven speedup or tail-latency qualification. They
include native in-memory rendering and commit receipts, no filesystem traversal
or physical terminal delivery. The earlier real corpus is absent from its
recorded path; the screenshot's 60 GiB / six seconds has not been reproduced.
A byte total alone does not describe entry count, cache state, storage latency,
concurrent writers or host backpressure. The UI's scan timer includes delivery
and reconciliation; it is not isolated Rust traversal CPU time.

Private folder paging at 100k compact records retained about 41.7 MiB of charged
host witnesses and returned at most 54,326 bytes per folder reply. Twenty folder
queries had median 18.4 ms, p95 21.0 ms. Normal-path 100k input refused at existing
plan limits before spawning. This does not qualify total production UI memory,
real 600 GiB trees, deletion throughput or non-Linux pathname race protection.

Docs build/SSR/link checks passed earlier in this pass. IAB backend discovery
failed, so browser visual/responsive/device checks remain unverified. The code
changes do not claim a release; publish/tag remains outside this checkpoint.
