---
title: Platforms and large trees
description: Choose an engine and understand runtime, memory and filesystem limits.
---

## Distribution targets

| Target              | Minimum ABI / libc          | Standalone asset (`sweep-*`) | Native npm engine package (`@kitsunekode/*`) |
| ------------------- | --------------------------- | ---------------------------- | -------------------------------------------- |
| Linux glibc x64     | glibc 2.17+                 | `sweep-linux-x64`            | `sweep-engine-linux-64`                      |
| Linux glibc ARM64   | glibc 2.17+                 | `sweep-linux-arm64`          | `sweep-engine-linux-arm64`                   |
| Linux musl x64      | musl (Alpine, Void, static) | `sweep-linux-x64-musl`       | `sweep-engine-linux-64-musl`                 |
| Linux musl ARM64    | musl (Alpine, Void, static) | `sweep-linux-arm64-musl`     | `sweep-engine-linux-arm64-musl`              |
| macOS Intel         | macOS x64                   | `sweep-darwin-x64`           | `sweep-engine-darwin-64`                     |
| macOS Apple Silicon | macOS arm64                 | `sweep-darwin-arm64`         | `sweep-engine-darwin-arm64`                  |
| Windows x64         | Windows 10/11 x64           | `sweep-win-x64.exe`          | `sweep-engine-windows-64`                    |

### Linux ABI floor and musl support

Linux glibc engine binaries are built against **glibc 2.17** via `cargo-zigbuild`
(`x86_64-unknown-linux-gnu.2.17` and `aarch64-unknown-linux-gnu.2.17`). Both the
Bun standalone executable and OpenTUI's Linux glibc library also target glibc
2.17, so the glibc standalone and npm engine packages run on Ubuntu 20.04+,
Debian 11+, RHEL 8/9, Rocky/AlmaLinux, and Amazon Linux 2/2023. Release CI
enforces this floor by inspecting ELF `DT_VERNEED` symbol versions (failing if
any required symbol exceeds `GLIBC_2.17`) and smoke-running the artifacts inside
`debian:11-slim`.

Linux musl engine binaries are statically linked (`x86_64-unknown-linux-musl`
and `aarch64-unknown-linux-musl`) with zero glibc or shared-library
dependencies, so they run on bare Alpine containers. Musl standalone binaries
target Bun's musl runtime with OpenTUI's musl native library and dynamically
link `libstdc++` and `libgcc` (on minimal Alpine images, run
`apk add libstdc++ libgcc`). Release CI checks ELF metadata for zero glibc
dependencies and smoke-runs the artifacts inside `alpine:3.21`.

Windows ARM64 is not currently a shipped target. Refer to the specific release
assets rather than assuming an unsupported binary will work. Interactive
physical-terminal qualification on macOS and Windows remains separate from
headless CI checks.

Choose the npm CLI plus its optional precompiled engine when you already have
Node/Bun. Choose `sweep-TARGET` (or Homebrew / Scoop / `install.sh` /
`install.ps1`) for the self-contained application. The smaller
`sweep-engine-TARGET` download is only the machine-protocol backend; it does not
include interactive commands or the TUI. Both binary families ship raw
executables, verified `.gz` archives, and `.sha256` sidecars.

### Verifying build provenance attestations

Every released standalone binary, `.gz` archive, and native engine binary is
attested with GitHub Artifact Attestations (`actions/attest-build-provenance`).
To verify that a downloaded file was built by this repository's release workflow
before running it:

```sh
gh attestation verify sweep-linux-x64.gz -R KitsuneKode/sweep
gh attestation verify sweep-win-x64.exe -R KitsuneKode/sweep
```

Published npm packages carry npm provenance automatically via OIDC trusted
publishing (`npm audit signatures`).

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

There is no default deletion byte ceiling. An existing numeric `maxSizeGB`
still limits removal independently of resource admission. For an intentionally
reviewed 200–600 GiB selection, use `--max-size-gb 600` for a run-specific cap,
or explicitly choose `--max-size-gb none` to disable a configured cap.
The TUI still asks for confirmation. A known size refusal preserves its scan and
queue. A 600 GiB capacity claim requires measurements of representative file
counts, layouts, storage and deletion behavior; sparse-file tests alone do not
qualify that workload.
