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

Internal workspace packages are `private` and unpublished. They still need a
`version` field so `@kitsunekode/sweep` can depend on them during `changeset
version`. `.changeset/config.json` sets `privatePackages.version: true` so
those packages are not skipped; they are not tagged or published.

The optional Rust engine ships separately via
`.github/workflows/native-engine-release.yml` as platform packages
(`@kitsunekode/sweep-engine-*`) resolved at runtime.

### npm authentication: trusted publishing (OIDC)

There is no `NPM_TOKEN` secret. The release job authenticates to npm over OIDC,
which needs three things to line up:

- `id-token: write` on the job (already set).
- npm >= 11.5.1 and Node >= 22.14. The job pins Node 24 and asserts the npm
  version before publishing.
- `actions/setup-node@v6` or newer. v4 and v5 write an `_authToken=` line into
  `.npmrc`; npm reads that as "auth is configured" and never starts the OIDC
  exchange, which fails the publish with `ENEEDAUTH` even though OIDC is
  available. This is what broke the first 0.3.0 attempt.

Provenance is generated automatically under trusted publishing, so nothing
passes `--provenance`.

Each published package needs a trusted publisher registered on npmjs.com
(package Settings -> Trusted Publisher): GitHub Actions, owner `KitsuneKode`,
repository `sweep`, workflow `release.yml`. That covers `@kitsunekode/sweep`
and every `@kitsunekode/sweep-engine-*` package.

**A brand-new package cannot be bootstrapped this way.** npm only exposes the
trusted-publisher setting on a package that already exists, so a new platform
package needs one authenticated publish from a human before CI can take over:

```bash
bun run bootstrap:npm-trust                      # report only
bun run bootstrap:npm-trust -- --publish --trust # apply (prompts 2FA)
```

That publishes a binary-free placeholder at `0.0.1` for any missing package —
deliberately below any shipping version, because the CLI pins its engines to an
exact version — and then registers the trusted publisher for every package via
`npm trust github`, so no clicking through npmjs.com. It skips packages that
already exist, so re-run it whenever a platform is added to `NATIVE_PLATFORMS`.

Every npm write on this account requires 2FA, including `npm trust list`, so
this has to be run by a human; CI cannot do it.

## 2. Standalone binaries (GitHub releases)

`.github/workflows/cli-binaries.yml`, triggered by pushing a tag `v*`:

| Artifact             | Runner         | Notes         |
| -------------------- | -------------- | ------------- |
| `sweep-darwin-arm64` | macos-latest   | Apple Silicon |
| `sweep-darwin-x64`   | macos-13       | Intel         |
| `sweep-linux-x64`    | ubuntu-latest  | glibc         |
| `sweep-win-x64`      | windows-latest | `.exe`        |

Each is built by `scripts/build-standalone.ts` from `apps/cli/src/bin-standalone.ts`
— an entrypoint that imports the UI module statically and registers it before the
CLI boots. The static graph makes Bun embed the UI code and OpenTUI's native
library/worker/grammars, so no asset extraction or `OTUI_ASSET_ROOT` is needed at
runtime. Every binary runs two smoke tests before upload: `--ui-probe` (proves the
embedded UI graph loads, including native dlopen) and `--version`. All four are
attached to the tag's GitHub release.

The npm package keeps the dynamic `sweep-ui.js` sibling loading — only standalone
binaries use the static entrypoint.

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
