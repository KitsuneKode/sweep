---
"@kitsunekode/sweep": patch
---

Cross-platform distribution and installer hardening:

- Lower the Linux glibc native engine npm package ABI floor from glibc 2.39 (which prevented the native npm engine from starting on Ubuntu 22.04, Debian 12, and RHEL 9) to glibc 2.17 via `cargo-zigbuild`, and enforce that glibc 2.17 floor across native engines, standalones (which already ran on older glibc systems), and embedded OpenTUI shared objects with an automated ELF ABI CI gate (rejecting `GLIBC_ABI_DT_RELR` and symbols above `2.17`) and `debian:11-slim` container smoke tests.
- Add static Linux musl native engine packages (`@kitsunekode/sweep-engine-linux-64-musl`, `@kitsunekode/sweep-engine-linux-arm64-musl`) and dynamic musl standalone release binaries (`sweep-linux-x64-musl`, `sweep-linux-arm64-musl`) with interpreter-first Linux libc detection and explicit `unknown` JS fallback diagnostics.
- Harden `install.sh` to stage inside `INSTALL_DIR`, refuse directory destinations, cap download and decompression sizes, prefer verified `.gz` downloads, distinguish HTTP 404 from write/network curl failures, accept `SWEEP_VERSION` with or without a leading `v`, detect musl across `/lib` and `/usr/lib`, verify `--version` (with an Alpine `libstdc++`/`libgcc` hint) before replacing any existing binary, and point Windows shells to `install.ps1`.
- Add `install.ps1` (hardened for Windows PowerShell 5.1 and PowerShell 7) and a Scoop manifest (`packaging/scoop/sweep.json`) for Windows x64, move the Homebrew formula template into this repo with `chmod 0755`, `.gz` downloads, and shell completions, add GitHub build provenance attestations (`gh attestation verify`) for all release binaries and archives, and harden the release pipeline with canonical source gates, a protected `release-downstream` environment, and idempotent release reconciliation.
