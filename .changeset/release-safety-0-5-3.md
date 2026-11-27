---
"@kitsunekode/sweep": patch
---

Make npm installs, Node 20.3+ scans, and UI startup safer across Node, Bun, and Windows:

- Move `@opentui/core` to `optionalDependencies`. Bun (`bun add -g @kitsunekode/sweep`, `bunx @kitsunekode/sweep ui`, including `bun install --production`) and Yarn 4 install it automatically. pnpm and Yarn 1 skip linking it on Node older than 26.4 (Yarn 1 prints an engine warning), and npm on Node older than 26.4 leaves `@opentui/core` unmet and may still extract `@opentui/core-<platform>` unless `--omit=optional` is passed. In all of these cases, `sweep` installs and runs CLI commands on Node.js 20.3+.
- Preserve raw non-UTF-8 filename scanning on Node.js 20.3–20.7 by using `encoding: "hex"` (and fd-based directory opens for raw directory paths) instead of crashing with `ERR_INVALID_ARG_TYPE` from `Dir.read()`.
- Verify the resolved `@opentui/core` version (following npm prerelease semver rules) and required exports before `sweep ui` loads, reporting the offending path, version, and recovery options (reinstall, `bunx`, or cross-platform standalone binaries) instead of a raw `SyntaxError` when a shared global tree holds an incompatible copy. `sweep doctor` reports the same check and no longer warns about OpenTUI in standalone binaries.
- Build the published CLI, UI, and standalone binaries with `NODE_ENV="production"` and the production JSX transform for `@opentui/react` (smaller `sweep-ui.js`, working outer ErrorBoundary in standalone builds, no React development mode), and strip workspace `devDependencies` and monorepo scripts from the published manifest.
- Align Rust engine `PATH`/`PATHEXT` resolution with native shell-free spawn semantics (skip non-executable POSIX files and Windows `.CMD`/`.BAT` shims ahead of a real `.exe`, preserve literal spaces and empty POSIX `PATH` segments, apply `PATHEXT` to extensionless Windows paths, and report missing explicitly configured paths instead of silent `not_installed`).
- Keep the Rust engine probe's failure reason in `sweep doctor` and emit both a stable enumerated `reasonKind` and a human-readable `reason` sentence for warning checks in `sweep doctor --json`. `--engine auto` prints a single stderr note when falling back to JS for any reason other than `not_installed`. When Bun's JS directory reader cannot start `node`, report a missing-runtime error rather than a scan resource limit.
- Projects view search now hints `older:30d` instead of the nonexistent `idle:30d` key and shows filter advice for malformed queries.
- Shell completions now scope `--allow-dangerous` to clean/apply and complete `--view` and `--theme` values in bash, zsh, and fish.
