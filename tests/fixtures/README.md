# Parity fixtures

Committed directories and golden `expected.plan.json` files used by Rust
`insta` parity tests, JS engine contract tests, and regeneration via
`scripts/generate-parity-fixture.ts`.

| Fixture              | Scenario                                                             |
| -------------------- | -------------------------------------------------------------------- |
| `node_modules-only/` | Single root `node_modules`                                           |
| `basic/`             | `node_modules`, `tsconfig.tsbuildinfo`, plus an inert `dist`         |
| `monorepo/`          | Nested `packages/*` and `apps/*` artifacts, plus an inert `dist`     |
| `workspace-matrix/`  | Web/api packages, docs app, `target`, `.next`, `tsbuildinfo`         |
| `risk-mix/`          | `node_modules`, a `target` symlink (caution tier), inert `dist` dirs |
| `opt-in-patterns/`   | `dist`, `build`, `*.egg-info` enabled via `extraPatterns` + defaults |

The `dist`/`build`-style directories in these trees are deliberate: `dist` is
an opt-in catalog entry, so default-config scans must produce no candidate for
it on **both** engines. The fixtures therefore pin two parity rules at once -
default detection, and identical opt-in-name exclusion.

`opt-in-patterns/` exercises the other direction: `request.json` declares
`extraPatterns`, which the harness merges onto `DEFAULT_CONFIG.patterns`. Both
engines must land those matches at `dangerous` tier with the `opt-in-pattern`
reason and never pre-select them, while `node_modules` stays `safe` +
selected - trust follows the matched _name_, not which pattern fired.

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
