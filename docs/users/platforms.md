---
title: Platforms and large trees
description: Choose an engine and understand runtime, memory and filesystem limits.
---

## Distribution targets

| Target              | Installed packages / standalone source qualification |
| ------------------- | ---------------------------------------------------- |
| Linux glibc x64     | Passed on hosted runner                              |
| Linux glibc ARM64   | Passed on hosted runner                              |
| macOS Intel         | Passed on hosted runner                              |
| macOS Apple Silicon | Passed on hosted runner                              |
| Windows x64         | Passed on hosted runner                              |

The October 4 source checkpoint passed the
[CI matrix](https://github.com/KitsuneKode/sweep/actions/runs/37218603503) and
[binary workflow](https://github.com/KitsuneKode/sweep/actions/runs/37218647608).
This verifies local tarball installation and headless standalone checks on
those runners; it is not a published release or a physical-terminal guarantee.
Interactive terminals still need qualification. Current performance
measurements were collected on Linux x64. Alpine/musl and Windows
ARM64 are not currently shipped targets. Refer to the specific release assets
rather than assuming an unsupported binary will work.

Choose the npm CLI plus its optional precompiled engine when you already have
Node/Bun. Choose `sweep-TARGET` for the self-contained application. The smaller
`sweep-engine-TARGET` download is only the machine-protocol backend; it does not
include interactive commands or the TUI. Both binary families get checksums and
gzip assets through the release workflow.

## Runtime and engine selection

Node.js 20.3+ supports the plain npm CLI. The full-screen UI needs Bun and
OpenTUI, or a standalone build that embeds them. Both UI streams must be TTYs.

`--engine auto` prefers a usable Rust engine and otherwise uses JavaScript.
`--engine rust` explicitly requests native execution; failures are surfaced.
An engine failure after scanning starts must not silently turn into a successful
partial cleanup.

Under Bun, the JS engine uses one Node child for genuinely incremental directory
enumeration. It therefore needs Node on PATH. Under Node it enumerates directly.
The embedded-native standalone's normal scan does not need external Node or Bun.

## Large trees

File count, directory shape and metadata latency usually matter more than the
sum of file lengths. A 200 GiB sparse file is cheap to size; a million small files
can require a million metadata operations. Network drives and cold storage need
separate measurements.

Defaults bound discovery to 100,000 candidates, 250,000 admitted directories,
32,768 queued paths, 500,000 inode identities, 64 MiB admitted path bytes and
128 MiB estimated retained charges. Sizing has a separate shared pool with live
reservations, released as work completes. Reaching a sizing limit marks sizes
partial; reaching a discovery limit makes the scan incomplete.

Discovery and sizing can each admit 128 MiB of logical charges, with a combined
256 MiB allowance. `--resource-profile low-memory` reduces those pools to 8 MiB
each (16 MiB combined), with 5,000 candidates and smaller queue/identity bounds.
These are accounting limits, not an RSS cap. Runtime heaps, terminal
state, native libraries, buffers and thread stacks add memory. Sweep cannot
promise immunity from OOM on an already constrained device.

Worker admission follows the runtime's available CPU allowance. Rust shares at
most 16 workers between discovery and sizing, with one worker per pool on one-
or two-CPU allowances. JS also reduces directory and metadata concurrency on
small allowances. Other runtime threads and filesystem caches still use resources;
these limits do not reserve RAM or guarantee a maximum percentage of CPU use.

If a resource error appears, scan a smaller project subtree. Choose `--resource-profile low-memory` for a smaller admission envelope.
There are no public flags for arbitrary per-counter limits or `.sweeprc` fields. On a very large scope
tree, the sidebar may fall back to `all scopes (folder index limit)` while the
full candidate list remains available.

Project paths use UTF-8. A filename containing unrepresentable raw bytes is
skipped with partial-scan feedback, rather than converted into another file's
name. Ordinary Unicode names, including `�`, are supported. Sizing inside an
already selected artifact still handles raw filenames.

For distribution sizes and measurement conditions, read [Benchmarks](../developer/benchmarks.md).

The deletion size ceiling defaults to 10 GiB and is independent of resource
admission. For an intentionally reviewed 200–600 GiB selection, set `maxSizeGB`
in `.sweeprc` to the reviewed ceiling or launch with `--force-large --yes`.
The TUI still asks for confirmation. A known size refusal preserves its scan and
queue. A 600 GiB capacity claim requires measurements of representative file
counts, layouts, storage and deletion behavior; sparse-file tests alone do not
qualify that workload.
