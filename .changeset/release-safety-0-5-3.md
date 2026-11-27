---
"@kitsunekode/sweep": patch
---

Make npm installs and UI startup safer across Node and Bun:

- Move `@opentui/core` to `optionalDependencies` so Node.js 20.3+ installs skip it cleanly while Bun installs (`bun add -g @kitsunekode/sweep` and `bunx @kitsunekode/sweep ui`) still get the terminal UI.
- Verify the resolved `@opentui/core` version and required exports before `sweep ui` loads, reporting the offending path, version, and recovery options instead of a raw `SyntaxError` when a shared global tree holds an older copy. `sweep doctor` reports the same check and no longer warns about OpenTUI in standalone binaries.
- Build the published CLI, UI, and standalone bundles with `NODE_ENV="production"` (smaller `sweep-ui.js`, no React development mode) and strip workspace `devDependencies` and monorepo scripts from the published manifest.
- Keep the Rust engine probe's failure reason (exit status, signal, or first stderr line such as a loader error) in `sweep doctor` (text and `--json`) and print a single stderr note when `--engine auto` falls back to JS for a reason other than the binary not being installed. When Bun's JS directory reader cannot start `node`, report a missing-runtime error rather than a scan resource limit.
- Projects view search now hints `older:30d` instead of the nonexistent `idle:30d` key and shows filter advice for malformed queries.
- Shell completions now scope `--allow-dangerous` to clean/apply and complete `--view` and `--theme` values in bash, zsh, and fish.
