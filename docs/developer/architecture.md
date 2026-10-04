---
title: Architecture
description: Share one cleanup contract across engines and UI consumers.
---

Sweep separates discovery, planning, selection and apply. The UI selects
candidate IDs; the backend owns filesystem validation and removal.

```text
CLI options + resolved config
        |
   scan / streaming events
        |
   candidates + saved plan
        |
 human or scripted selection
        |
   revalidation + guarded apply
        |
 outcome report + local history
```

JavaScript handles the CLI and UI; a Rust executable implements the same engine
contract. Shared protocol types and JSON Schema live in `packages/protocol`.
Core behavior lives in `packages/core`; OpenTUI lives in `packages/ui`.

## Concurrency and memory

Use bounded workers, queues and transport batches. Rust uses a fixed sizing
pool and bounded directory subdivision, rather than a thread for every artifact.
Discovery accounting is cumulative; shared sizing reservations track live work
and return capacity after jobs finish. Locks guard brief accounting/set updates,
not entire filesystem operations.

Thread count alone does not bound retained candidates, paths or inode sets.
Partial sizing must stay visible; resource failures must not be converted into
complete plans. A new concurrency feature needs cancellation, backpressure and
peak-memory evidence before it becomes a default.

## Streaming to the UI

Discovery emits candidates before every size is known. Sized updates refer to
stable candidate IDs. Native transport and UI updates batch bounded work; the
first useful result should appear promptly, and list order stays stable during
scan. The visible list is windowed; cached scope/row indexes avoid rebuilding
all candidates for cursor movement.

Consumers must drain stderr, bound protocol frames, respect cancellation and
check the final outcome. An NDJSON prefix alone is not a successful scan. Next
work should profile parse/validation and rendering separately, especially with
many candidates and slow terminals.

## Apply

Apply checks the canonical target, VCS protection, candidate containment, entry
type and current size. Cancellation stops future scheduling and returns explicit
outcomes. Pathname-based operations still have race and nested-mount limitations;
handle-relative containment is a separate safety project, not a performance
shortcut justified by more threads.

Cancellation is checked again after begin feedback, before a delete or trash
move. Native size preflight also checks cancellation within large subtrees.
Filesystem identities detect same-type replacement during apply checks; they
are also captured before traversal and at discovery, then preserved through
streaming, sizing, saved-plan loading and TUI selection. JSON uses exact decimal
strings. Legacy plans remain readable but cannot apply without scan snapshots;
the host refuses native engines lacking the `planIdentity` capability. They
do not freeze a tree against concurrent changes. Native covered outcomes retain
their pre-delete alias keys; JS now does the same, so removed parents cannot
corrupt covered receipts.

Windows uses stable owned metadata handles for volume/file IDs and link counts.
Cross-compilation checks API compatibility; actual filesystem and console runs
are separate evidence.
