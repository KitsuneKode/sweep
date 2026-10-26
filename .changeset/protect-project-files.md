---
"@kitsunekode/sweep": patch
---

Project files can no longer be cleaned, whatever pattern or flag is used:
`src`, manifests and lockfiles (`package.json`, `Cargo.toml`, `go.mod`, ...),
`.env` files and `.sweeprc` classify as blocked, and `apply` re-checks them in
saved plans. A repository's own `.sweeprc` could previously add patterns for
them. When nothing is pre-selected, sweep now says what it found and points to
`sweep ui` for review instead of suggesting blanket flags.
