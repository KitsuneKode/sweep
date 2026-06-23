# Daily-driver polish and distribution

Status: planned
Scope: product
Created: 2026-06-24
Updated: 2026-06-24
Commit: uncommitted
Parent: [master.md](./master.md)

## Why

Original overhaul **Phase 6** — product completeness after core UX and engine work land.

Depends on: Phases B–E (and ideally F rust parity) in [master.md](./master.md).

## Steps

1. `sweep init` — scaffold `.sweeprc` with sensible defaults.
2. `sweep clean` alias for default TTY/non-TTY cleanup action.
3. Richer `--help` with examples; README refresh for TUI and flags.
4. Stronger `doctor`: validate `.sweeprc`, dry-scan summary, `--json` output.
5. Theme/onboarding in TUI (auto theme already in `theme.ts` — verify light/dark/auto).
6. E2E verification: Windows / macOS / Linux; optional-peer `@opentui/core` install story.

**Verify:**

```bash
bun run check
bun run preflight
# manual matrix on target OSes
```

## Done

- [ ] `sweep init` and `sweep clean` documented and tested
- [ ] README matches shipped behavior
- [ ] Optional UI peer install path verified
