---
title: Contributing
description: Build and verify a local change without publishing it.
---

Use Bun 1.4.2, Node.js 20.3+ and a Rust toolchain with rustfmt and Clippy.
Turbo's Cargo workspace discovery needs Cargo even for JavaScript tasks.

```sh
git clone https://github.com/KitsuneKode/sweep.git
cd sweep
bun install --frozen-lockfile
bun run fixtures:sync
bun run fixtures:validate-goldens
bun run check
bun run rust:check
bun run build
```

`check` runs format checks, lint, TypeScript, workspace tests and documentation
links. Run `rust:check` for native changes; it runs fmt, Clippy and tests.
`bun run verify` combines the developer verification steps and reports skips.
A skipped engine check is not proof that a native package works.

## Make a reviewable change

Reproduce the bug on a disposable tree. Add a regression for behavior that
matters, implement the smallest coherent change, and run the applicable gates.
Use a Changeset for user-facing package changes. Keep benchmarks separate from
correctness tests and preserve raw workload conditions with any performance claim.

Never point an apply test at a real user's project. Fixtures must be owned,
bounded and cleaned up even on interruption. Do not bypass path guards to make a
test faster. Review existing worktrees and dirty changes before integrating work.

## Tooling performance

Turbo 2.11.7 keeps dependency graphs across Bun and Cargo. Four-task concurrency
limits simultaneous heavy work; its local cache evicts by age and a 1 GB target.
Eviction is not a hard quota and does not bound Cargo's target directory.

Lint/typecheck/read-only JS format checks and bundles use cache. Filesystem tests,
mutating formatting and native compile/lint checks run fresh, while Cargo retains
its own incremental compilation. Check the installed Turbo docs before changing
future flags. A future docs app must build independently of CLI release artifacts.

## Release boundary

Local checks, hosted platform checks, installed-package tests and registry
publication are distinct steps. Preview releases should qualify actual packages,
interrupt receipts and TTY flows on every configured platform before stable
promotion. Version all native packages with the CLI; do not move published tags.
Current open qualification is described in [Roadmap](roadmap.md).
