---
"@kitsunekode/sweep": minor
---

Cross-platform distribution and installer hardening:

- Lower Linux glibc native engine ABI floor to glibc 2.17 (via `cargo-zigbuild`) with an automated ELF `DT_VERNEED` CI gate and `debian:11-slim` container smoke tests, fixing startup failures on Ubuntu 22.04, Debian 12, and RHEL 9.
- Add static Linux musl native engine packages (`@kitsunekode/sweep-engine-linux-64-musl`, `@kitsunekode/sweep-engine-linux-arm64-musl`) and musl standalone release binaries (`sweep-linux-x64-musl`, `sweep-linux-arm64-musl`) with automatic Linux libc detection.
- Harden `install.sh` to stage inside `INSTALL_DIR`, prefer verified `.gz` downloads, accept `SWEEP_VERSION` with or without a leading `v`, retry transient curl failures, detect musl, verify `--version` before replacing any existing binary, and point Windows shells to `install.ps1`.
- Add `install.ps1` and a Scoop manifest (`packaging/scoop/sweep.json`) for Windows x64, move the Homebrew formula template into this repo with `.gz` downloads and shell completions, add GitHub build provenance attestations (`gh attestation verify`) for all release binaries and archives, and make the npm-to-binary release handoff idempotently reconcilable.
