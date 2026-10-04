# Release & Distribution

Two shipping paths share an immutable source version. npm publication dispatches
the standalone workflow using a matching `vVERSION` alias; the alias decision is
recorded in [decision log](decision-log.md). Local edits are not a hosted release.

## 1. npm package (primary)

Driven by changesets in `.github/workflows/release.yml`:

    1. Merge PRs with changeset files (`bunx changeset`).
    2. On main, the changesets action opens a **"chore: version packages"** PR.
       Review and merge it separately; the action does not approve its own PR.
    3. On merge, `scripts/publish-release.ts` publishes `@kitsunekode/sweep` to npm.
       `dist/sweep.js` + `dist/sweep-ui.js` are built by `apps/cli/scripts/build.ts`
       (shared config in `scripts/bundle.ts`).

Release jobs are serialized without cancelling an in-flight publication. Native
build intent comes from the version, applied changesets and scoped tag state,
not a commit-message substring. CI requires every native artifact and checks
all package versions before the first publish.

`scripts/publish-release.ts` also waits for successful push CI on the exact
`GITHUB_SHA` before any registry write. Failed, cancelled, skipped or missing
qualification refuses publication; a different commit's pass is insufficient.
This read-only gate requires GitHub CLI access and has a 30-minute deadline.

Stable publishes explicitly use
`latest`; preview versions use `next` or the active Changesets prerelease tag.
The policy rejects prerelease/latest and conflicting pre-mode tags. Changesets
pre mode controls its own tag and rejects an extra `--tag` argument.

After publication, the workflow verifies that Changesets' scoped package tag
points at the checked-out commit, creates a matching immutable `vVERSION`
alias, and explicitly dispatches the binary workflow. A GITHUB_TOKEN tag push
does not automatically trigger another workflow. If binary building fails
after npm succeeds, retry that workflow on the exact alias; do not republish
the package or move an existing tag. Hosted qualification of this routing is
still required.

Internal workspace packages are `private` and unpublished. They still need a
`version` field so `@kitsunekode/sweep` can depend on them during `changeset
version`. `.changeset/config.json` sets `privatePackages.version: true` so
those packages are not skipped; they are not tagged or published.

The optional Rust engine ships separately via
`.github/workflows/native-engine-release.yml` as platform packages
(`@kitsunekode/sweep-engine-*`) resolved at runtime. Linux ARM64 uses a native
ARM64 runner; each packaged engine runs the apply/outcome/cancellation contract
tests before artifact upload. Configured jobs still require a successful hosted
run before release qualification.

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

That publishes a binary-free placeholder at `0.0.1` for any missing package -
deliberately below any shipping version, because the CLI pins its engines to an
exact version - and then registers the trusted publisher for every package via
`npm trust github`, so no clicking through npmjs.com. It skips packages that
already exist, so re-run it whenever a platform is added to `NATIVE_PLATFORMS`.

Every npm write on this account requires 2FA, including `npm trust list`, so
this has to be run by a human; CI cannot do it.

## 2. Standalone binaries (GitHub releases)

`.github/workflows/cli-binaries.yml` accepts `v*`, scoped npm package tags, and
manual dispatch. Normal npm release dispatches it on the canonical `v*` alias:

| Artifact             | Runner           | Notes         |
| -------------------- | ---------------- | ------------- |
| `sweep-darwin-arm64` | macos-latest     | Apple Silicon |
| `sweep-darwin-x64`   | macos-15-intel   | Intel         |
| `sweep-linux-x64`    | ubuntu-latest    | glibc         |
| `sweep-linux-arm64`  | ubuntu-24.04-arm | glibc ARM64   |
| `sweep-win-x64`      | windows-latest   | `.exe`        |

Each is built on its target runner by `scripts/build-standalone.ts` from
`apps/cli/src/bin-standalone.ts`, with ESM bytecode. The static UI import embeds
OpenTUI's native library/worker/grammars. A matching host Rust engine is compiled
and embedded as an asset, then extracted lazily into a private owned temporary
directory. Normal exit removes that directory; SIGKILL or a machine crash can
leave it behind. Help/version avoid extraction. Runtime dotenv/bunfig autoload
is disabled so scanning a project does not import its Bun runtime settings.
No external Node, Bun or Rust engine is needed for the default standalone scan.

Before upload, every runner checks `--ui-probe`, `--version`, and an owned scan
with PATH emptied. Each binary also gets a streaming, round-trip-verified `.gz` archive with its
own SHA-256 sidecar. The raw assets and installer path remain available; archives
reduce download size without changing the executable. All five binaries attach to one release; preview releases
are marked prerelease and cannot update the stable Homebrew formula. Linux
local success does not substitute for passing those hosted platform jobs.

The workflow also builds `sweep-engine-TARGET` assets (with `.exe` on Windows),
their checksums and verified gzip archives. These small files expose the machine
scan/apply protocol and contain neither the terminal UI nor the Bun runtime.
They complement the full `sweep-TARGET` application and the optional native npm
packages. Keep their download labels distinct. A manual dispatch on `main`
builds and tests artifacts without attaching a public release.

The npm package keeps the dynamic `sweep-ui.js` sibling loading - only standalone
binaries use the static entrypoint.

### Retry or qualify a binary release

```bash
gh workflow run cli-binaries.yml --ref vX.Y.Z
```

### Preview, then stable

Complete the local checks and record raw performance/resource evidence before
requesting publication. The current remaining release gates include real
macOS/Windows/ARM64 installed packages and terminals, interrupt/outcome behavior,
dependency advisory checking, and deletion behavior at mount boundaries and
under concurrent path replacement. See [resource limits](resource-limits.md).

For a preview, use Changesets pre mode with a dedicated tag such as `next`, review
the generated version PR and exact native versions, then run the authorized
release workflow. Test the installed preview package and downloaded checksummed
binaries on each target platform. Promote through Changesets' normal version
flow after exit from pre mode; never move tags or overwrite registry versions.
Announce measured workload/runtime details and estimated cleanup savings,
rather than universal p99, physical bytes reclaimed or guaranteed OOM safety.
Commit, tag and publish still require explicit user authorization in agent work.

### Local verification checklist

- [ ] `bun run check` green locally
- [ ] `bun run rust:check` green for native changes
- [ ] `bun run build` then `node apps/cli/dist/sweep.js scan . --json` sane
- [ ] `sweep ui` manual pass: boot speed, streaming fill, `r` rescan,
      tree fold/unfold, filter ladder (`esc`), confirm dialog on risky select
- [ ] Changesets present for every user-facing change
- [ ] Resource/latency evidence recorded; actual platform artifacts qualified

`bun run verify -- --all` includes installation of local CLI/native npm tarballs
into an owned temporary directory, followed by installed JS/Rust scan/save/apply
without an engine-path override. This uses the local offline npm cache and makes
no registry writes. It does not qualify remote package availability, optional
dependency auto-installation, or interactive terminals on other operating systems.

Native Linux destructive apply requires kernel support for restricted `openat2`
resolution. Older kernels refuse safely; users can choose JS with the documented
mount-snapshot and pathname limitations. Run the private namespace mount fixture
from [testing](testing.md) before accepting a Linux deletion release.

## Known distribution gaps

- musl (Alpine): requires `OPENTUI_LIBC=musl` build variant - not wired yet
- Windows TUI: OpenTUI native FFI works under Bun on Windows; CI smoke covers
  non-TTY commands only, interactive verification is manual
