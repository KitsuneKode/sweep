---
title: Platforms and large trees
description: Check supported operating systems, release binaries, and resource behavior on large trees.
---

## Supported targets

| Target            | Install support                                                                      |
| ----------------- | ------------------------------------------------------------------------------------ |
| Linux x64 glibc   | glibc 2.17 or newer. npm native engine, standalone binary, and installer.            |
| Linux arm64 glibc | glibc 2.17 or newer. npm native engine, standalone binary, and installer.            |
| Linux x64 musl    | From 0.5.4. Static native engine through npm and standalone binary through Releases. |
| Linux arm64 musl  | From 0.5.4. Static native engine through npm and standalone binary through Releases. |
| macOS x64         | npm native engine, standalone binary, installer, and Homebrew.                       |
| macOS arm64       | npm native engine, standalone binary, installer, and Homebrew.                       |
| Windows x64       | npm native engine and standalone `.exe`.                                             |
| Windows arm64     | Not shipped.                                                                         |

Sweep runs as the current user. It does not install a service, kernel extension, or elevated helper.

## Direct release downloads

Every release publishes standalone binaries and native engine binaries. Assets are available uncompressed and as `.gz` archives, each with a `.sha256` sidecar. The standalone binary contains the CLI, terminal UI, and native engine payload.

Examples use `vX.Y.Z` as the release tag. Substitute the exact tag and file you downloaded:

```sh
curl -fLO https://github.com/KitsuneKode/sweep/releases/download/vX.Y.Z/sweep-linux-x64.gz
curl -fLO https://github.com/KitsuneKode/sweep/releases/download/vX.Y.Z/sweep-linux-x64.gz.sha256
sha256sum sweep-linux-x64.gz
cat sweep-linux-x64.gz.sha256
gunzip sweep-linux-x64.gz
chmod +x sweep-linux-x64
./sweep-linux-x64 --version
```

Windows assets are `.exe` files, normally distributed as `.gz` archives. Verify the checksum before extraction. Verify release provenance when `gh` is available:

```sh
gh attestation verify sweep-linux-x64.gz -R KitsuneKode/sweep --signer-workflow KitsuneKode/sweep/.github/workflows/cli-binaries.yml --source-ref refs/tags/vX.Y.Z
```

`install.sh` and `install.ps1` perform checksum verification and a staged `--version` self-test before replacing an existing install. They do not use `sudo` by default. `install.sh` chooses the musl asset when the system C library is musl and refuses clearly rather than installing a glibc binary there.

## Linux C library variants

The native glibc npm packages are linked broadly for older enterprise Linux systems. glibc 2.17 is the floor. A very old glibc can fail when the native engine starts. In that case `--engine auto` uses the JavaScript engine. Use `--engine rust` only when you want a missing or unusable native engine to be a hard failure.

musl native engines are statically linked. The standalone binary itself is dynamically linked because it contains the JavaScript runtime. On Alpine or another minimal musl image, install the runtime C++ libraries if startup reports a missing shared object:

```sh
apk add libstdc++ libgcc
```

Sweep detects musl from the running executable's ELF interpreter, mapped runtime libraries, or glibc runtime evidence. It does not treat Alpine package files or `ldd` output as proof of musl. If detection is uncertain, `--engine auto` conservatively uses JavaScript. `sweep doctor --json` reports `libc_unknown` when that happens.

## macOS and Windows notes

On macOS, direct downloads can be quarantined until you approve them in system settings. Homebrew and the signed installer flow avoid most manual approval.

On Windows, the standalone executable can trigger SmartScreen because it is a new unsigned binary. Verify the `.sha256` sidecar and provenance before running it. PowerShell execution policy can also block `install.ps1`; download it, inspect it, then run it with an explicit `ExecutionPolicy Bypass` for that process if appropriate.

Windows ships a native engine. The scanner still applies the same plan, guardrail, and confirmation model, with platform-specific performance and descriptor enforcement differences.

## Terminal UI runtime

The npm package uses `@opentui/core` as an optional dependency for the full-screen UI. Bun and Yarn 4 install it in normal installs. On Node older than 26.4, npm, pnpm, and Yarn 1 can leave it unlinked or unmet while still installing the CLI.

Use a standalone binary or Bun if `sweep ui` reports that OpenTUI is unavailable. Plain commands such as `scan`, `clean`, `status`, `plan`, and `apply` still run on Node.js 22.12+.

The UI needs a real terminal. In a minimal terminal, sweep can still scan and apply through the plain CLI.

## Engines

`--engine auto` prefers a trusted native Rust engine and falls back to JavaScript with an explicit note. `rust` requires the native engine. `js` forces the JavaScript engine.

The native engine is trusted only when ownership and writability checks pass on POSIX systems. Group- or world-writable install locations are not trusted. Homebrew prefixes often use group-writable directories, so the first Homebrew run can use JavaScript even though the native binary is installed. Read [Safety and trash](safety.md) for the full identity and content checks.

Both engines use the same protocol and guardrail model. Small scans can feel similar. Native scanning matters most on large trees and low-memory environments.

## Large trees

Sweep is designed for large project forests, but it is explicit about incomplete evidence. It does not silently turn a partial scan into a successful apply.

`--resource-profile balanced` is the default. `--resource-profile low-memory` reduces scan depth, file, byte, and time allowances and uses conservative scheduling. Resource limits are independent from `maxSizeGB`; neither one replaces the other.

If a scan reports a resource limit:

- scan a smaller folder such as one project or group
- exclude irrelevant vendor or synchronization folders with `--ignore`
- use the default profile rather than `low-memory` when the machine has headroom
- let a scan finish before relying on project idle status or applying

Depth-only pruning is reported as skipped coverage. A resource-limit failure exits `2` and cannot be applied. `sweep status` reports skipped directories and partial byte accounting so you can distinguish exact evidence from a partial view.

For very large trees, use `sweep scan --json-stream` and consume events incrementally. Keep the consumer draining. Sweep fails explicitly when structured output stalls rather than pretending the scan succeeded.
