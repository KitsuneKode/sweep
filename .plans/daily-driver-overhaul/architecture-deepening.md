# Architecture deepening (reference)

Status: planned
Scope: product · ui · cli · engine
Created: 2026-06-24
Updated: 2026-06-24
Commit: uncommitted
Parent: [master.md](./master.md)

Reference only — informs **why** child plans exist. Full diagrams were in the
architecture review HTML (`/tmp/architecture-review-*.html`).

## Top recommendation (execution order)

1. **Deepen interactive review module** → [ui-review-pane.md](./ui-review-pane.md)
2. **Unify scan→review→apply orchestration** → [orchestration-seam.md](./orchestration-seam.md)
3. **Harden engine seam (JS + Rust)** → [trust-guardrails.md](./trust-guardrails.md), [rust-engine-parity.md](./rust-engine-parity.md)

## Candidates

### 1. Interactive review module (Strong)

**Problem:** `SweepApp` interface ≈ implementation — keyboard routing, layout, and
formatting leak across one file.

**Solution:** `ReviewPane` module; `ArtifactList` owns scrollbox rows; `keymap.ts`
owns focus-specific bindings. `SweepApp` = shell + overlays.

**Wins:** locality for list bugs; one test surface for row rendering.

### 2. Orchestration seam (Strong)

**Problem:** `ui.ts` rescan loop duplicates `scan`/`clean` sequencing.

**Solution:** `runInteractiveCleanup` in `apps/cli/src/orchestration/` with
`ReviewAdapter` injection.

**Wins:** one integration test for real user journey; in-TUI rescan without remount.

### 3. Engine adapters (Worth exploring)

**Problem:** JS/Rust fallback rules and feature gaps leak to callers.

**Solution:** Capability flags on engine seam; protocol schemas as contract;
parity tests mandatory before claiming Rust default.

### 4. Shared presentation (Speculative)

**Problem:** Byte columns and risk markers differ slightly between
`packages/display` and `packages/ui`.

**Solution:** Shared `artifactPresentation` module — defer until TUI stabilizes
(Phase F in master).

## Anti-patterns (do not reintroduce)

- Group headers inside `SelectRenderable` (fixed: `ArtifactList` + scrollbox)
- `catalog:` in published `peerDependencies`
- Duplicate rescan loops per handler
- Full-tree block before first `candidate_found`
