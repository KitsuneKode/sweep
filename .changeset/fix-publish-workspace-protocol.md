---
"@kitsunekode/sweep": patch
---

Fix an uninstallable package. 0.3.0 shipped with Bun's `workspace:` and
`catalog:` dependency protocols left unresolved in the published manifest, so
every `npm install @kitsunekode/sweep` failed with `EUNSUPPORTEDPROTOCOL` and
`bun install` failed to resolve the workspace dependencies.

`bun publish` rewrites those protocols while packing, but `npm publish` — which
`changeset publish` shells out to — ships the literal strings. The pack step now
resolves `catalog:` entries against the root catalog and drops the internal
`workspace:` packages, which are private, never published, and already inside
the bundle. A guard fails the pack if any unresolvable specifier survives, and
the original manifest is restored afterwards.
