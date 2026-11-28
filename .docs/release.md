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

Release jobs are serialized without cancelling an in-flight publication, and
`.github/workflows/release.yml` requires the canonical repository
(`KitsuneKode/sweep`) and `refs/heads/main` for both push and manual dispatch.
Native build intent comes from the version, applied changesets and scoped tag
state, not a commit-message substring. CI requires every native artifact and
checks all package versions before the first publish. Before publishing the
first engine package, `scripts/publish-release.ts` verifies that all seven
`@kitsunekode/sweep-engine-*` packages are already registered on npm (failing
fast instead of stranding partial publishes on an unregistered name), and
confirms all seven are queryable at the exact release version before promoting
`@kitsunekode/sweep`.

`scripts/publish-release.ts` first checks whether every target package version
is already published on npm. When nothing is unpublished, it verifies (or creates
only under the `gitHead` rules below) the scoped tag and exits 0 with
`nothing to publish` without requiring push CI on a no-op commit. Whenever any
package version is unpublished, it waits for successful push CI on the exact
`GITHUB_SHA` before any registry write. Failed, cancelled, skipped or missing
qualification refuses publication; a different commit's pass is insufficient.
This read-only gate requires GitHub CLI access and has a 30-minute deadline.

Stable publishes explicitly use
`latest`; preview versions use `next` or the active Changesets prerelease tag.
The policy rejects prerelease/latest and conflicting pre-mode tags. Changesets
pre mode controls its own tag and rejects an extra `--tag` argument.

After publication, `apps/cli/scripts/prepack.ts` embeds the exact source commit
SHA (`gitHead`) into the packed tarball manifest so `@kitsunekode/sweep` on npm
carries authoritative `gitHead` metadata. `scripts/publish-release.ts` only
creates a missing `@kitsunekode/sweep@X.Y.Z` tag at the verified npm `gitHead`
commit (never blindly at the current checkout), after proving `origin/main`
ancestry and `apps/cli/package.json` version parity.
`apps/cli/scripts/reconcile-release.ts` requires canonical
`KitsuneKode/sweep` + `refs/heads/main`, a resolved `origin/main` ref (never
falling back to `HEAD`), and verified npm `gitHead` publication identity
(refusing automatic qualification/reconciliation for legacy versions without
`gitHead`, such as `0.5.2`, and printing the manual path), verifies the commit
is on `main` and carries the exact `apps/cli/package.json` version, creates a
matching immutable `vVERSION` alias (refusing to move a mismatched existing
tag), deduplicates any in-flight or queued `cli-binaries.yml` run by tag+SHA
and `release-downstream.yml` run by release version and channel, tracks
Homebrew tap and Scoop bucket updates separately (never downgrading), and
explicitly dispatches `cli-binaries.yml` on `vVERSION` (or
`release-downstream.yml` on `main` when only downstream channels need a retry).
A GITHUB_TOKEN tag push does not automatically trigger another workflow.

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
exact version - and then checks `npm trust list <pkg> --json` before calling
`npm trust github ... --allow-publish`, skipping packages that already carry a
matching `KitsuneKode/sweep` + `release.yml` trusted publisher with publish
allowed so you are not prompted for 2FA once per already-configured package. It
skips packages that already exist on npm, falls back to configuring if
`npm trust list` fails or is unsupported, and prints a summary at the end, so
re-run it whenever a platform is added to `NATIVE_PLATFORMS`.

Every npm write on this account requires 2FA, so this has to be run by a human;
CI cannot do it.

## 2. Standalone binaries (GitHub releases)

`.github/workflows/cli-binaries.yml` accepts `v*` tags and manual dispatch.
Normal npm release dispatches it on the canonical `v*` alias:

| Artifact                 | Runner           | Notes                                     |
| ------------------------ | ---------------- | ----------------------------------------- |
| `sweep-darwin-arm64`     | macos-latest     | Apple Silicon                             |
| `sweep-darwin-x64`       | macos-15-intel   | Intel                                     |
| `sweep-linux-x64`        | ubuntu-latest    | glibc 2.17+ via `cargo-zigbuild`          |
| `sweep-linux-x64-musl`   | ubuntu-latest    | musl (`OPENTUI_LIBC=musl`, static engine) |
| `sweep-linux-arm64`      | ubuntu-24.04-arm | glibc 2.17+ via `cargo-zigbuild`          |
| `sweep-linux-arm64-musl` | ubuntu-24.04-arm | musl (`OPENTUI_LIBC=musl`, static engine) |
| `sweep-win-x64`          | windows-latest   | `.exe`                                    |

Each is built on its target runner by `scripts/build-standalone.ts` from
`apps/cli/src/bin-standalone.ts`, with ESM bytecode. The static UI import embeds
OpenTUI's native library/worker/grammars. A matching host Rust engine is compiled
and embedded as an asset, then extracted lazily into a private owned temporary
directory. Normal exit removes that directory; SIGKILL or a machine crash can
leave it behind. Help/version avoid extraction. Runtime dotenv/bunfig autoload
is disabled so scanning a project does not import its Bun runtime settings.
No external Node, Bun or Rust engine is needed for the default standalone scan.

Before upload, Linux jobs enforce ELF ABI metadata via
`packages/engine-native/scripts/check-elf-abi.ts` across the standalone
executable, embedded Rust engine, and embedded OpenTUI shared object (glibc <=
2.17 with zero `GLIBC_ABI_DT_RELR` / `GLIBC_PRIVATE` for gnu targets; zero
`DT_NEEDED` and zero glibc symbols for static musl engines; `ld-musl` and zero
glibc symbols for dynamic musl standalones), smoke-run the artifacts inside
`debian:11-slim` or `alpine:3.21`, and qualify the rendered Homebrew formula
with `brew install --formula` from a local tap. Every runner checks
`--ui-probe`, `--version`, and an owned scan with PATH emptied. Each binary
also gets a streaming, round-trip-verified `.gz` archive with its own SHA-256
sidecar and a GitHub build provenance attestation
(`actions/attest-build-provenance`).

Tag-triggered `.github/workflows/cli-binaries.yml` holds only `contents: read`
(plus `id-token: write` / `attestations: write` for build provenance): it
builds all seven targets, runs ELF/container/Homebrew qualification, and
uploads workflow artifacts without ever writing to GitHub Releases or
downstream repositories.

All privileged release publication lives in the canonical-`main` workflow
`.github/workflows/release-downstream.yml` (never loaded from a tag). It
triggers via `workflow_run` when `CLI Binaries` completes successfully (or via
manual `workflow_dispatch` on `main` for downstream-only retries):

1. `qualify` runs outside the `release-downstream` environment with read-only
   permissions, checks out `main`, verifies the tag with
   `apps/cli/scripts/verify-release-tag.ts` against `origin/main`, push CI,
   `release.yml`, and independent npm `gitHead` publication proof, and confirms
   all seven `CLI Binaries` targets plus `qualify Homebrew formula` succeeded
   (on manual `workflow_dispatch`, it also verifies all 56 expected release
   assets and validates the target channel's SHA-256 digests).
2. `attach` (only on `workflow_run`, outside `release-downstream`, with
   `contents: write` and `actions: read`) downloads the verified workflow
   artifacts from the triggering `CLI Binaries` run, validates the exact 56-file
   asset inventory and every `.sha256` checksum, extracts release notes from the
   qualified commit's `apps/cli/CHANGELOG.md`, and attaches them to the GitHub
   Release. Preview releases are marked prerelease and cannot update Homebrew
   or Scoop.
3. `update-homebrew` and `update-scoop` enter the `main`-only
   `release-downstream` environment with minimal `contents: read` permissions
   only after `attach` succeeds (or after `qualify` independently verifies the
   attached release assets on manual dispatch). Both render templates from
   canonical `main`, enforce `--reject-downgrade`, bind git push auth via
   `gh auth setup-git --hostname github.com` with their repo-scoped token, and
   skip cleanly when `TAP_GITHUB_TOKEN` or `SCOOP_BUCKET_TOKEN` is unset. Linux
   local success does not substitute for passing those hosted platform jobs.

### One-time owner repository setup

1. **Before adding or enabling downstream tokens, restrict GitHub Environment
   `release-downstream` to branch `main` only** in repository Settings ->
   Environments: remove the `v*` tag deployment policy completely (nothing in
   the pipeline runs inside `release-downstream` from a tag, so no tag workflow
   can ever receive environment secrets; optionally add required reviewers),
   then configure `TAP_GITHUB_TOKEN` (`contents:write` on
   `KitsuneKode/homebrew-tap`) and `SCOOP_BUCKET_TOKEN` (`contents:write` on
   `KitsuneKode/scoop-bucket`) as environment secrets.
2. **Tag protection ruleset (`release-tags`)** in repository Settings -> Rules ->
   Rulesets covers `refs/tags/v*` and `refs/tags/@kitsunekode/sweep@*`, blocking
   update, deletion, and non-fast-forward (force-push) with repository-admin
   bypass. Tag creation is not restricted because a personal-account repository
   cannot exempt the GitHub Actions app; release and downstream credential
   isolation relies on `cli-binaries.yml` holding `contents: read` only,
   `release-downstream.yml` running exclusively from `main`, verifying tags
   against `origin/main` + independent npm `gitHead` + CI + `release.yml`, and
   restricting the `release-downstream` environment to branch `main` only.
3. **Bootstrap the two musl engine npm packages** (`@kitsunekode/sweep-engine-linux-64-musl`
   and `@kitsunekode/sweep-engine-linux-arm64-musl`) via
   `bun run bootstrap:npm-trust -- --publish --trust` before merging the release
   version PR that ships them.
4. **Seed `KitsuneKode/scoop-bucket`** (`bucket/sweep.json` from
   `packaging/scoop/sweep.json`) or let the first `v0.5.4+` release with
   `SCOOP_BUCKET_TOKEN` create it.

### Retry a binary or downstream release

```bash
# Rebuild and re-attach all standalone binaries (triggers release-downstream.yml on completion):
gh workflow run cli-binaries.yml --ref vX.Y.Z

# Retry downstream Homebrew and/or Scoop updates from an existing GitHub Release (runs on main):
gh workflow run release-downstream.yml --ref main -f tag=vX.Y.Z -f downstream=all
gh workflow run release-downstream.yml --ref main -f tag=vX.Y.Z -f downstream=homebrew
gh workflow run release-downstream.yml --ref main -f tag=vX.Y.Z -f downstream=scoop
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

- Windows ARM64: not yet built or published as a native engine or standalone target
- Windows TUI: OpenTUI native FFI works under Bun on Windows; CI smoke covers
  non-TTY commands only, interactive verification is manual
