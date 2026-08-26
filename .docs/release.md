# Release & Distribution

Two independent shipping paths. They share the version number but not
machinery — do not couple them without a decision-log entry.

## 1. npm package (primary)

Driven by changesets in `.github/workflows/release.yml`:

1. Merge PRs with changeset files (`bunx changeset`).
2. On main, the changesets action opens/merges a **"chore: version packages"** PR.
3. On merge, `scripts/publish-release.ts` publishes `@kitsunekode/sweep` to npm.
   `dist/sweep.js` + `dist/sweep-ui.js` are built by `apps/cli/scripts/build.ts`
   (shared config in `scripts/bundle.ts`).

The optional Rust engine ships separately via
`.github/workflows/native-engine-release.yml` as platform packages
(`@kitsunekode/sweep-engine-*`) resolved at runtime.

## 2. Standalone binaries (npm platform packages — fully automated)

No tags, no manual steps. Everything rides the changesets flow:

1. `packages/platforms/<id>/package.json` are workspace members pinned in
   lockstep with `@kitsunekode/sweep` via the changesets **fixed** group
   (see `.changeset/config.json`) — one Version PR bumps all six identically.
2. When the Version PR merges, `release.yml` detects it and runs `build-cli` →
   `.github/workflows/cli-binaries.yml` (`workflow_call`) on five native runners.
3. Each runner bundles, compiles (`scripts/build-standalone.ts` from
   `bin-standalone.ts`, embedding OpenTUI natives), smokes (`--ui-probe`,
   `--version`), and packs into `packages/platforms/<id>/bin/`.
4. The publish job downloads packed packages, enforces matrix completeness,
   then `publish-release.ts` → `changeset publish` publishes the main package
   and all five platform packages with provenance.

| Platform package                  | Runner           | Binary          |
| --------------------------------- | ---------------- | --------------- |
| `@kitsunekode/sweep-darwin-arm64` | macos-latest     | `bin/sweep`     |
| `@kitsunekode/sweep-darwin-x64`   | macos-13         | `bin/sweep`     |
| `@kitsunekode/sweep-linux-x64`    | ubuntu-latest    | `bin/sweep`     |
| `@kitsunekode/sweep-linux-arm64`  | ubuntu-24.04-arm | `bin/sweep`     |
| `@kitsunekode/sweep-win-x64`      | windows-latest   | `bin/sweep.exe` |

### How installs resolve

The main package's `bin/sweep.cjs` launcher prefers the matching platform
package's binary and falls back to bundled `dist/sweep.js` (plain Node ≥ 18).
Platform packages ship as optionalDependencies of `@kitsunekode/sweep`.

The dev/npm flow keeps dynamic `sweep-ui.js` sibling loading — only standalone
binaries use the static entrypoint.

### Manual validation run

`.github/workflows/cli-binaries.yml` also supports `workflow_dispatch`
(build-only, no publish) for validating binary builds without a release.

### Verification checklist before release

- [ ] `bun run check` green locally
- [ ] `bun run build` then `node apps/cli/dist/sweep.js scan . --json` sane
- [ ] `sweep ui` manual pass: boot speed, streaming fill, `r` rescan,
      tree fold/unfold, filter ladder (`esc`), confirm dialog on risky select
- [ ] Changesets present for every user-facing change

## Known distribution gaps

- linux-arm64 binary: needs either an arm64 runner or cross-compile validation
- musl (Alpine): requires `OPENTUI_LIBC=musl` build variant — not wired yet
- Windows TUI: OpenTUI native FFI works under Bun on Windows; CI smoke covers
  non-TTY commands only, interactive verification is manual
