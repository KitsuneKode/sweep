# TODO

## In Progress

- [x] Execute the repo context cleanup plan in
      `.plans/repo-context-cleanup.md`
- [x] Start the next implementation phase from
      `.plans/product-architecture-roadmap.md`
- [x] Deepen the engine boundary so `scan -> plan` and `apply plan` live in
      core, with the CLI staying mostly flags, prompts, and output
- [x] Add policy-driven selection controls like `--include-dangerous`,
      `--select`, and risk-aware default selection on top of the current plan model

## Next

- [ ] Deepen the first protocol schema surface for candidates, risks, plans,
      apply reports, and streamed events beyond the initial package scaffold
- [ ] Introduce shared seeded fixture scenarios for larger end-to-end tests and
      future JS-vs-Rust parity checks
- [ ] Expand the fixture seed script with symlink, blocked-path, and large-plan
      scenarios so future engine ports can be compared against the JS reference
- [ ] Reconcile the future config direction with the current `.sweeprc`
      implementation without documenting unimplemented behavior as current truth

## Later

- [ ] Add a `packages/test-fixtures` workspace once the seeded scenarios start
      being reused across more suites
- [ ] Add a lightweight doc hygiene check if drift becomes a recurring problem
- [ ] Capture release/process notes once the package surface stabilizes
- [ ] Split product, protocol, engine, and UI plans into more focused files once
      active execution begins
