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

## 2. Standalone binaries (npm platform packages + GitHub releases)

`.github/workflows/cli-binaries.yml`, triggered by pushing a tag `v*`
(or workflow_dispatch once the file lands on main):

| Platform package                  | Runner           | Binary          |
| --------------------------------- | ---------------- | --------------- |
| `@kitsunekode/sweep-darwin-arm64` | macos-latest     | `bin/sweep`     |
| `@kitsunekode/sweep-darwin-x64`   | macos-13         | `bin/sweep`     |
| `@kitsunekode/sweep-linux-x64`    | ubuntu-latest    | `bin/sweep`     |
| `@kitsunekode/sweep-linux-arm64`  | ubuntu-24.04-arm | `bin/sweep`     |
| `@kitsunekode/sweep-win-x64`      | windows-latest   | `bin/sweep.exe` |

Flow per runner: bundle CLI+UI → `bun build --compile` via
`scripts/build-standalone.ts` from `apps/cli/src/bin-standalone.ts` (the static
UI import embeds OpenTUI's native library/worker/grammars — no
`OTUI_ASSET_ROOT` needed) → smoke (`--ui-probe`, `--version`) →
`packages/cli-native/scripts/pack.ts` produces a publishable npm package under
`native-packages/<id>/`.

Jobs then:

1. attach raw binaries to the tag's GitHub release
2. `npm publish --access public --provenance` each platform package

### How installs resolve

The main package's `bin/sweep.js` launcher prefers the matching platform
package's binary and falls back to bundled `dist/sweep.js` (plain Node ≥ 18).
Platform packages ship as optionalDependencies of `@kitsunekode/sweep`; when a
platform is added, also add its optionalDependencies entry (wiring this sync
into the changesets publish step is a tracked follow-up).

The dev/npm flow keeps dynamic `sweep-ui.js` sibling loading — only standalone
binaries use the static entrypoint.

### Cut a binary release

```bash
git tag vX.Y.Z && git push origin vX.Y.Z   # builds, smokes, attaches, publishes
```

### Verification checklist before tagging

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
