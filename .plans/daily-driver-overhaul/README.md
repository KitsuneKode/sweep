# daily-driver overhaul

**Start here:** [master.md](./master.md) — unified improvement program (architecture,
usage, execution order, agent routing).

Consolidates: original sweep overhaul roadmap (P0–P6), TUI/ghui audit, architecture
review, and catalog/`@types/bun` hygiene.

## Instruction plans (child files)

| Plan                                                     | Phase | Status      | Scope         |
| -------------------------------------------------------- | ----- | ----------- | ------------- |
| [master.md](./master.md)                                 | —     | in_progress | cross-cutting |
| [architecture-deepening.md](./architecture-deepening.md) | ref   | planned     | design        |
| [repo-catalog-hygiene.md](./repo-catalog-hygiene.md)     | 0     | done        | repo          |
| [trust-guardrails.md](./trust-guardrails.md)             | A     | done        | engine        |
| [ui-review-pane.md](./ui-review-pane.md)                 | B     | done        | ui            |
| [orchestration-seam.md](./orchestration-seam.md)         | C     | done        | cli           |
| [streaming-engine.md](./streaming-engine.md)             | D     | done        | engine        |
| [cli-output.md](./cli-output.md)                         | E     | done        | cli           |
| [rust-engine-parity.md](./rust-engine-parity.md)         | G     | done        | engine        |
| [daily-driver-polish.md](./daily-driver-polish.md)       | H     | done        | product       |

## Dependency graph

```
Phase0_repo_catalog
    ├── PhaseA_trust ──┬── PhaseG_rust
    │                  └── PhaseC_orchestration ◄── PhaseB_ui + PhaseD_streaming
    └── PhaseB_ui
PhaseD_streaming ──► PhaseE_cli_output
PhaseC + E + G + B ──► PhaseH_polish
```

## Landed on branch

- React/`@opentui/react` TUI shell
- `ArtifactList.tsx` scrollbox + inline scope headers (fixes joined-header blob)
- `ReviewPane.tsx`, `keymap.ts`, row hover + click toggle
- `runInteractiveCleanup` orchestration seam + `applyReviewedPlan` shared apply path
- `@types/bun` catalog migration; literal semver in publish `peerDependencies`
- UI state reducers + test renderer

## Verification

```bash
bun run check
bun run rust:check   # when crates/ changes
```
