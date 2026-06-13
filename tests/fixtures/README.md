# Parity fixtures

Committed directories and golden `expected.plan.json` files used by Rust
`insta` parity tests and optional JS regeneration via `scripts/generate-parity-fixture.ts`.

Placeholders in golden JSON:

- `__FIXTURE_ROOT__` — replaced at test time with the absolute fixture path.

Byte estimates are zeroed in goldens because JS `du` and Rust `metadata.len()` may differ
across platforms; parity compares structure, ids, and risk semantics.
