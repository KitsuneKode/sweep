# Parity fixtures

Committed directories and golden `expected.plan.json` files used by Rust
`insta` parity tests, JS engine contract tests, and regeneration via
`scripts/generate-parity-fixture.ts`.

| Fixture              | Scenario                                                      |
| -------------------- | ------------------------------------------------------------- |
| `node_modules-only/` | Single root `node_modules`                                    |
| `basic/`             | `node_modules`, `dist`, `tsconfig.tsbuildinfo`                |
| `monorepo/`          | Nested `packages/*` and `apps/*` artifacts                    |
| `workspace-matrix/`  | Web/api packages, docs app, `target`, `.next`, `tsbuildinfo`  |
| `risk-mix/`          | `node_modules`, `dist`, and a `target` symlink (caution tier) |

Refresh trees and goldens:

```bash
bun run scripts/sync-fixture-trees.ts
bun run scripts/generate-parity-fixture.ts -- tests/fixtures/<name>
```

Placeholders in golden JSON:

- `__FIXTURE_ROOT__` — replaced at test time with the absolute fixture path.

Candidates are sorted by normalized `path` before comparison. Byte estimates are
zeroed in goldens because JS `du` and Rust `metadata.len()` may differ across
platforms; parity compares structure, ids, and risk semantics.
