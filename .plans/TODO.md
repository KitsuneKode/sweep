# TODO

## Done (earlier program)

- [x] Execute the repo context cleanup plan in
      `.plans/repo-context-cleanup.md`
- [x] Start the next implementation phase from
      `.plans/product-architecture-roadmap.md`
- [x] Deepen the engine boundary so `scan -> plan` and `apply plan` live in
      core, with the CLI staying mostly flags, prompts, and output
- [x] Add policy-driven selection controls like `--include-dangerous`,
      `--select`, and risk-aware default selection on top of the current plan model

## Next

- [ ] Finish the [round-two safety/output audit](audit-round2-2026-10-07/README.md),
      platform mount work, deeper filesystem qualification and scale/UI evidence.
      Checkpoints bfdcd96/f5c2270 passed all nine local steps and the hosted matrix;
      [bounded deep removal](bounded-deep-removal.md) is implemented and qualified.

- [ ] Finish the [supplied audit triage and release boundaries](audit-triage-2026-10-07.md),
      including macOS mounts, resource-charge parity, live UI streaming and installer faults.

- [x] Implement local [production qualification and long-session UX](production-qualification.md):
      native Linux descriptor removal, private bind mounts, installed packages,
      serialized paced decoding, queue/tree gestures, cache release and one final review.
      Real-platform, crash, trash-restore and dependency qualification remain open.

- [x] Implement [saved-plan identity safety](saved-plan-identity.md) locally:
      scan-time snapshots, legacy refusal, stream/TUI preservation and fresh
      benchmark/resource/runtime evidence. Real platform execution and
      ancestor/mount safety remain open release qualifications.

- [x] Implement [codebase audit follow-ups](codebase-audit-2026-10-01/README.md) locally — native interruption/outcomes, large UI selection caching and history bounds. Platform/release qualification remains open.

- [x] Implement [traversal engine](traversal-engine.md) locally — linear globs, a Rust
      sizer that can beat JS+`du` on one fat artifact, one walk queue per
      engine, then a truthful interrupted apply. Measure first. Do not start
      FFI or a `rustix` walk unless the size gate fails.
- [ ] Finish [resource bounds and release qualification](resource-bounds-and-release.md):
      scan/UI limits, stress evidence, release policy, real platform installers,
      consoles and destructive-operation boundary qualification.
- [x] Execute [TUI + core audit fixes](tui-audit/README.md) — modal viewport
      clamp, patterns pane, streaming queue + always-confirm apply, density
      pass, engine/guardrail edge cases. All leftovers in
      `tui-audit/04-edge-cases.md` are landed (Rust `skippedDirs` emission,
      measured `pageRows`, `?` glob docs).
- [x] Execute the second-pass trust/parity/perf audit — `--dry-run` on apply,
      `queueCleared` mid-scan latch, apply gate while scanning, canonicalized
      `assertSafeCwd`, canonical VCS check, normalized nested dedupe +
      delete-time reverify, tuple-keyed selector caches, Windows reparse-point
      detection + `\`→`/` ignore normalization, engine exit-code parity,
      published `exports` → `dist/sweep-lib.js`, Rust legs in the win/mac CI
      matrix.
- [x] Execute [daily-driver overhaul](daily-driver-overhaul/master.md) — **unified
      program**: Phase 0 catalog/hygiene → trust → TUI → streaming → orchestration →
      CLI → Rust → polish ([scope index](daily-driver-overhaul/README.md))
- [x] Add a first `sweep ui` flow on top of the shared scan/plan/apply engine
      using a well-supported TUI library instead of ad hoc terminal painting
- [x] Add a testable UI state layer so selection/filter behavior is validated
      outside the renderer itself
- [x] Deepen the first protocol schema surface for candidates, risks, plans,
      apply reports, and streamed events beyond the initial package scaffold
- [x] Add first JSON Schema artifacts for `ScanPlan` and `ApplyReport`
- [x] Introduce shared seeded fixture scenarios for larger end-to-end tests and
      future JS-vs-Rust parity checks
- [x] Introduce a first mixed-risk seeded fixture scenario for JS-engine
      contract tests
- [x] Add a larger workspace-matrix seeded fixture for mixed monorepo parity
      checks
- [x] Expand the fixture seed script with symlink, blocked-path, and large-plan
      scenarios so future engine ports can be compared against the JS reference
- [x] Add JSON Schema artifacts for streaming scan events and shared nested
      protocol defs once the current plan/apply shapes settle a bit more
- [x] Reconcile the future config direction with the current `.sweeprc`
      implementation without documenting unimplemented behavior as current truth

## Later

- [x] Add a `packages/test-fixtures` workspace once the seeded scenarios and
      helpers start being reused across more suites
- [x] Add a lightweight doc hygiene check if drift becomes a recurring problem
      (`scripts/check-doc-links.ts`)
- [ ] Capture release/process notes once the package surface stabilizes
- [x] Split product, protocol, engine, and UI plans into more focused files once
      active execution begins (see `.plans/overhaul-roadmap.md`)
