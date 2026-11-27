Status: in_progress
Scope: repo
Created: 2026-11-27
Updated: 2026-11-27
Commit: t3/land-worktree-audit-fixes

# 2026-11-27 Repository Audit Index

This index records the owner decisions and phased remediation plan derived from
the 2026-11-27 repository audits of `sweep` at commit `a5a1c41` plus the
`feat/worktree-units` branch. Full raw audit reports are kept privately outside
the public repository.

- Merged tracking ledger (`AU01`–`AU28`): [remaining-work.md](../remaining-work.md)

## Owner Decisions (`D1`–`D10`)

| ID    | Decision                                                                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `D1`  | Keep `@opentui/core` as an `optionalDependency` (so Node 20/22/24 `npx` and `npm i -g` stay clean), paired with startup version/export verification, a bundle-vs-manifest release gate, and an isolated Bun global install PTY smoke test. |
| `D2`  | Set the Linux native engine ABI floor to `glibc 2.17` via `cargo-zigbuild` with an ELF symbol-version gate and old-distro container smoke, alongside `musl` packages and compressed `.gz` installer/Homebrew assets.                       |
| `D3`  | `"reclaimable"` means **safe + caution** everywhere (CLI, status, Projects view, Folders view, and web examples); guarded (`dangerous` + `blocked`) items are always shown separately.                                                     |
| `D4`  | Project activity that cannot be proven is `"unknown"` and is always excluded from idle queues (`--idle` and interactive idle actions).                                                                                                     |
| `D5`  | A linked worktree is `"Finished"` only on a proven merge into a verified base branch with a clean working tree; a missing upstream (`upstream_gone`) displays `"Tracking branch missing · check git"` and is never listed as finished.     |
| `D6`  | Track security-sensitive items as private security advisories (see below) and land their fixes privately without publishing exploitation details.                                                                                          |
| `D7`  | Remove the broken `packages.default` output from `flake.nix` instead of shipping an unbuildable derivation.                                                                                                                                |
| `D8`  | Adopt the Clove-inspired Storage Card and Dot-Grid Canvas hierarchy across both the terminal UI and website while preserving Sweep's olive-chartreuse identity and trust invariants.                                                       |
| `D9`  | Add a read-only whole-disk `"where your space goes"` report (extending ledger item `L3`) in Phase 7 without expanding destructive cleanup authority.                                                                                       |
| `D10` | Land the owner's worktree WIP with its Phase 0 audit fixes first, remove the five approved stray root folders in the owner's local checkout, and execute the remaining audit fixes sequentially across Phases 1–7.                         |

## Private Security Advisories

Tracked privately under `D6` (no implementation or exploitation details are
recorded in this public repository):

| ID     | Title                                              | Phase   |
| ------ | -------------------------------------------------- | ------- |
| `AU22` | Subprocess executable resolution hardening         | Phase 4 |
| `AU23` | Untrusted metadata file handling and root controls | Phase 4 |
| `AU24` | Config initialization write atomicity              | Phase 4 |

## Phase Plan

### Phase 0 — Land worktree WIP & audit ledger (`AU01`, `AU02` budget) — _this PR_

- Land owner WIP from `feat/worktree-units` as a dedicated first commit.
- Apply D5 worktree labeling fixes: evaluate `upstream_gone` before merge
  classification; show `app · branch missing` on the row and `"Tracking branch
  missing · check git"` in the details margin; reserve **Finished worktrees**
  for clean, proven-merged worktrees against a verified base (`origin/HEAD`,
  else main worktree branch when no `origin` remote is configured, never a
  guessed local `main`/`master`).
- Determine worktree cleanliness data-only (parse `.git/index`, verify stat
  data and `ls-tree`, reject unsupported index layouts/flags/submodules and
  in-progress operations, bounded `.gitignore`/`info/exclude` untracked walk)
  with no `git status` spawn; sanitize environment and flags across all JS and
  Rust git invocations; keep split-index reads read-only.
- Canonicalize worktree roots and `worktreeOf` paths across platforms; verify
  opened reflog real paths stay under `logs/refs/heads`.
- Sanitize git-derived terminal strings (`ProjectDetails.tsx`) and harden
  `project-details.ts` `.git/HEAD` reads.
- Bound worktree enrichment with a monotonic per-scan deadline and cancellable
  async subprocesses; omit presentation-only worktree fields from native apply
  payloads for compatibility with older engines.
- Record the 2026-11-27 audit ledger in `remaining-work.md` and this index.

### Phase 1 — Release `0.5.3` readiness (`AU03`–`AU10`)

- `@opentui/core` as `optionalDependency` with startup version/export check (D1).
- Production `NODE_ENV` builds for `sweep-ui.js` and standalone binaries;
  deduplicate `sweep.js` and `sweep-lib.js`.
- `prepack` manifest cleanup (strip `devDependencies` and monorepo `scripts`).
- Bundle-vs-manifest external check in `preflight.ts` / release checks.
- Isolated Bun global install PTY smoke gate.
- Fix `idle:30d` placeholder hint and `filterAdvice` in `ProjectsView`.
- Fix landing/docs copy drift (`npx ... ui .`, example arithmetic, stale CLI README).
- Surface native engine fallback reasons and separate runtime capability from
  scan-budget errors.
- Refresh locked transitive dependency advisories (`fast-uri`, `seroval`).
- Fix `config.test.ts` `TMPDIR` isolation and `check-doc-links.ts` directory scope.

### Phase 2 — Install reach (`AU11`–`AU14`)

- Linux `glibc 2.17` floor via `cargo-zigbuild` with ELF symbol gate and
  old-distro container smoke (D2).
- Static `musl` native engine and standalone packages.
- `install.sh` staged binary probe before replacing existing install, `.gz`
  downloads, retries, `v`-prefix handling, and musl detection.
- Windows `install.ps1` and Scoop manifest.
- Homebrew `.gz` downloads and shell completions.
- Restartable release reconciliation after npm publication succeeds.
- Build provenance attestations on GitHub Release binaries and pinned tap updates.
- Remove broken `flake.nix` `packages.default` (D7).

### Phase 3 — Trust and correctness (`AU15`–`AU21`, `AU02` measurement)

- Idle confidence model with bounded nested source checks, direct marker probes,
  and `$HOME` root stop (D4).
- One `"reclaimable"` number (safe + caution, guarded separate) across all views
  with partial-byte qualifiers preserved (D3).
- `sweep status` scan/byte coverage, guarded-only vs empty reporting, exact idle
  threshold, and worktree parity.
- `sweep scan --json-stream` final post-enrichment tiers.
- `sweep apply --plan` confirmation prompt target and dangerous count.
- `.sweeprc` writer permissions (`umask 002`), `sweep doctor` ownership parity,
  and `apply-session.ts` config-dir guidance.
- Expanded tool-home list, macOS-scoped `.app` bundle rule, `--engine js`
  isolation in `gitTrackedPaths`, and `safe.directory` diagnostics.
- Cross-artifact hardlink/reflink store byte inflation awareness (pnpm/Bun).
- Multi-repo/slow-git enrichment measurements under `G2a`.

### Phase 4 — Private security fixes (`AU22`–`AU24`)

- Tracked privately under `D6`.

### Phase 5 — UI consistency (`AU25`, `AU26` a11y/mobile)

- Cross-platform path & `homedir()` normalization, Windows junction fail-closed,
  standalone extraction cache reuse, left-button press-release in `ProjectsView`,
  key-burst state refs, cache teardown, eviction timer `.unref()`,
  completions/`--help` parity, `/proc/self/mountinfo` caching, and landing
  accessibility/320 px fixes.

### Phase 6 — Clove-inspired redesign (`AU26` budget, `AU27`)

- Terminal UI and website Clove-inspired Storage Card and Dot-Grid Canvas
  redesign (D8), CSS token unification, landing initial-load JS budget, `app.tsx`
  decomposition, and `apps/docs` + `scripts/` test coverage.

### Phase 7 — Reach and new features (`AU28`)

- Read-only whole-disk `"where your space goes"` report extending `L3` (D9).
- Additional package channels: `mise`, `aqua`, AUR, and `winget`.
- `.sweeprc` `$schema` support and `config.schema.json`.
- MCP server surface.
- Running-process and cloud-sync advisories.
