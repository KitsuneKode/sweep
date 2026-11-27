Status: in_progress
Scope: repo
Created: 2026-11-27
Updated: 2026-11-27
Commit: uncommitted

# 2026-11-27 Repository Audit Index

This directory captures two independent repository audits of `sweep` at commit
`a5a1c41` plus the owner's uncommitted `feat/worktree-units` changes, together
with the merged phase plan and owner decisions that govern remediation.

- [Codex audit report (`A01`–`A18`)](codex-sol.md)
- [Antigravity audit report (`F01`–`F20`)](antigravity-neon.md)
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

The following items are tracked as **private security advisories** (not public
issues) and scheduled for Phase 4. Do not document exploitation details or
reproduction payloads in public issues, PRs, or changelogs prior to release:

1. **`AU22` — Windows bare executable resolution** (Codex prior #3; Antigravity `F07`):
   Resolve external executables strictly to verified absolute paths across JS
   and Rust subprocess callers, and avoid falling through to `PATH` when
   standalone embedded extraction fails.
2. **`AU23` — Untrusted `.git` / cache file reads and system-subtree guardrails**
   (Antigravity `F03`, `F09`): Harden file opens for untrusted `.git` metadata
   (such as non-blocking / no-symlink-follow bounded reads in Rust `.git/index`
   and cache files) and tighten OS system-subtree guardrails. _(Note: UI
   `.git/HEAD` bounded no-follow reads and terminal branch sanitization landed
   in Phase 0 under `AU01`.)_
3. **`AU24` — `sweep init` check-then-write race** (Codex `A06`; Antigravity `F14`):
   Enforce exclusive creation and staged replacement at the actual file
   operation boundary, aligned with the TUI config writer.

## Phase Plan

### Phase 0 — Land worktree WIP & audit ledger (`AU01`, `AU02` budget) — _this PR_

- Land owner WIP from `feat/worktree-units` as a dedicated first commit.
- Apply D5 worktree labeling fixes: `upstream_gone` never enters "Finished
  worktrees" and labels as `"Tracking branch missing · check git"`; zero-commit
  and dirty worktrees never count as `merged`; verified base required.
- Force `LC_ALL=C` and `LANG=C` in JS (`GIT_ENV`) and Rust (`git_index.rs`) git
  invocations.
- Sanitize git-derived terminal strings (`ProjectDetails.tsx`) and harden
  `project-details.ts` `.git/HEAD` reads (size bound, no symlink following,
  `gitdir:` support).
- Bound worktree git enrichment with a per-scan time budget (Codex `A12`),
  degrading remaining repos to unknown on expiry.
- Record the 2026-11-27 audit in `remaining-work.md` and this index, and remove
  the approved stray folders from the owner's checkout.

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

- Land private fixes for Windows bare executable resolution, untrusted `.git` /
  cache reads + OS system-subtree guardrails, and `sweep init` create/replace
  atomicity (D6).

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
