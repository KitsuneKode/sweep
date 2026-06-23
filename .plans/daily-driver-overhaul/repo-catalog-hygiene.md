# Repo and catalog hygiene

Status: planned
Scope: repo
Created: 2026-06-24
Updated: 2026-06-24
Commit: uncommitted
Parent: [master.md](./master.md)

## Why

Fast, low-risk fixes that unblock reliable dev workflow and correct publish manifests.
Incorporates original overhaul **Phase 0** plus the **catalog / `@types/bun`**
audit.

## Part 1 — Monorepo hygiene (original P0)

Audit and fix (skip if already done on branch):

- [ ] `lint-staged` config in root [`package.json`](../../package.json) (pre-commit runs it)
- [ ] Turbo cache input `tests/fixtures/**` in [`packages/integration-tests/turbo.json`](../../packages/integration-tests/turbo.json)
- [ ] Remove unused root devDeps if still present (`@kitsunekode/sweep-protocol`, `@kitsunekode/sweep-test-fixtures`)
- [ ] [`packages/engine-native/package.json`](../../packages/engine-native/package.json): `@kitsunekode/sweep-core` in `devDependencies` only
- [ ] Drop stale devDeps in integration-tests (e.g. `@kitsunekode/sweep-cli`)
- [ ] Doc drift: [`.docs/workspace-layout.md`](../../.docs/workspace-layout.md) paths match `apps/cli/scripts/build.ts`

**Verify:** `bun run check`; `git commit` hook runs format/lint on staged files.

## Part 2 — Catalog and Bun types

### What `catalog:` means (not a bug)

Bun workspace catalog: versions pinned in root `workspaces.catalog`; packages use
`"typescript": "catalog:"`. Resolved at `bun install` into [`bun.lock`](../../bun.lock).

### Migrate `bun-types` → `@types/bun` (decided)

| Package      | Role                                                        |
| ------------ | ----------------------------------------------------------- |
| `bun-types`  | Canonical definitions (Bun repo)                            |
| `@types/bun` | DT shim depending on `bun-types`; Bun's recommended install |

**Steps:**

1. Catalog: replace `"bun-types"` with `"@types/bun": "^1.3.0"` (align with `packageManager` `bun@1.3.12`).
2. Add `"@types/bun": "catalog:"` to **every** workspace that runs `typecheck` / `bun test` (not only root, integration-tests, engine-native).
3. Update [`packages/typescript-config/tsconfig.base.json`](../../packages/typescript-config/tsconfig.base.json) and root [`tsconfig.json`](../../tsconfig.json): match `bun init` (`"types": ["bun"]` or omit if auto-discovery suffices).
4. Remove direct `bun-types` from all `package.json` files.
5. `bun install` → refresh lockfile.

### Publish manifest fix

[`apps/cli/package.json`](../../apps/cli/package.json) must **not** use `catalog:` in
`peerDependencies`:

```json
"peerDependencies": {
  "@opentui/core": "^0.2.16"
}
```

Optional: preflight check rejecting `catalog:` in any publish field.

### Document

[`.docs/tooling.md`](../../.docs/tooling.md) — catalog syntax, `@types/bun` choice,
rule: `catalog:` only in workspace deps, never in published `peerDependencies`.

**Verify:**

```bash
bun install
bun run check
npm pack -w @kitsunekode/sweep --dry-run  # inspect peerDependencies in tarball
```

## Done

- [ ] P0 hygiene items verified or fixed
- [ ] `@types/bun` on all typechecking workspaces
- [ ] `peerDependencies` use literal semver
- [ ] `.docs/tooling.md` updated
- [ ] `bun run check` passes
