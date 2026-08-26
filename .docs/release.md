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

## 2. Standalone binaries (GitHub releases)

`.github/workflows/cli-binaries.yml`, triggered by pushing a tag `v*`:

| Artifact             | Runner         | Notes         |
| -------------------- | -------------- | ------------- |
| `sweep-darwin-arm64` | macos-latest   | Apple Silicon |
| `sweep-darwin-x64`   | macos-13       | Intel         |
| `sweep-linux-x64`    | ubuntu-latest  | glibc         |
| `sweep-win-x64`      | windows-latest | `.exe`        |

Each is `bun build --compile apps/cli/dist/sweep.js` — Bun embeds OpenTUI's
native library, worker, and grammars per the official standalone-executables
guide, so no asset extraction or `OTUI_ASSET_ROOT` is required at runtime.
Every binary runs a `--version` smoke test before upload; all four are
attached to the tag's GitHub release.

### Cut a binary release

```bash
git tag vX.Y.Z && git push origin vX.Y.Z   # binaries build + attach automatically
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
