# Independent Repository Audit — `sweep` (`@kitsunekode/sweep`)

- **Date:** 2026-11-27
- **Repository:** `/home/kitsunekode/Projects/cli-tools/sweep`
- **Branch / HEAD:** `feat/worktree-units` at `a5a1c41` (`origin/main`), plus 16 uncommitted tracked modifications and 4 new uncommitted feature files (W1 worktree units)
- **Published baseline inspected:** `@kitsunekode/sweep@0.5.2` (npm registry + tarball), `@kitsunekode/sweep-engine-*@0.5.2` (5 platform packages), GitHub Releases `v0.5.0`–`v0.5.2`, `KitsuneKode/homebrew-tap` `Formula/sweep.rb`
- **Clove reference inspected:** `.reference/clove-storage-2026-11-18.md`, `.plans/clove-inspired-ux.md`, live `https://clove.kshv.me/` HTML and `/assets/styles-CukaOGK2.css`

---

## 1. Scope and Method

### Read-only static audit

No packages were installed, built, or formatted; no repository files were modified aside from this report. Analysis combined:

- Full reading of project governance and architecture docs (`AGENTS.md`, `.docs/architecture.md`, `.docs/ux-principles.md`, `.docs/product-direction.md`, `.docs/decision-log.md`, `.plans/remaining-work.md`, `.plans/clove-inspired-ux.md`, `.reference/clove-storage-2026-11-18.md`).
- Line-by-line inspection of core JS engine (`packages/core/src/*`), protocol & JSON schemas (`packages/protocol/*`), CLI handlers & entrypoints (`apps/cli/src/*`), bundler & publish scripts (`scripts/*`, `apps/cli/scripts/*`), CI/release workflows (`.github/workflows/*`), packaging (`flake.nix`, `install.sh`, `Formula/sweep.rb`), Rust crates (`crates/sweep-*/src/*`), TUI (`packages/ui/src/*`), landing/docs site (`apps/docs/src/*`), and user documentation (`README.md`, `docs/users/*`, `skills/sweep/SKILL.md`, `SECURITY.md`).
- Inspection of published `0.5.2` npm tarballs under `/tmp/sweep-audit-tgz/` (`tar`, `readelf -V`, `readelf -Ws`, grep), `npm view` metadata for `@kitsunekode/sweep`, `@kitsunekode/sweep-engine-*`, and `@opentui/core@0.6.8`, GitHub Releases API JSON, and live `https://clove.kshv.me/` HTML/CSS.
- Automated static scans for accidental hardcoded credentials/private keys and embedded prompt-injection instructions across `apps/`, `packages/`, `crates/`, `scripts/`, `docs/`, `.docs/`, `.github/`, `.plans/`, `tests/`. **Result:** 0 leaked secrets and 0 embedded prompt-injection instructions found in repository files.

### Uncommitted working tree inventory (audited as part of the tree)

16 tracked files are modified in place for phase W1 (`feat/worktree-units`):

- `crates/sweep-types/src/lib.rs`, `crates/sweep-engine/src/{lib,apply,discovery}.rs`, `crates/sweep-engine/tests/discovery.rs`, `crates/sweep-engine-cli/src/main.rs`
- `packages/protocol/src/index.ts`, `packages/protocol/schemas/{shared,scan-plan}.schema.json`
- `packages/core/package.json`, `packages/core/src/{git-tracked,planner}.ts`
- `packages/ui/src/{projects,projects.test}.ts`
- `docs/users/terminal-ui.md`, `tests/support/normalize-plan.ts`

New untracked feature files:

- `packages/core/src/worktree-info.ts`, `packages/core/src/worktree-info.test.ts`, `.changeset/finished-worktrees.md`, `.plans/clove-inspired-ux.md`, `.reference/clove-storage-2026-11-18.md`.

**Working-tree hygiene note:** Five stray untracked directories (`$HOME/`, `"$HOME/`, `HOME/`, `~/`, `.grok_personal/`) exist at the repo root (dated Nov 13, likely from another local agent tool). They are untracked and outside repo source, but should be removed before any local packaging or `git add -A`.

### Ledger deduplication

Items already tracked in `.plans/remaining-work.md` (`S1`–`S3`, `G1`–`G9`, `L1`–`L4`) are not re-reported as standalone findings; where this audit uncovers a distinct mechanism, regression, or missing edge case inside one of those gates, the ledger ID is cited explicitly. Earlier-audit items `(1)`–`(11)` are independently verified and extended in Section 3.9.

---

## 2. Vetted Findings Table (Ordered by Leverage)

| ID      | Category                       | Summary                                                                                                                                                                                                                                                                                                     | Impact       | Effort | Fix Risk | Confidence | Primary Evidence                                                                                                                                                                                                     |
| ------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------ | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F01** | Packaging / Distribution       | Moving `@opentui/core: ^0.6.8` to hard `dependencies` pulls `engines.node >= 26.4.0` + ~18 MiB + Zig native binaries onto every Node 20/22/24 `npm i -g` / `npx` user                                                                                                                                       | **Critical** | M      | Med      | HIGH       | `apps/cli/package.json:68,85-87`; `npm view @opentui/core@0.6.8`                                                                                                                                                     |
| **F02** | Packaging / Security / UX      | No runtime export/version verification for `@opentui/core` and no release-time manifest-vs-bundle external check (extends #11); plus `sweep doctor` false-warns `opentui` in standalone binaries                                                                                                            | **High**     | S      | Low      | HIGH       | `apps/cli/src/handlers/shared.ts:313-346`; `apps/cli/src/handlers/doctor.ts:71,157-162`; `apps/cli/scripts/preflight.ts:232-238`                                                                                     |
| **F03** | Security / Guardrails          | Deep system trees (`C:\Windows\System32`, `/etc/*`, `/sys/*`, `/dev/*`, `/proc/sys`, `/boot/*`) pass `assertSafeCwd` AND are absent from `SYSTEM_TOOL_DIRS` in both JS and Rust                                                                                                                             | **High**     | S      | Low      | HIGH       | `packages/core/src/guardrails.ts:109-152,268-291`; `packages/core/src/classification.ts:54-70`; `crates/sweep-engine/src/{guardrails.rs:275-323,classify.rs:39-55}`                                                  |
| **F04** | Performance / Bundle           | Production `sweep-ui.js` (1.58 MiB) and standalone binaries bundle **React DEV mode** (`377 jsxDEV`, `66 runWithFiberInDEV`) and `sweep.js` + `sweep-lib.js` duplicate the entire 475 KB CLI bundle                                                                                                         | **High**     | S      | Low      | HIGH       | `scripts/bundle.ts:16-19,60-114`; published `sweep-0.5.2.tgz` `dist/sweep-ui.js`                                                                                                                                     |
| **F05** | Packaging / Distribution       | Published `@kitsunekode/sweep@0.5.2` ships unresolved `workspace:*` & `catalog:` in `devDependencies` and monorepo-relative `scripts` because `prepack.ts` never strips them                                                                                                                                | **High**     | S      | Low      | HIGH       | `apps/cli/scripts/prepack.ts:97-110,141-154`; published `sweep-0.5.2.tgz` `package.json`                                                                                                                             |
| **F06** | Correctness / Uncommitted (W1) | `worktree-info.ts` misclassifies brand-new 0-commit worktrees (including ones with uncommitted WIP) as `merged`, and `upstream_gone` breaks on non-English locales (`LC_ALL=C` missing in `GIT_ENV`)                                                                                                        | **High**     | S      | Low      | HIGH       | `packages/core/src/worktree-info.ts:43-52,141,154-164`; `packages/core/src/git-tracked.ts:24-30`                                                                                                                     |
| **F07** | Security / Windows             | Bare executable spawns extend beyond `sweep-engine`/`node` (#3) to `git` (JS + Rust + uncommitted `worktree-info.ts`) and `bun` (`ui.ts`); `isRustEngineAvailable` validates PATH file then spawns bare cwd-first binary                                                                                    | **High**     | M      | Low      | HIGH       | `packages/core/src/rust-engine.ts:227,518,713-738`; `packages/core/src/git-tracked.ts:108`; `packages/core/src/worktree-info.ts:44`; `crates/sweep-engine/src/git_index.rs:387`; `apps/cli/src/handlers/ui.ts:42,64` |
| **F08** | Correctness / Idle             | `ProjectActivityIndex` truncates unsorted `readdirSync(dir).slice(0, 256)` (can miss `.git`/manifests/recent files in large roots), only stats top-level entries (nested `src/` edits look idle), and `projectRoot()` never stops at `HOME`                                                                 | **High**     | M      | Med      | HIGH       | `packages/core/src/project-activity.ts:153,168,177-216`                                                                                                                                                              |
| **F09** | Security / DoS (Rust & TUI)    | Unbounded/blocking file reads on untrusted repos: Rust `git_index.rs` opens `.git/index` without `O_NOFOLLOW`/`O_NONBLOCK` (FIFO hangs 60 s), and TUI `project-details.ts:gitBranch` follows symlinks & reads `.git/HEAD` unbounded + breaks on Windows `gitdir:` + injects unsanitized branch names        | **High**     | S      | Low      | HIGH       | `crates/sweep-engine/src/git_index.rs:180-193`; `packages/ui/src/project-details.ts:79-94`; `packages/ui/src/ProjectDetails.tsx:117`                                                                                 |
| **F10** | UX / Correctness (TUI)         | `ProjectsView` search placeholder advertises `idle:30d`, which is NOT a supported filter key (`FILTER_KEYS` only has `older:`/`newer:`), causing literal zero-match searches; `ProjectsView` also omits `filterAdvice`                                                                                      | **High**     | S      | Low      | HIGH       | `packages/ui/src/ProjectsView.tsx:563`; `packages/ui/src/filter-query.ts:44,180-182`                                                                                                                                 |
| **F11** | UX / Docs / Landing            | Landing page hero copy box tells visitors to run `npx @kitsunekode/sweep ui .`, which fails on Node-only machines (requires Bun); `docs/users/configuration.md` & `apps/cli/README.md` drift from live CLI                                                                                                  | **High**     | S      | Low      | HIGH       | `apps/docs/src/components/landing/landing.tsx:209`; `apps/cli/src/handlers/ui.ts:55-61`; `apps/cli/README.md` vs `README.md`                                                                                         |
| **F12** | Packaging / Distribution       | Root cause of GLIBC 2.39 (#1) confirmed as Rust 1.99 weak `pidfd_spawnp`/`pidfd_getpid` symbols in `DT_VERNEED` from `ubuntu-24.04`; silent fallback hides the real error; `install.sh` and Homebrew download 80–104 MiB uncompressed binaries despite `.gz` assets already published                       | **High**     | M      | Med      | HIGH       | `readelf -Ws` on `sweep-engine-linux-64@0.5.2`; `.github/workflows/native-engine-release.yml:37-44`; `install.sh:32-46`; `Formula/sweep.rb`                                                                          |
| **F13** | Correctness / Safety           | `sweep apply --plan` interactive prompt omits `plan.targetDir` and dangerous count; `sweep scan --json-stream` emits pre-enrichment candidates where git-tracked items still claim `riskTier: "safe"` and `selectedByDefault: true`                                                                         | **High**     | S      | Low      | HIGH       | `apps/cli/src/handlers/apply.ts:106-117`; `apps/cli/src/handlers/scan.ts:64-71`                                                                                                                                      |
| **F14** | Security / Correctness         | `sweep doctor` (`validateProjectConfigFile`) skips `requireOwned` permission check so it reports `ok` on a group-writable `.sweeprc` that `sweep` refuses (extends #2); `apply-session.ts` refuses existing `0775` `~/.config/sweep` dir                                                                    | **Med**      | S      | Low      | HIGH       | `packages/core/src/config.ts:122,206,271,331`; `packages/core/src/apply-session.ts:25-36`                                                                                                                            |
| **F15** | Correctness / Platform         | Windows & cross-platform breaks: `isReparsePointOrSymlink` fails open (`false`) on broken junctions; `ProjectsView` hardcodes `/` when stripping `project.key`; `ProjectDetails`/`app.tsx` read `process.env.HOME` instead of `homedir()`; standalone leaks 1.4 MiB/run in `%TEMP%` on Windows (extends G6) | **Med**      | S      | Low      | HIGH       | `packages/core/src/guardrails.ts:443-453`; `packages/ui/src/ProjectsView.tsx:466`; `packages/ui/src/ProjectDetails.tsx:49-52`; `apps/cli/src/bin-standalone.ts:44-60`                                                |
| **F16** | Correctness / UX (TUI)         | `ProjectsView` fires row queue toggle on `onMouseDown` without checking left button or press-release (violates `ux-principles.md` §6); `app.tsx` `handleProjectKey` reads stale `expandedProjects` state in key bursts; `project-details.ts` caches leak across rescans/switches                            | **Med**      | S      | Low      | HIGH       | `packages/ui/src/ProjectsView.tsx:610-612`; `packages/ui/src/app.tsx:1586`; `packages/ui/src/project-details.ts:29,134`                                                                                              |
| **F17** | Correctness / Engine           | `gitTrackedPaths()` spawns Rust `sweep-engine tracked` even when user explicitly selects `--engine js`; `git ls-files` silently treats `safe.directory` (exit 128) repos as untracked; `isInsideToolHome` flags any `*.app` project folder (e.g. `acme.app/`) as a macOS app bundle on all OSes             | **Med**      | S      | Low      | HIGH       | `packages/core/src/git-tracked.ts:66-75,118`; `packages/core/src/classification.ts:100`; `crates/sweep-engine/src/classify.rs:105`                                                                                   |
| **F18** | Security / CI / Release        | GitHub Release binaries lack SLSA provenance attestations; `cli-binaries.yml` executes unpinned `bin/update-formula` from external `homebrew-tap` `main` with write PAT; `preflight.ts` ignores uncommitted changes in `crates/`, `native-packages/`, `scripts/`; `doctor --json` skips `drainStdout()`     | **Med**      | M      | Low      | HIGH       | `.github/workflows/cli-binaries.yml:175-217`; `apps/cli/scripts/preflight.ts:254-261`; `apps/cli/src/handlers/doctor.ts:191-203`                                                                                     |
| **F19** | Correctness / DX               | `completions.ts` misses `--allow-dangerous` in `ROOT_ACTION_OPTIONS` and misses `--view`/`--theme` values; `sweep init --help` & `sweep ui --help` hide `--dry-run`; `size-cache.ts` lacks dir ownership & `O_NONBLOCK`; `cleaner.ts` re-reads `/proc/self/mountinfo` per candidate                         | **Med**      | S      | Low      | HIGH       | `apps/cli/src/handlers/completions.ts:18-29,174-194`; `apps/cli/src/cli.ts:235-252,349-357`; `packages/ui/src/size-cache.ts:56-65`; `packages/core/src/cleaner.ts:473`                                               |
| **F20** | Architecture / Tech Debt       | `packages/ui/src/app.tsx` is 3,458 LOC (extends G1); `apps/docs` has 10,613 source LOC with only 1 test file (95 LOC, 0.01 ratio); `scripts/` has 3,257 LOC with 0 unit tests; `apps/docs/src/landing.css` is 2,115 LOC with palette/token divergence from `styles.css` & `theme.css`                       | **Med**      | L      | Med      | HIGH       | Static metrics (§4); `packages/ui/src/app.tsx`; `apps/docs/src/{styles.css,theme.css,landing.css}`                                                                                                                   |

---

## 3. Detailed Findings by Discipline

### 3.1 Correctness Bugs

#### F06 — Uncommitted W1 (`worktree-info.ts`): false-positive `merged` on 0-commit worktrees & locale-broken `upstream_gone`

- **Evidence:** `packages/core/src/worktree-info.ts:141,154-164` (uncommitted); `packages/core/src/git-tracked.ts:24-30` (uncommitted export).
- **Detail:**
  1. `git for-each-ref --merged=${baseRef} --format=%(refname) refs/heads` matches every branch whose tip is an ancestor of `baseRef`. A newly created worktree (`git worktree add -b feat/wip .worktrees/wip main`) starts at `main`'s commit; if the developer or agent edits files without committing for 24 hours (`FINISHED_QUIET_MS = 86_400_000` in `packages/ui/src/projects.ts:26`), `worktreeState` reports `"merged"` and promotes the worktree into **Finished worktrees** despite having zero merged commits and potentially uncommitted work.
  2. Line 141 tests `if (track === "[gone]")`, but `GIT_ENV` (`git-tracked.ts:24-30`) inherits `LANG`/`LC_ALL` without forcing `LC_ALL: "C"`. On non-English systems (`de_DE`, `fr_FR`, `ja_JP`, etc.), `%(upstream:track)` emits localized strings (`[entfernt]`, `[disparue]`), so `upstream_gone` silently never triggers.
  3. Lines 146–148 fall back to local `main`/`master` when `refs/remotes/origin/HEAD` is unset, ignoring repos whose default branch is `develop`/`trunk` or whose remote isn't named `origin` (checking the main worktree's `HEAD` ref when `origin/HEAD` is absent handles custom default branches).
- **Impact:** Misleads users into clearing build artifacts (and in future W3, targeting worktree removal) on brand-new uncommitted worktrees, and disables squash-merge detection for non-English locales.
- **Effort:** S | **Fix Risk:** Low | **Confidence:** HIGH
- **Fix sketch:** Add `LC_ALL: "C"` to `GIT_ENV`. For `merged`, exclude branches whose commit OID equals `baseRef`'s commit OID unless the branch has a merge commit or reflog/history proving it diverged and merged (or at minimum check `git rev-parse` of `baseRef` vs branch tip and exclude branches equal to `baseRef` when the worktree's commit matches its creation point; alternatively label `at base` separately from `merged`). Fall back to main worktree `HEAD` before guessing `main`/`master`.

#### F08 — `ProjectActivityIndex` truncates unsorted `readdirSync`, misses nested edits, and climbs into `$HOME`

- **Evidence:** `packages/core/src/project-activity.ts:153,168,177-198,209-216`.
- **Detail:**
  1. `list()` executes `readdirSync(dir).slice(0, MAX_ROOT_ENTRIES)` (`256`). Filesystem `readdir` order is hash/inode order, not sorted. In any directory with >256 entries, `.git`, `package.json`, or recently touched files can land past index 256 and be silently dropped—causing `workTree()` to miss the repo root and `projectActivity()` to misreport an active project as idle.
  2. `workTree()` stops at `dir === HOME` (line 153), but `projectRoot()` (lines 177–198) does **not** stop at `HOME`. A stray `~/Makefile` or `~/package.json` attributes every non-git subfolder under `~` to `~` as its project root.
  3. `projectActivity()` only stats direct children of `root` plus `.git/{index,logs/HEAD,HEAD,FETCH_HEAD}`. Editing nested files (`src/components/Foo.tsx`) does not update the top-level `src/` directory's mtime on POSIX or NTFS; in non-git projects or long uncommitted branches, active work reads as idle past 30 days—contradicting `README.md:39` ("from its git history and its own files").
- **Impact:** `sweep --idle 30d` and TUI `i` (queue idle) can misclassify active projects as idle and queue their live build outputs.
- **Effort:** M | **Fix Risk:** Med | **Confidence:** HIGH
- **Fix sketch:** Probe `.git` and `PROJECT_MARKERS` directly via `existsSync`/`lstatSync` instead of relying on a 256-entry `readdirSync` slice; stop `projectRoot()` at `HOME`; sample a bounded depth-2/3 mtime probe under `src/`/`app/`/`packages/` (or document explicitly that idle detection reflects root entries + git index/reflog).

#### F10 — `ProjectsView` filter placeholder advertises nonexistent `idle:30d` operator

- **Evidence:** `packages/ui/src/ProjectsView.tsx:563`; `packages/ui/src/filter-query.ts:44,180-182`.
- **Detail:** `ProjectsView` sets `<input placeholder="project, kind:target, >100MiB, idle:30d" />`, but `FILTER_KEYS` only implements `["kind", "risk", "path", "is", "older", "newer"]`. Typing `idle:30d` falls back to literal substring search (`plainPredicate`), yielding zero matches, and `ProjectsView` does not render `filterAdvice()`.
- **Impact:** Users following the UI's own hint get an empty screen with no explanation.
- **Effort:** S | **Fix Risk:** Low | **Confidence:** HIGH
- **Fix sketch:** Either alias `idle:` to `older:` in `filter-query.ts` (matching the CLI `--idle` vocabulary) or change the placeholder to `older:30d`, and render `filterAdvice(filter)` below the `ProjectsView` search input.

#### F13 — `sweep apply --plan` hides target/risk in prompt; `sweep scan --json-stream` leaks pre-enrichment `safe` tiers for git-tracked files

- **Evidence:** `apps/cli/src/handlers/apply.ts:106-117` vs `apps/cli/src/handlers/shared.ts:533-572`; `apps/cli/src/handlers/scan.ts:64-71`.
- **Detail:**
  1. Interactive `sweep apply --plan foo.json` asks `Apply plan with 4 items (~2.1 GiB)?`—omitting `plan.targetDir`, its canonical target, and the dangerous item count, unlike `confirmPlanDeletion()` used by `sweep clean`.
  2. `sweep scan --json-stream` emits `toCandidate(entry)` per entry and never runs `applyPlanInsights` (`blockGitTracked`, `enrichCandidates`, `withProjectActivity`) on streamed events. A git-tracked `node_modules` or workspace stub is emitted as `riskTier: "safe", selectedByDefault: true` in `--json-stream` while `sweep scan --json` marks it `blocked` / unselected.
- **Impact:** Users approving a saved plan don't see which directory they're modifying; scripts parsing `--json-stream` get different risk classifications than `--json`.
- **Effort:** S | **Fix Risk:** Low | **Confidence:** HIGH
- **Fix sketch:** Reuse `confirmPlanDeletion()` in `handleApply`. Document in `docs/users/automation.md` and `scan-event.schema.json` that streamed `candidate_found`/`candidate_updated` tiers are provisional prior to post-scan git-tracked/workspace-stub enrichment (or emit final enrichment updates before `scan_completed`).

#### F15 — Cross-platform / Windows path & symlink bugs

- **Evidence:** `packages/core/src/guardrails.ts:443-453`; `packages/ui/src/ProjectsView.tsx:466`; `packages/ui/src/ProjectDetails.tsx:49-52`; `packages/ui/src/app.tsx:869-874`; `apps/cli/src/bin-standalone.ts:44-60`.
- **Detail:**
  1. `isReparsePointOrSymlink()` catches `realpathSync` errors on Windows and returns **`false`** (fail-open), misclassifying broken/inaccessible NTFS junctions as normal directories.
  2. `ProjectsView.tsx:466` checks `c.path.startsWith(`${row.project.key}/`)` with hardcoded `/`, breaking subfolder display for opened projects on Windows (`\`).
  3. `ProjectDetails.tsx:49-52` and `app.tsx:869-874` use `process.env.HOME` and `/` instead of `homedir()` + `sep`, breaking `~` home-path display on Windows (even though `LedgerBand.tsx:59` imports `homedir()`, though it also hardcodes `${home}/`).
  4. `bin-standalone.ts:44-60` extracts a fresh 1.4 MiB `sweep-engine.exe` into `%TEMP%\sweep-native-*` on every invocation and ignores `rmSync` failure on Windows (where OS file locks often outlive child exit briefly), leaking 1.4 MiB/run indefinitely (extends G6).
- **Impact:** Degraded Windows safety (broken junctions) and UX, plus unbounded `%TEMP%` growth for Windows standalone users.
- **Effort:** S | **Fix Risk:** Low | **Confidence:** HIGH
- **Fix sketch:** On Windows `realpathSync` failure in `isReparsePointOrSymlink()`, fail closed (`true`) or check `FILE_ATTRIBUTE_REPARSE_POINT`; use `path.relative()` + `homedir()`/`sep` in UI helpers; cache standalone extracted engine by content SHA-256 in a deterministic user cache dir (validated by ownership + hash before exec) instead of extracting per run.

#### F16 — TUI mouse-button violation, key-burst stale closure, and session cache leaks

- **Evidence:** `packages/ui/src/ProjectsView.tsx:610-612`; `packages/ui/src/app.tsx:1493,1500,1586`; `packages/ui/src/project-details.ts:29,134`; `packages/ui/src/meter-draw.ts:331`.
- **Detail:**
  1. `ProjectsView.tsx:610` binds `onMouseDown={(event) => props.onRowPress(...)}` without checking `event.button === 0` or press-and-release, violating `.docs/ux-principles.md:139` ("Right/middle clicks and drags cannot activate queue controls. Buttons require a left press and release over the same control.").
  2. `app.tsx:1586` checks `!expandedProjects.has(row.project.key)` (React render closure) instead of `!expandedRef.current.has(row.project.key)` during a key burst, while `openSections` and `allArtifacts` lack refs entirely (`lines 1493, 1500`).
  3. `rebuildCache` and `branchCache` in `project-details.ts` are unbounded module-level `Map`s never cleared on rescan, folder switch (`Ctrl+O`), or session teardown (violating `.docs/ux-principles.md:215`).
  4. `meter-draw.ts:331` schedules `setTimeout(() => oldest.dispose(), 1_000)` without `.unref()`, delaying clean process exit by up to 1 s after cache eviction.
- **Impact:** Accidental right-click queueing in the default view, erratic double-Enter bursts, stale branch/lockfile display after switching folders, and 1 s exit stalls.
- **Effort:** S | **Fix Risk:** Low | **Confidence:** HIGH
- **Fix sketch:** Gate `ProjectsView` clicks on left-button press+release (matching `ArtifactList`); read `expandedRef.current` (and add refs for `openSections`/`allArtifacts`); export `clearProjectDetailsCaches()` and call on rescan/switch/teardown; call `.unref()` on the eviction timer.

#### F17 — Engine isolation leak in `gitTrackedPaths`, silent `safe.directory` bypass, and `*.app` false positives

- **Evidence:** `packages/core/src/git-tracked.ts:66-75,118`; `packages/core/src/classification.ts:100`; `crates/sweep-engine/src/classify.rs:105`.
- **Detail:**
  1. `applyPlanInsights()` calls `gitTrackedPaths()`, which unconditionally calls `gitTrackedPathsViaEngine()` first—spawning the Rust `sweep-engine` even when the user explicitly passed `--engine js`.
  2. In `gitTrackedPathsViaGit()` (`line 118`), any non-zero exit from `git ls-files` (such as exit 128 from Git's `safe.directory` dubious-ownership check in containers/shared trees) is silently treated as "untracked", removing git-tracked protection for the whole repo with zero warning.
  3. `isInsideToolHome` checks `segments.some((s) => s.endsWith(".app"))` on all platforms, demoting every artifact inside a legitimately named project folder like `~/Projects/acme.app/` or `~/Projects/web.app/` to `dangerous` (`tool-home`).
- **Impact:** Violates `--engine js` isolation; silently drops git-tracked safety on dubious-ownership repos; false-positives on `.app` domain project folders.
- **Effort:** S | **Fix Risk:** Low | **Confidence:** HIGH
- **Fix sketch:** Pass `engine` into `applyPlanInsights`/`blockGitTracked` so `--engine js` skips the native binary; pass `-c safe.directory=*` (safe because `core.fsmonitor=false` and read-only `ls-files --cached`) or surface a warning when git exits 128; restrict `.app` bundle detection to segments followed by `Contents` (or macOS bundle layout).

---

### 3.2 Security Vulnerabilities & Threat Model Gaps

#### F03 — System-root guardrails and `SYSTEM_TOOL_DIRS` miss `C:\Windows\System32` and two-segment Unix OS trees

- **Evidence:** `packages/core/src/guardrails.ts:109-152,268-291`; `packages/core/src/classification.ts:54-70`; `crates/sweep-engine/src/guardrails.rs:275-323`; `crates/sweep-engine/src/classify.rs:39-55`.
- **Detail:** `BLOCKED_ROOTS` blocks exact 1-segment roots (`/etc`, `/sys`, `/proc`, `/dev`, `/boot`, `/bin`, `/sbin`, `/lib`, `/lib64`, `C:\Windows`), and the depth check requires `>= 2` segments. Consequently, **all 2+ segment paths inside OS-owned trees pass `assertSafeCwd`**, including:
  - Windows: `C:\Windows\System32`, `C:\Windows\WinSxS`, `C:\Program Files\Common Files` — AND `Windows` is **not even in `SYSTEM_TOOL_DIRS`**, so `isInsideToolHome("C:\\Windows\\System32\\target")` returns `false`!
  - Linux/macOS: `/etc/systemd`, `/etc/ssh`, `/sys/class`, `/dev/disk`, `/proc/sys`, `/boot/grub`, `/usr/bin`, `/var/log`. None of `etc`, `sys`, `proc`, `dev`, `boot`, `bin`, `sbin`, `lib`, `lib64`, `run` appear in `SYSTEM_TOOL_DIRS`.
  - Additionally, Windows verbatim paths (`\\?\C:\Windows`) are stripped on `canonical` but not on `resolved` in `guardrails.rs:161-162` and not at all in `guardrails.ts:303`.
- **Impact:** A mistaken path or agent command targeting `C:\Windows\System32` or `/etc/nginx` with a custom pattern bypasses target-root refusal, and on Windows bypasses tool-home demotion as well.
- **Effort:** S | **Fix Risk:** Low | **Confidence:** HIGH
- **Fix sketch:** Treat kernel/OS prefixes (`/etc`, `/sys`, `/proc`, `/dev`, `/boot`, `/bin`, `/sbin`, `/lib`, `/lib64`, `C:\Windows`) as **prefix-blocked** target roots in both JS and Rust `assertSafeCwd` (not just exact-match), add `Windows` and Unix OS prefixes to `SYSTEM_TOOL_DIRS`, and normalize `\\?\` before lexical checks on Windows.

#### F07 — Bare executable spawns on Windows (`git`, `bun`, `sweep-engine`, `node`) — extends #3

- **Evidence:** `packages/core/src/rust-engine.ts:227,518,713-738`; `packages/core/src/git-tracked.ts:108`; `packages/core/src/worktree-info.ts:44` (uncommitted); `crates/sweep-engine/src/git_index.rs:387`; `apps/cli/src/handlers/ui.ts:42,64`; `packages/core/src/directory-reader.ts:74`.
- **Detail:** On Windows, `CreateProcessW` resolves unqualified executable names against the **process's current working directory before `PATH`**. Running `sweep` inside an untrusted cloned repository containing a planted `git.exe`, `node.exe`, `bun.exe`, or `sweep-engine.exe` achieves **arbitrary code execution on read-only `sweep scan`**. Notably:
  - `rust-engine.ts:716-719` explicitly searches `PATH` to compute `file` for stat caching, **and then discards `file`** and passes bare `"sweep-engine"` to `spawnSync(binary, ...)` on line 733 (and `spawn(binary, ...)` on line 227)!
  - Uncommitted `worktree-info.ts:44` introduces yet another bare `spawnSync("git", ...)`.
  - `rust-engine.ts:130-137` falls through from a failed standalone embedded-engine extraction to bare `"sweep-engine"` on PATH/cwd instead of failing closed.
- **Impact:** Arbitrary code execution on Windows when scanning an untrusted repository directory.
- **Effort:** M | **Fix Risk:** Low | **Confidence:** HIGH
- **Fix sketch:** Introduce a shared `resolvePathExecutable(name)` helper (both JS and Rust) that resolves an absolute path strictly from `PATH` directories (never `.` or empty `PATH` entries) and passes that absolute path to `spawn`/`Command::new`. In standalone binaries, never fall through to `PATH` when embedded extraction fails.

#### F09 — Blocking/unbounded reads & terminal escape injection from untrusted `.git` metadata

- **Evidence:** `crates/sweep-engine/src/git_index.rs:180-193`; `packages/ui/src/project-details.ts:79-94`; `packages/ui/src/ProjectDetails.tsx:117`; `packages/ui/src/size-cache.ts:62-65`.
- **Detail:**
  1. `git_index.rs:180` opens `.git/index` with `std::fs::File::open(&path)` (no `O_NOFOLLOW`, no `O_NONBLOCK`). A planted FIFO at `.git/index` blocks the Rust worker thread until `git-tracked.ts:77`'s 60 s `SIGKILL` timeout, breaking git-tracked detection for all repos in the scan.
  2. `project-details.ts:79-94` (`gitBranch`) uses `statSync` (follows symlinks) and unbounded `readFileSync` on `.git` and `.git/HEAD` on every newly focused project in `ProjectsView`. A FIFO or huge file hangs/OOMs the TUI.
  3. `ProjectDetails.tsx:117` renders `facts.branch` directly without `sanitizeTerminalText()`, allowing a maliciously named git branch (`ref: refs/heads/\x1b]52;...`) to inject raw terminal escape sequences (violating `.docs/architecture.md:331-339`).
  4. `size-cache.ts:62-65` opens `size-cache.json` without `O_NONBLOCK` and without checking parent dir ownership (unlike `view-preferences.ts`).
- **Impact:** Local DoS (hang/OOM) and terminal escape injection when inspecting an untrusted repository.
- **Effort:** S | **Fix Risk:** Low | **Confidence:** HIGH
- **Fix sketch:** Open `.git/index` with `O_NOFOLLOW | O_NONBLOCK` + `fstat` regular-file check in Rust; cap `.git`/`HEAD` reads in `project-details.ts` using `lstatSync` + 4 KiB bound (matching `worktree-info.ts:54-62`) and `isAbsolute()` for Windows `gitdir:`; wrap `facts.branch` in `sanitizeTerminalText()`; align `size-cache.ts` with `view-preferences.ts`.

#### F14 — Config ownership/mode check inconsistencies (`sweep doctor` vs `sweep`, `apply-session.ts` vs existing `~/.config/sweep`)

- **Evidence:** `packages/core/src/config.ts:122,206,271,331`; `packages/core/src/apply-session.ts:25-36`.
- **Detail:**
  1. Extending #2: `writeInitSweeprc` (`config.ts:271`) writes with default mode (`0o664` under Debian/Ubuntu/Fedora default `umask 002`) and non-atomically (TOCTOU symlink window between `lstatSync` and `writeFileSync`). Meanwhile `writeProjectSweeprc` (`line 331`) preserves existing group-writable bits (`stat.mode & 0o777`).
  2. `validateProjectConfigFile()` (`config.ts:206`, called by `sweep doctor`) calls `readConfigText(configPath)` with `requireOwned = false`, so `sweep doctor` reports `ok config` for a group-writable `.sweeprc` that `sweep` immediately refuses with exit 3!
  3. `apply-session.ts:26-34` (`privateDirectory`) runs `mkdirSync(path, { recursive: true, mode: 0o700 })` then rejects `(meta.mode & 0o022) !== 0`. If `$XDG_CONFIG_HOME/sweep` already existed with `0o775` (created under `umask 002`), `mkdirSync` does not tighten mode and **every apply fails with `Unsafe apply journal directory`**.
- **Impact:** Breaks `sweep init` → `sweep` out of the box on `umask 002` Linux distros, and gives contradictory diagnostics in `sweep doctor`.
- **Effort:** S | **Fix Risk:** Low | **Confidence:** HIGH
- **Fix sketch:** Write `.sweeprc` atomically with `0o600` (or `0o644` masked by `~0o022`) in both `writeInitSweeprc` and `writeProjectSweeprc`; pass `requireOwned = true` in `validateProjectConfigFile` when validating auto-discovered configs; report a clear `chmod 700 <dir>` remediation in `privateDirectory` (and check config-dir mode in `sweep doctor`, extending G6).

---

### 3.3 Packaging, Distribution & Installation (Every Platform)

#### F01 — Hard `@opentui/core: ^0.6.8` dependency breaks Node 20/22/24 engine contract and bloats `npx`

- **Evidence:** `apps/cli/package.json:68,85-87`; `npm view @opentui/core@0.6.8` output:
  ```json
  "engines": { "bun": ">=1.3.14", "node": ">=26.4.0" },
  "dist.unpackedSize": 17693900
  ```
- **Detail:** Moving `@opentui/core` from optional `peerDependencies` to hard `dependencies` fixed the Bun global resolution bug (#11), **but introduced a regression for every Node.js user**:
  - `@kitsunekode/sweep` advertises `"engines": { "node": ">=20.3.0" }`, yet its hard dependency `@opentui/core@0.6.8` requires `"node": ">=26.4.0"`! Every `npm install -g @kitsunekode/sweep` or `npx @kitsunekode/sweep --dry-run` on Node 20/22/24 triggers `EBADENGINE` warnings (or hard failures under `engine-strict=true`, pnpm, or yarn).
  - Headless `npx @kitsunekode/sweep --dry-run` now downloads **17.7 MiB** of `@opentui/core` plus its platform native Zig package (`@opentui/core-<os>-<arch>`) even though Node cannot run `sweep ui` without Bun.
  - `scripts/smoke-package.ts:62` passes `--omit=optional` and runs against Node 26/CI without checking `EBADENGINE` on Node 20/22/24, so CI never caught this.
- **Impact:** Degrades the flagship zero-install command (`npx @kitsunekode/sweep --dry-run ~/Projects`) and breaks strict-engine Node installs.
- **Effort:** M | **Fix Risk:** Med | **Confidence:** HIGH
- **Fix sketch:** Either (a) keep `@opentui/core` in `optionalDependencies` with an exact/tight range (`0.6.8`) plus startup export/version verification (so Bun/npm install it automatically when compatible without failing Node 20–24 `engine-strict`), or (b) split the Bun/OpenTUI UI into a thin optional package `@kitsunekode/sweep-ui` pinned to exact `@opentui/core` version, and add a CI smoke job on Node 20 LTS + Bun global install.

#### F02 — Preventing recurrence of #11 (`@opentui/core` mismatch) & `sweep doctor` false warning in standalone

- **Evidence:** `apps/cli/src/handlers/shared.ts:313-346`; `apps/cli/src/handlers/ui.ts:123-137,204`; `apps/cli/src/handlers/doctor.ts:71,157-162`; `apps/cli/scripts/preflight.ts:232-238`.
- **Detail:**
  1. `isOpenTuiAvailable()` only calls `resolve("@opentui/core")`. If an older incompatible copy (e.g. `0.1.97` from another global tool) is resolved first, `assertOpenTuiAvailable()` passes and `loadSweepUi()` crashes with raw `SyntaxError: Export named 'ImageRenderable' not found`.
  2. `preflight.ts:232-238` only checks that `peerDependencies` don't contain `"catalog:"`—it never parses `dist/sweep-ui.js`'s external import specifiers and verifies they exist in the declared `@opentui/core` version range.
  3. `doctor.ts:71` calls `isOpenTuiAvailable()` unconditionally, ignoring `registeredUiModule` (set by `bin-standalone.ts:23`). Inside standalone binaries (Homebrew / `install.sh`), `sweep doctor` falsely reports `warn opentui` and exits `5`!
- **Impact:** Recurring cryptic runtime crashes on global Bun installs with peer conflicts; broken `sweep doctor` exit code on all standalone installs.
- **Effort:** S | **Fix Risk:** Low | **Confidence:** HIGH
- **Fix sketch:**
  1. In `shared.ts`, dynamically `import("@opentui/core")` and verify required exports (`ImageRenderable`, `SliderRenderable`, `createCliRenderer`, `StyledText`, `NativeImage`) and resolved `package.json` major/minor compatibility (`>=0.6.0`), failing with a clear version-mismatch diagnostic naming the offending path and remediation.
  2. In `preflight.ts` / `publish-release.ts`, extract all named imports from `"@opentui/core"` in `dist/sweep-ui.js` and assert every symbol exists on the installed `@opentui/core` and that the manifest's declared range satisfies the built version.
  3. Add a `smoke-package.ts` test that pre-installs a stub/older `@opentui/core` in a shared parent `node_modules` and verifies `sweep ui` either resolves its own copy or produces the friendly version-mismatch error.
  4. Export `hasRegisteredUiModule()` from `ui.ts` and check it in `doctor.ts` before `isOpenTuiAvailable()`.

#### F05 — Published `package.json` ships unresolved `workspace:*` & `catalog:` in `devDependencies` and monorepo `scripts`

- **Evidence:** `apps/cli/scripts/prepack.ts:97-110,141-154`; extracted `/tmp/sweep-audit-tgz/sweep-0.5.2.tgz` `package/package.json`.
- **Detail:** `prepack.ts` only cleans `dependencies`, `optionalDependencies`, and `peerDependencies`. The published `@kitsunekode/sweep@0.5.2` tarball still contains `"devDependencies": { "@kitsunekode/sweep-typescript-config": "workspace:*", "oxlint": "catalog:", ... }` and monorepo `scripts` (`prepack`, `postpack`, `prepublishOnly`, `oxlint -c ../../.oxlintrc.json`). Tools that inspect or audit published manifests (Dependabot, Socket, `npm-check`, Nix `buildNpmPackage`, Yarn Berry) choke on `workspace:*`/`catalog:` even in `devDependencies`.
- **Impact:** Breaks downstream packaging/SCA tools and ships broken lifecycle scripts inside the published tarball.
- **Effort:** S | **Fix Risk:** Low | **Confidence:** HIGH
- **Fix sketch:** Delete `manifest.devDependencies` and `manifest.scripts` in `prepack.ts` (keeping `postpack` restore intact), and extend `assertPublishable()` to reject `workspace:`/`catalog:` anywhere in the serialized manifest.

#### F12 — Platform distribution gaps: GLIBC 2.39 root cause, musl/Windows ARM64, uncompressed downloads

- **Evidence:** `readelf -Ws` on `@kitsunekode/sweep-engine-linux-64@0.5.2`; `.github/workflows/native-engine-release.yml:37-44`; `.github/workflows/cli-binaries.yml:34-39`; `install.sh:20-52`; `KitsuneKode/homebrew-tap/Formula/sweep.rb`.
- **Detail:**
  - **GLIBC 2.39 root cause (verifying & extending #1):** `readelf -Ws` shows exactly two symbols causing `GLIBC_2.39` in `DT_VERNEED`: weak references `pidfd_spawnp@GLIBC_2.39` and `pidfd_getpid@GLIBC_2.39` emitted by Rust 1.99 stdlib when linked against `ubuntu-24.04`'s glibc 2.39. Even though weak, `DT_VERNEED` causes hard dynamic-loader failure on Ubuntu 22.04, Debian 12, RHEL 9, and Amazon Linux 2023.
  - **Musl / Alpine:** Neither npm optional engines nor standalone binaries ship `linux-musl` targets, and `install.sh` has no musl detection or Windows PowerShell/Scoop/Winget path (extending #5).
  - **Windows ARM64:** Missing from both npm optional packages and GitHub Releases (only `win-x64` is built).
  - **Uncompressed downloads:** GitHub Releases already publish `.gz` + `.gz.sha256` assets (31.8–45.3 MiB vs 80–104 MiB uncompressed—a **57–60% bandwidth reduction**), yet both `install.sh:32,46` and `Formula/sweep.rb` download the 80–104 MiB uncompressed binaries.
  - **Nix (`flake.nix`, verifying #6):** Confirmed completely unbuildable in Nix's sandboxed `mkDerivation` (`buildPhase` runs `bun install --frozen-lockfile` requiring network access, never compiles the Rust engine, and `installPhase` copies only `apps/cli/dist/sweep.js` without `sweep-ui.js`, `sweep-lib.js`, `node_modules`, or `nodejs`/`bun` runtime wrapper).
- **Impact:** Linux engine broken on most LTS distros and containers; 2.4× larger downloads than needed; broken Nix flake.
- **Effort:** M | **Fix Risk:** Med | **Confidence:** HIGH
- **Fix sketch:** Target `x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl` statically for `sweep-engine` (1.3 MiB static binary works on EVERY glibc AND musl distro with zero `GLIBC_*` dependency!), or build glibc in a `manylinux2014`/`ubuntu-22.04` container; update `install.sh` and `homebrew-tap` to download `.gz` + verify `.gz.sha256` (and check `gzip -d` availability); fix `flake.nix` using a fixed-output derivation or `buildRustPackage` + wrapped bundle.

---

### 3.4 Release Pipeline & CI

#### F18 — Release supply-chain, preflight, and pipeline gaps

- **Evidence:** `.github/workflows/cli-binaries.yml:8-11,175-217`; `.github/workflows/release.yml:178-196`; `apps/cli/scripts/preflight.ts:254-261`; `apps/cli/src/handlers/doctor.ts:191-203`.
- **Detail:**
  1. **No GitHub Release attestations:** npm publishes use OIDC trusted publishing, but standalone binaries (`sweep-*`) and engine binaries (`sweep-engine-*`) uploaded in `cli-binaries.yml:175-182` have no `actions/attest-build-provenance` step—`.sha256` files sit on the same release page as the binaries.
  2. **Unpinned cross-repo execution with write PAT:** `cli-binaries.yml:206-208` clones `KitsuneKode/homebrew-tap` `main` (unpinned SHA) and executes `bin/update-formula "$version"` with `TAP_GITHUB_TOKEN` in the environment.
  3. **Duplicate-release hazard:** `cli-binaries.yml:8-11` triggers on both `v*` and `@kitsunekode/sweep@*` tags. While `GITHUB_TOKEN` pushes don't re-trigger, a maintainer pushing both tags triggers duplicate binary builds and two competing GitHub Releases.
  4. **`preflight.ts` blind spot:** Line 257 only checks `git status --porcelain apps/ packages/`, missing uncommitted edits in `crates/`, `native-packages/`, or `scripts/`.
  5. **`doctor --json` missing `drainStdout()`:** `apps/cli/src/handlers/doctor.ts:192-202` calls `writeJson(...)` then immediately `exitWith(...)` without `await drainStdout()`, risking truncated JSON on slow pipes.
  6. **Missing CI coverage:** CI runs `bun audit --audit-level critical` only (high vulnerabilities pass); Node 20/22 LTS compatibility is never tested in CI (only Node 24 in `docs` and runner default elsewhere); no musl/older-glibc container test.
- **Impact:** Supply-chain weakness on standalone binaries, potential truncated `doctor --json` output, and undetected Node LTS regressions.
- **Effort:** M | **Fix Risk:** Low | **Confidence:** HIGH
- **Fix sketch:** Add `actions/attest-build-provenance` in `cli-binaries.yml`; inline formula update or pin `homebrew-tap` script commit; restrict `cli-binaries.yml` tag trigger to `v*` only; broaden `preflight.ts` dirty check to the full repo (ignoring `native-packages/*/bin`); add `await drainStdout()` in `doctor.ts`; add a Node 20 LTS smoke step to CI.

---

### 3.5 Performance & Resource Metrics

#### F04 — Published `sweep-ui.js` ships React DEV build (`jsxDEV`, `runWithFiberInDEV`) and CLI bundles duplicate 475 KB

- **Evidence:** `scripts/bundle.ts:16-19,60-114`; `scripts/build-standalone.ts:26-40`; published `sweep-0.5.2.tgz`:
  - `dist/sweep-ui.js`: `1,581,256` bytes (`377` `jsxDEV`, `66` `runWithFiberInDEV`)
  - `dist/sweep.js`: `475,854` bytes
  - `dist/sweep-lib.js`: `474,725` bytes
- **Detail:** `buildUiBundle()` and `build-standalone.ts` never define `"process.env.NODE_ENV": '"production"'` (nor enable identifier minification or production JSX transform), causing Bun to inline React's entire development reconciler + `jsxDEV` stack-trace hooks into production bundles. Furthermore, `sweep.js` and `sweep-lib.js` both bundle all of `@kitsunekode/sweep-core`, `commander`, and `ajv` independently instead of `sweep.js` being a thin 10-line wrapper importing `makeProgram` from `./sweep-lib.js`.
- **Impact:** Inflates npm unpacked size by ~1+ MiB, inflates standalone binaries, and degrades live TUI frame times during streaming scans and scrolling due to React DEV fiber validation on every render.
- **Effort:** S | **Fix Risk:** Low | **Confidence:** HIGH
- **Fix sketch:** Set `define: { "process.env.NODE_ENV": '"production"' }` (and `NODE_ENV=production` / `minify: true`) in `scripts/bundle.ts` and `scripts/build-standalone.ts`; make `dist/sweep.js` import `./sweep-lib.js` as external; add a `preflight.ts` assertion rejecting `runWithFiberInDEV` or `jsxDEV` in `dist/sweep-ui.js`.

#### Additional performance observations (F19 partial)

- **`packages/core/src/cleaner.ts:473`:** JS Linux apply calls `readLinuxMountPoints()` (reading & parsing `/proc/self/mountinfo`, up to 1 MiB) **inside the per-candidate worker loop** for every single candidate. On a 5,000-candidate JS apply, this performs 5,000 synchronous `/proc` reads. Reading once per batch (or caching briefly per apply) cuts syscall overhead drastically without weakening the already non-atomic JS snapshot model.
- **`packages/core/src/mount-boundary.ts:13`:** Octal unescape regex handles `\040`, `\011`, `\012`, `\134`, omitting `\015` (`\r`).
- **`packages/core/src/rust-engine.ts:518` & `733`:** Every Rust apply runs a synchronous `spawnSync(binary, ["--capabilities"])` (blocking the TUI event loop for up to 1 s), and `isRustEngineAvailable()` runs synchronous `spawnSync(binary, ["--version"])` (already tracked under G4 for async probes).
- **Standalone binary size:** 80–104 MiB uncompressed (31.8–45.3 MiB gzipped) because Bun `--compile` embeds the Bun runtime + bytecode + OpenTUI Zig lib + 1.4 MiB Rust engine. Stripping React DEV mode + enabling full minification will shave several MiB off bytecode and speed up startup.

---

### 3.6 Test Coverage Gaps & Test Quality

- **`apps/docs` (0.01 test-to-source ratio):** 43 source files (10,613 LOC) and only **1 unit test file** (`apps/docs/src/lib/site.test.ts`, 95 LOC) plus `apps/docs/scripts/smoke.ts`. Zero tests for `QueueDemo`, `content.ts` parity against `PATTERN_CATALOG`, or landing-page command validity (which let `npx @kitsunekode/sweep ui .` ship).
- **`scripts/` (0.00 test ratio):** 27 scripts (3,257 LOC) including `publish-release.ts`, `build-standalone.ts`, `bundle.ts`, `smoke-package.ts`, and `verify.ts` have zero unit tests.
- **`packages/display` (0.20 ratio):** 9 source files (1,375 LOC) with 1 test file (276 LOC); minimal coverage of `report.ts`, `init.ts`, and `deletion.ts` formatting/truncation edge cases.
- **Uncommitted `worktree-info.test.ts` gaps:** Does not test 0-commit freshly branched worktrees with uncommitted files, non-English `LANG`/`LC_ALL` locales, bare repositories, detached worktrees with dirty state, or custom default branch names (`develop`).
- **Missing packaging/install tests:** No test verifies the packed tarball's `package.json` for `devDependencies`/`scripts` leaks, `jsxDEV` absence, Node 20 LTS `npm install` without `EBADENGINE`, or Bun global install with a conflicting `@opentui/core@0.1.x` present.
- **Windows / macOS test skips on Linux:** As noted in `remaining-work.md`, macOS-only and Windows-only tests skip on Linux; additionally `smoke-standalone.ts:97` skips PTY UI rendering on Windows (`process.platform !== "win32"`), leaving Windows TUI untested in CI.

---

### 3.7 Architecture & Tech Debt

- **`packages/ui/src/app.tsx` (3,458 LOC, extends G1):** Single monolith owns the reducer wiring, modals (`HelpOverlay`, `ConfirmOverlay`, `InspectOverlay`, `DiskAfter`, config-save, scan-error, applying, folder-jump, actions palette), `ProjectsView` state + `handleProjectKey`, streaming lifecycle, disk-space polling, theme detection, and preference persistence. Any UI change risks subtle ref/closure desyncs (as seen in F16).
- **Duplicated helpers across layers:**
  - `displayTarget` / `displayTargetPath` / `where` home-directory `~` contraction is implemented **three different ways** (`LedgerBand.tsx:59`, `ProjectDetails.tsx:49`, `app.tsx:869`), two of them broken on Windows.
  - `costColor` mapping is duplicated inline in `ProjectsView.tsx:282-287` and `ProjectDetails.tsx:60-65` rather than living in `theme.ts`.
  - `formatBytes` is re-implemented in `apps/docs/src/components/landing/content.ts:73-79` using `KB/MB/GB` labels over 1024-base math (mixing SI labels with binary divisors!), while `@kitsunekode/sweep-display` uses `KiB/MiB/GiB`.
- **Root `package.json` devDependencies hygiene (tracked in G8):** Root still lists `@kitsunekode/sweep-core`, `@kitsunekode/sweep-protocol`, `@kitsunekode/sweep-test-fixtures` as `workspace:*` devDependencies and pins `"oxlint": "^1.93.0"` literally instead of `"catalog:"` (`package.json:85`).

---

### 3.8 DX & Documentation Drift

#### F11 & F19 — Concrete doc/CLI/completion discrepancies

1. **Landing hero broken command (`apps/docs/src/components/landing/landing.tsx:209`):** Tells users to copy `npx @kitsunekode/sweep ui .`, which fails without Bun. `README.md:14,59` and `landing.tsx:847` correctly use `npx @kitsunekode/sweep --dry-run` / `bunx @kitsunekode/sweep ui`.
2. **`apps/cli/README.md` is severely stale:** Diff against root `README.md` shows `apps/cli/README.md` is still the October 14 version (369 lines vs 135 lines) mentioning outdated flows. While `prepack.ts` overwrites it at pack time, anyone viewing `apps/cli/` in git sees stale docs.
3. **`sweep init --dry-run` and `sweep ui --dry-run` hidden from `--help` & completions (`apps/cli/src/cli.ts:235-252,349-357`; `completions.ts:29`):** Both handlers explicitly support `--dry-run` (and `docs/users/configuration.md:12` documents `sweep init --dry-run`), yet neither subcommand declares `--dry-run`, so `sweep init --help` omits it and shell completions never suggest it.
4. **Completions drift (`apps/cli/src/handlers/completions.ts:18-29,174-194`):** `--allow-dangerous` is missing from `ROOT_ACTION_OPTIONS` (leaks onto read-only subcommands like `scan`, `stats`, `doctor`), `--view` (`projects full`) and `--theme` (`auto dark light`) are missing from `WORD_VALUE_OPTIONS`, and fish subcommand flags omit word completions.
5. **Landing page stale TUI mockups (`apps/docs/src/components/landing/landing.tsx:455,501-504,722-747` & `queue-demo.tsx:255`):**
   - Uses `GB`/`MB` in Receipt/Trash/Statusline (`3.2 GB`, `412 MB`) vs `GiB`/`MiB` in Idle (`4.4 GiB`, `612 MiB`).
   - Shows `.sweep-trash-1761400000/` (epoch seconds) instead of actual `.sweep-trash-<ISO>-<UUID>/`.
   - Shows mode chip `FILTER` instead of actual `SEARCH` (`presentation.ts:802`).
   - `QueueDemo` (`queue-demo.tsx`) still shows the legacy flat artifact list rather than the default **Projects view**, and `docs/users/terminal-ui.md:12-13` still opens by describing the old two-pane folder view ("The left pane narrows the current scope... A checked box (`[x]`) means queued") even though `sweep ui` now opens in **Projects view** and checkboxes are rings (`○`/`●`), not `[x]`!
6. **`docs/users/getting-started.md:62` vs `README.md:34`:** `getting-started.md` says `Actions (F2)` without mentioning `Ctrl+K`; `README.md` says `Ctrl+K` without `F2`.
7. **`docs/users/commands.md:10-22`:** Omits `sweep recover` and `sweep schema` from the top command table (though `automation.md` and `safety.md` describe them).
8. **`docs/users/platforms.md:16-18`:** Still cites "The October 4 source checkpoint" and says "it is not a published release" even though `0.5.0`–`0.5.2` were published on Oct 27.

---

### 3.9 Verification & Extension of Earlier-Audit Items `(1)`–`(11)`

| #        | Earlier Finding                                                                                                                                          | Verification                                                                         | Disagreements / Extensions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(1)**  | Published Linux engine requires `GLIBC_2.39`; silent JS fallback needs `node` under Bun                                                                  | **Confirmed** (`readelf -V` on `0.5.2` tarball + `directory-reader.ts:74`)           | **Extended (F12):** Exact cause is two weak symbols `pidfd_spawnp@GLIBC_2.39` & `pidfd_getpid@GLIBC_2.39` in `DT_VERNEED` from Rust 1.99 on `ubuntu-24.04`. Also affects `linux-arm64` (`ubuntu-24.04-arm`). Static `musl` solves both glibc-version and Alpine compatibility at once. Also `resolveEngineBackend` swallows stderr completely so the user never learns _why_ Rust wasn't used.                                                                                                                                                                                  |
| **(2)**  | `sweep init` writes `.sweeprc` with default mode -> `umask 002` fails auto-discovery (`config.ts:122`)                                                   | **Confirmed** (`config.ts:271` vs `122`)                                             | **Extended (F14):** `writeProjectSweeprc:331` also preserves group-writable mode on existing files; `writeInitSweeprc` has a symlink TOCTOU gap; and `sweep doctor` (`validateProjectConfigFile:206`) omits `requireOwned=true`, giving a false `ok` on the exact file `sweep` rejects!                                                                                                                                                                                                                                                                                         |
| **(3)**  | Bare `sweep-engine`/`node` spawn can pick planted binary from cwd on Windows                                                                             | **Confirmed** (`rust-engine.ts:182,227,733`; `directory-reader.ts:74`)               | **Extended (F07):** Same vulnerability exists for bare `"git"` in `git-tracked.ts:108`, uncommitted `worktree-info.ts:44`, and Rust `git_index.rs:387`, plus bare `"bun"` in `ui.ts:42,64`. Worse, `isRustEngineAvailable:716-733` finds the PATH binary for stat-caching and then spawns bare `"sweep-engine"` (executing cwd's binary instead!).                                                                                                                                                                                                                              |
| **(4)**  | Reclaimable totals ignore hardlinks/clones into pnpm/Bun stores                                                                                          | **Confirmed** (`scanner.ts:187-202`; `crates/sweep-fs/src/lib.rs`)                   | **Nuance:** Per-artifact hardlink dedupe exists in apparent mode, and `safety.md:121-124` + `remaining-work.md` G2b acknowledge cross-artifact dedupe & `st_blocks` as open work. However, **neither** `ProjectsView` nor `sweep status` flags pnpm/Bun store hardlink/reflink inflation next to `node_modules` totals, so users on pnpm/Bun routinely see "30 GiB reclaimable" when deleting frees <1 GiB.                                                                                                                                                                     |
| **(5)**  | `install.sh` downloads uncompressed binaries, no Windows/musl path, no attestations                                                                      | **Confirmed** (`install.sh:22-52`)                                                   | **Extended (F12, F18):** `.gz` + `.gz.sha256` assets are **already built and uploaded** on every release (saving ~58% bandwidth), and `KitsuneKode/homebrew-tap/Formula/sweep.rb` ALSO downloads uncompressed 80–104 MiB binaries.                                                                                                                                                                                                                                                                                                                                              |
| **(6)**  | `flake.nix` package cannot build                                                                                                                         | **Confirmed** (`flake.nix:26-41`)                                                    | **Extended:** Beyond network-in-sandbox `bun install`, `installPhase` also omits `dist/sweep-ui.js`, `dist/sweep-lib.js`, `sweep-engine`, and a wrapped runtime (`makeWrapper` with `nodejs`/`bun`), so even an impure build produces a broken binary.                                                                                                                                                                                                                                                                                                                          |
| **(7)**  | Stale `apply.lock` has no documented recovery                                                                                                            | **Confirmed** (`apply-session.ts:74-85`; `safety.md:132-142`; `troubleshooting.md`)  | **Extended:** `troubleshooting.md` doesn't even have a table row for `apply_busy` / `apply.lock`, and `apply-session.ts:79` points to "its journal" without printing the `owner.json` journal path or PID (even though `readApplyLockStatus()` already knows how to read it!).                                                                                                                                                                                                                                                                                                  |
| **(8)**  | `$schema` rejected in `.sweeprc` and no config schema                                                                                                    | **Confirmed** (`config.ts:63-70,152-156`; `packages/protocol/schemas/`)              | **Extended:** `writeProjectSweeprc`'s own doc comment (`config.ts:310`) claims "unrecognized fields are preserved verbatim", contradicting `readJsonConfig:153` which rejects them; `sweep schema` should also export `config.schema.json`.                                                                                                                                                                                                                                                                                                                                     |
| **(9)**  | Tool-home list gaps in `classification.ts`                                                                                                               | **Confirmed** (`classification.ts:25-70`; `classify.rs:12-55`)                       | **Extended (F03, F17):** Major missing tool homes: `.asdf`, `.mise`, `.nodenv`, `.pyenv`, `.poetry`, `.conda`/`miniconda3`/`anaconda3`/`miniforge3`, `.uv`, `.pipx`, `.rbenv`, `.rvm`, `.gem`, `~/go`, `.sdkman`, `.gradle`, `.m2`, `.composer`, `.pub-cache`, `.android`, `.flutter`, `.windsurf*`, `.zed`, `.claude`, `.codex`, `.gemini`, `.t3`, `~/scoop`, `~/snap`, `~/Applications`, plus `Windows` and `/etc`, `/sys`, `/proc`, `/dev`, `/boot`, `/bin`, `/sbin`, `/lib*` in `SYSTEM_TOOL_DIRS`. Also `*.app` causes false positives on normal projects named `foo.app`. |
| **(10)** | No detection of running dev servers, cloud-synced folders, or sweep's own install                                                                        | **Confirmed** (no checks in `packages/core` or `crates/`)                            | **Extended:** Deleting `node_modules`/`.next`/`target` inside Dropbox/iCloud/OneDrive/Google Drive (`~/Library/CloudStorage`, `~/Dropbox`, `~/OneDrive`) triggers cloud sync deletion storms; running `sweep` against a checkout containing sweep's own running `node_modules` (e.g. `~/Projects/cli-tools/sweep`) can delete its own runtime dependencies mid-execution (when running from npm/workspace rather than standalone).                                                                                                                                              |
| **(11)** | `bun i -g @kitsunekode/sweep@0.5.2` crashed `sweep ui` with `ImageRenderable` not found due to optional peer `^0.2.16` resolving another tool's `0.1.97` | **Confirmed** (`sweep-0.5.2.tgz` `package.json` + `apps/cli/package.json` on `main`) | **Extended (F01, F02):** Moving `@opentui/core: ^0.6.8` to hard `dependencies` on `main` creates a new Node 20/22/24 `EBADENGINE` + 18 MiB bloat regression (F01), and **still** leaves zero runtime export/version checks, zero build-time manifest-vs-bundle external checks, and zero conflicting-`@opentui/core` smoke tests (F02). Also nothing has been released since `0.5.2` (8 unreleased changesets sit in `.changeset/`).                                                                                                                                            |

---

## 4. Static Metrics

### 4.1 Codebase Size & Test-to-Source Ratios

| Package / Crate                            | Source Files | Source LOC | Test / Harness Files |   Test LOC | Test:Source Ratio |
| ------------------------------------------ | -----------: | ---------: | -------------------: | ---------: | ----------------: |
| `packages/ui`                              |           52 |     15,871 |                   44 |     11,541 |              0.73 |
| `apps/docs`                                |           43 |     10,613 |                    1 |         95 |          **0.01** |
| `packages/core`                            |           30 |      8,924 |                   35 |      7,369 |              0.83 |
| `apps/cli`                                 |           32 |      4,015 |                   13 |      1,173 |              0.29 |
| `crates/sweep-engine`                      |            6 |      3,598 |          1 (+inline) |      2,215 |              0.62 |
| `scripts/`                                 |           27 |      3,257 |                    0 |          0 |          **0.00** |
| `crates/sweep-fs`                          |            5 |      2,286 |               inline |      1,352 |              0.59 |
| `packages/display`                         |            9 |      1,375 |                    1 |        276 |              0.20 |
| `crates/sweep-engine-cli`                  |            1 |      1,060 |          3 (+inline) |        684 |              0.65 |
| `packages/protocol`                        |            3 |        541 |                    3 |        189 |              0.35 |
| `crates/sweep-types`                       |            1 |        417 |               inline |        117 |              0.28 |
| `packages/engine-native`                   |            6 |        356 |                    3 |         97 |              0.27 |
| `crates/sweep-errors`                      |            1 |         68 |               inline |         21 |              0.31 |
| `tests/` (integration)                     |            0 |          0 |                    5 |      1,149 |                 — |
| **Total (adjusted for Rust inline tests)** |      **218** | **52,471** |    **109 (+inline)** | **26,278** |          **0.50** |

### 4.2 Largest Source Files (Tech-Debt Hotspots)

|   LOC | File                                           | Concern                                                               |
| ----: | ---------------------------------------------- | --------------------------------------------------------------------- |
| 3,458 | `packages/ui/src/app.tsx`                      | Extreme monolith (overlays, state wiring, projects keymap, lifecycle) |
| 2,360 | `crates/sweep-fs/src/lib.rs`                   | Walk + sizing + inline tests combined                                 |
| 2,115 | `apps/docs/src/landing.css`                    | Very large custom stylesheet with hand-maintained token overrides     |
| 1,956 | `crates/sweep-engine/src/apply.rs`             | Revalidation + deletion + tests combined                              |
| 1,928 | `apps/docs/src/components/ui/slider.tsx`       | Vendored Fluid Functionalism UI primitive (unused on landing?)        |
| 1,407 | `packages/ui/src/state/store.ts`               | Core TUI state machine                                                |
| 1,217 | `crates/sweep-engine-cli/src/main.rs`          | Engine CLI protocol + tests                                           |
| 1,202 | `packages/core/src/discovery-index.ts`         | Paged discovery index (G1 foundation)                                 |
| 1,062 | `apps/docs/src/components/landing/landing.tsx` | Single-file landing page                                              |
|   964 | `packages/ui/src/presentation.ts`              | Formatting + row builders + hints                                     |

### 4.3 Direct Dependency Counts

| Manifest                         |                                              `dependencies` | `devDependencies` | `optionalDependencies` | `peerDependencies` |
| -------------------------------- | ----------------------------------------------------------: | ----------------: | ---------------------: | -----------------: |
| root `package.json`              |                                                           0 |                12 |                      0 |                  0 |
| `apps/cli/package.json` (`main`) |             6 (4 workspace + `commander` + `@opentui/core`) |                 5 |     5 (native engines) |                  0 |
| `packages/core/package.json`     |                               2 (`ajv`, workspace protocol) |                 6 |                      0 |                  0 |
| `packages/ui/package.json`       | 6 (`@opentui/core`, `@opentui/react`, `react`, 3 workspace) |                 6 |                      0 |                  0 |
| `packages/display/package.json`  |                        2 (`picocolors`, workspace protocol) |                 5 |                      0 |                  0 |
| `packages/protocol/package.json` |                                                           0 |                 5 |                      0 |                  0 |
| `apps/docs/package.json`         |                                                          17 |                11 |                      0 |                  0 |

### 4.4 Published Bundle & Release Asset Sizes (`v0.5.2`)

| Artifact                                       |            Uncompressed | Gzipped / Tarball | Notes                                                                                                |
| ---------------------------------------------- | ----------------------: | ----------------: | ---------------------------------------------------------------------------------------------------- |
| `@kitsunekode/sweep@0.5.2` (npm)               |      2.54 MiB (6 files) |         ~0.50 MiB | `sweep-ui.js` = **1.58 MiB** (React DEV!), `sweep.js` = 476 KB, `sweep-lib.js` = 475 KB (duplicated) |
| `@opentui/core@0.6.8` (new hard dep on `main`) | 17.69 MiB (+native pkg) |                 — | Requires `node >= 26.4.0`                                                                            |
| `@kitsunekode/sweep-engine-linux-64@0.5.2`     |                1.39 MiB |  0.62 MiB (`.gz`) | Requires `GLIBC_2.39`                                                                                |
| `@kitsunekode/sweep-engine-linux-arm64@0.5.2`  |                1.32 MiB |  0.58 MiB (`.gz`) | Requires `GLIBC_2.39`                                                                                |
| `@kitsunekode/sweep-engine-darwin-64@0.5.2`    |                1.26 MiB |  0.57 MiB (`.gz`) | macOS Intel                                                                                          |
| `@kitsunekode/sweep-engine-darwin-arm64@0.5.2` |                1.22 MiB |  0.54 MiB (`.gz`) | macOS ARM64                                                                                          |
| `@kitsunekode/sweep-engine-windows-64@0.5.2`   |                1.44 MiB |  0.57 MiB (`.gz`) | Windows x64                                                                                          |
| `sweep-darwin-arm64` (standalone)              |               79.94 MiB | 31.83 MiB (`.gz`) | `install.sh` & Homebrew fetch 79.94 MiB                                                              |
| `sweep-darwin-x64` (standalone)                |               86.72 MiB | 34.32 MiB (`.gz`) | `install.sh` & Homebrew fetch 86.72 MiB                                                              |
| `sweep-linux-arm64` (standalone)               |              103.05 MiB | 44.05 MiB (`.gz`) | `install.sh` & Homebrew fetch 103.05 MiB                                                             |
| `sweep-linux-x64` (standalone)                 |              103.96 MiB | 44.39 MiB (`.gz`) | `install.sh` & Homebrew fetch 103.96 MiB                                                             |
| `sweep-win-x64.exe` (standalone)               |              103.62 MiB | 45.32 MiB (`.gz`) | No Windows installer script                                                                          |

### 4.5 CI Matrix Coverage (`.github/workflows/ci.yml`)

| Dimension         | Covered in CI                                                                                                       | Missing / Gap                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Runners           | `ubuntu-latest` (24.04 x64), `ubuntu-24.04-arm`, `macos-latest` (ARM), `macos-15-intel`, `windows-latest` (x64)     | No `ubuntu-22.04` / Debian 12 / Alpine musl; no Windows ARM64                        |
| Runtimes          | Bun `1.4.2`; Node `24` (docs job only)                                                                              | No Node 20 LTS or Node 22 LTS install/run test; no Bun-only (no `node` on PATH) test |
| TUI PTY smoke     | Linux x64 only (`smoke-focused-ui.py`, `smoke-active-ui.py`, `smoke-standalone.ts`)                                 | macOS PTY runs only in standalone smoke; Windows TUI has 0 PTY/ConPTY tests          |
| Security / Audits | `actionlint`, `bun audit --audit-level critical`, `cargo audit --deny warnings`, Linux mount/deletion qualification | `bun audit` skips `high` advisories; no SBOM or SLSA attestation on GitHub Releases  |

---

## 5. UI Inconsistencies & Clove-Inspired Design Proposal

### 5.1 Audited Visual & Interaction Inconsistencies

#### Terminal UI (`packages/ui/src/*`)

1. **Color tokens & hardcoded values outside `theme.ts`:**
   - `widgets.tsx:175` falls back to literal `"#666666"`; `meter-draw.ts:34` falls back to `"808080"`.
   - `ProjectDetails.tsx:66` blends row bars with magic constant `0.6` while `ProjectsView.tsx:288-289` uses `ROW_BAR_SOFT = 0.7` / `ROW_BAR_STRONG = 0.9` from `theme.ts`.
   - `costColor` (`cache`, `install`, `build`, `unknown`) is defined inline twice (`ProjectsView.tsx:282-287`, `ProjectDetails.tsx:60-65`) instead of as semantic tokens in `theme.ts`, and reuses `tokens.positive` (colliding with `safe` risk) and `tokens.info` (colliding with `recent` age), violating `.docs/ux-principles.md:131`.
2. **Brand & chrome inconsistency between default Projects view and Full view:**
   - `LedgerBand.tsx` / `presentation.ts:464` draws **`◆ sweep`**; `ProjectsView.tsx:305` draws plain **`sweep`** (no diamond).
   - `KeyHints.tsx` draws **filled keycaps** (`variant="caps"`) in Full view and **plain text** (`variant="plain"`) in Projects view, contradicting `.docs/ux-principles.md:115`.
3. **Key-hint wording & vim-alias violations:**
   - `presentation.ts:694-695` mixes `Ctrl+K`, `ctrl-c`, `↑↓`, and `n/esc`.
   - `presentation.ts:757` (`l/h expand/fold`) and `presentation.ts:610` (`l/space expands` / `h/space collapses`) expose vim aliases as primary hints, violating `.docs/ux-principles.md` Rule 1 (should be `←→`).
   - `ProjectsView.tsx:597` empty state says `b, then p adds them`—cryptic key chaining instead of naming the action or opening patterns directly.
4. **Filter syntax & unit inconsistency:**
   - `ProjectsView.tsx:563` says `>100MiB, idle:30d` (`idle:` doesn't exist!); `ReviewPane.tsx:26` says `>100MB, older:30d`; `app.tsx:327` says `>100MB older:30d`; `filter-query.ts:45` says `>100MiB older:30d`.
5. **Kitty pixel vs text/block fallback parity (`Meter.tsx`, `meter-draw.ts`):**
   - `StackBar`: Kitty draws a 50%-height rounded capsule with 1 px seams and alpha/mix dimming (`STACK_DIM = 0.38`) with minimum 1 px per segment; text fallback (`stackLine`) draws full-width `━`/`─` lines with **no seam, no color dimming**, and drops small segments via `Math.round`.
   - `Meter` (`variant="blocks"`): Kitty draws a thin centered pill (`thickness: 0.42`) while text draws full-cell-height `█` bars (`magnitudeBar`).
   - `Meter` preview color: Kitty (`meter-draw.ts:71`) hardcodes `rgb(fill)` at `0.38` alpha and ignores `props.previewColor`, while text fallback (`Meter.tsx:180`) uses `props.previewColor`.
6. **Light / dark & `NO_COLOR` parity (`theme.ts`):**
   - `NO_COLOR` (`theme.ts:188-229`) ignores `auto`'s `onTerminal` transparent canvas and forces opaque `#0a0a0a`/`#f7f7f7`; it also collapses `positive`/`warning`/`danger` to identical `text` and flattens `StackBar` cost segments into indistinguishable grays without pattern/hatch differentiation.
   - `ProjectsView.tsx:609` paints cursor rows with `selectionSoftBg` (without `selectionText`), whereas `ArtifactList` uses `selectionBg` + `selectionText`.
7. **Empty / error / loading states:**
   - `ReviewPane.tsx:311` shows bare `"No artifacts found. r rescans from disk."` with no mention of opt-in patterns (unlike `ProjectsView.tsx:597`).
   - `ProjectsView` has no `filterAdvice` line for malformed queries.
   - `ProjectsView` mouse click fires on `onMouseDown` for any mouse button (F16).

#### Website (`apps/docs/src/*`)

1. **Color token fragmentation across 3 CSS files:**
   - `styles.css:131,253` uses `#6b97ff` (cold blue) for `:focus-visible` on docs pages, while `landing.css:49,225` uses chartreuse `var(--signal)`.
   - `styles.css:134-141,203-210` defines neutral gray `#fafafa` / `#171717` `--surface-1..8`, clashing with `theme.css` and `landing.css`'s warm olive-black `oklch(... 128)`.
   - Slight signal drift: `theme.css:16` `oklch(42% 0.11 128)` vs `landing.css:129` `oklch(43% 0.115 128)`.
2. **Copy / data / unit drift:**
   - `landing.tsx:209` recommends broken `npx @kitsunekode/sweep ui .` (F11).
   - Mixes `GiB`/`MiB` (`Idle`) with `GB`/`MB` (`Refuses`, `Keys`, `QueueDemo`).
   - `QueueDemo` & `Keys` show outdated flat view, `FILTER` chip, and epoch `.sweep-trash-1761400000/`.
3. **Full-viewport SVG noise overlay (`landing.css:242-250`):** `position: fixed; inset: 0` with `feTurbulence` at `z-index: 50` adds unnecessary compositor overhead without delivering the crisp tactile depth of Clove's layered inset shadows and subtle dot-grid canvas.

---

### 5.2 Clove-Inspired Design Proposal

Clove's two signature surfaces (verified from `clove.kshv.me` & `/assets/styles-CukaOGK2.css`):

- **(a) Storage Card:** Dark raised card (`#1b1c1f` / `rgb(27,28,31)`, `20px` radius, layered inset highlight `inset 0 1px 0 #ffffff17, inset 0 0 0 1px #ffffff0b` + soft ambient drop shadows), headline figure + dim denominator (`357.8 GB` `of 512 GB used`, dim `154.2 GB available`), **dithered dot-matrix segmented bar** (one hue per category, dims unhovered segments on hover/focus), **3-column icon + name + right-aligned tabular size legend**, and a **single-sentence insight + single action button footer** (`"Caches are using 46.8 GB. Apps rebuild them when they need them."` `[Clear Caches]`).
- **(b) Dot-Grid Canvas Summary Panel:** Sunken dark canvas (`#111113` / `rgb(17,17,19)`, `radial-gradient(circle, var(--canvas-dot) 1px, transparent 1.2px)` on `16px 16px` grid), one **hero numeral** (`39.6 GB`) + short caption (`safe to delete, found on one Mac`), above a nested pill-bordered list (`rounded-2xl` outer card + `rounded-xl` inner panel, hairline row dividers) where each row has **category name**, **colored rebuild-cost subtitle** (`var(--mint)` `"Comes back on its own"` / `var(--vivid-yellow)` `"Check first"`), and **right-aligned monospace size**.

**Sweep trust invariants preserved (`.docs/ux-principles.md`):**

- Never auto-selects on fresh scan; queue starts empty.
- Every action button/key opens **confirmation** (`Review`), never deletes directly.
- Dangerous & blocked items stay excluded from reclaimable totals and bulk actions (`+X GiB guarded` stays separate).
- Motion runs **only** during active scanning/applying, honors `SWEEP_REDUCED_MOTION` & `m`, and keyboard movement is instant (0 ms).
- `NO_COLOR` keeps distinct shapes/patterns for every bar segment and status line.

#### A. Terminal UI Design (`packages/ui`) — 80 / 100 / 120 Columns

Keep Sweep's warm olive-black + chartreuse identity (don't clone Clove's blue/neutral macOS chrome blindly), while adopting Clove's **hierarchy, dithered dot-matrix bar, 3-column legend, single-sentence insight, and single next action**.

1. **Semantic Rebuild-Cost Tokens (add to `theme.ts`, removing inline `costColor`):**
   - `costCache` (comes back on its own): dark `#bfe35a` (chartreuse-mint) / light `#3f6212` — label `"Comes back on its own"`
   - `costInstall` (reinstalls from lockfile): dark `#7eb6d9` (cool slate-blue, distinct from recent-age `info`) / light `#2f5f82` — label `"Reinstalls from lockfile"`
   - `costBuild` (rebuilds on next compile): dark `#e2b552` (warm amber) / light `#8a5f08` — label `"Rebuilds next compile"`
   - `costCustom` (opt-in / check first): dark `#f47f69` (coral-red) / light `#b0372c` — label `"Check first"`

2. **Dithered Dot-Matrix Segmented Bar (`StackBar` v2 in `meter-draw.ts`):**
   - **Kitty graphics protocol:** Render a 2-row-tall (or 1-row crisp) **dot-matrix capsule** using a `2×2` or `3×3` pixel dot grid (1 px gap between dots, subtle Bayer/ordered dither fade on the right edge of each segment, 2 px ground seam between segments). Dimmed segments (`dim: true`) drop dot brightness to `0.32` (never erasing their footprint). During apply (plan phase M1), real engine `onDeleted` / `onActivity` events extinguish dots from the right edge of the active segment (instant shrink under `SWEEP_REDUCED_MOTION`).
   - **Non-Kitty cell fallback (100% parity):** Use **Unicode Braille patterns** (`⣿` full active 8-dot cell, `⣶`/`⣤` dithered edge, `::` / `⣀` dimmed segment, ` ` 1-cell seam when width permits) — and in `NO_COLOR`, differentiate segments by Braille density (`⣿` cache, `⣶` install, `⣤` build, `⠒` custom) so every segment remains readable without hue! Enforce `min 1 cell` per non-zero segment when total segments <= width (matching `allocateBarCells` in `insights.ts:71`).

3. **Responsive Terminal Layouts:**

   - **120 columns (Full Clove-inspired card + details margin):**

     ```
     ◆ sweep  ~/Projects                                                        31.0 GiB free

     57.4 GiB reclaimable  of 112 projects  ·  +4.2 GiB guarded                 0 queued
     ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⡇⠀⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤
     ● Caches   1.8 GiB      ● Installs  38.4 GiB      ● Builds   17.2 GiB

     Finished worktrees (5) hold 3.5 GiB across 2 repos.  [ i Queue idle 6.8 GiB ]
     ─────────────────────────────────────────────────────────────────────────────────────────
     Finished worktrees                 5 · 3.5 GiB  │  kitsunesnipe (worktree · merged)
     › ○  fix-auth-flow    1.4 GiB  4d  kitsunesnipe │  in ~/Projects/kitsunesnipe/.worktrees
       ○  bump-deps        0.9 GiB  2d  kitsunesnipe │
                                                     │  worked on   4 days ago
     Idle 30+ days                     26 · 6.8 GiB  │  branch      fix-auth-flow (merged)
       ○  old-monorepo     2.4 GiB 4mo  templates    │  queued      nothing of 3
       ○  kata-machine     1.1 GiB 7mo  dsa          │
                                                     │  ┌─ 1.4 GiB reclaimable ─────────────┐
     Worked on recently                81 · 47.1 GiB │  │ node_modules              1.1 GiB │
       ○  sweep            4.9 GiB  3m  cli-tools    │  │ Reinstalls from lockfile          │
                                                     │  │ .next                     240 MiB │
                                                     │  │ Rebuilds next compile             │
                                                     │  │ .turbo                     64 MiB │
                                                     │  │ Comes back on its own             │
                                                     │  └───────────────────────────────────┘
      space queue   enter open   i queue idle   c review   / filter   b full view   ? keys
     ```

     _(Right margin adopts Clove's inner list card: artifact kind + colored one-line rebuild-cost status `"Comes back on its own"` / `"Reinstalls from lockfile"` / `"Check first"` + right-aligned size. Hovering/focusing a kind inside an opened project dims every other segment in both the hero dot-matrix bar and the margin bar.)_

   - **100 columns (Single-column Projects view, full 3-col legend + insight footer):**
     - Details margin hides (`width < 116`); Projects list expands to full `96` cols with inline size bars + location + kind summary.
     - 3-column cost legend stays on 1 row (`● Caches 1.8 GiB   ● Installs 38.4 GiB   ● Builds 17.2 GiB`).
     - One-sentence contextual insight line sits directly above the list (updates dynamically for the focused section/project, or shows the single next recommended action: `"5 finished worktrees hold 3.5 GiB."` + `[f Queue finished]` / `[i Queue idle]`, never applying without `c` → confirm).
     - Consistent filled keycaps (`variant="caps"`) across both Projects and Full views.

   - **80 columns (Compact, zero clipping, whole-part shedding):**
     - Brand keeps `◆ sweep` + middle-clipped target + `31.0 GiB free`.
     - Headline simplifies to `57.4 GiB reclaimable · 112 projects` (drops `+guarded` to section meta).
     - Dithered Braille/Kitty bar spans full 76 cols; 3-col legend compacts to `● 1.8G cache  ● 38.4G install  ● 17.2G build`.
     - Insight line drops to compact next-action pill: `Idle 30+d: 6.8 GiB` `[i Queue]` (or when queued: `6.8 GiB queued (14)` `[c Review]`).
     - Project rows keep `› ○  name (22)  size (9)  age (4)  kinds (28)`; per-row size bar drops cleanly (already `< 84`).
     - Footer keeps `space queue  c review  / filter  ? keys` (keycaps, no mid-word clip).

#### B. Website Design (`apps/docs`) — Clove-Inspired Surfaces in Sweep's Olive-Chartreuse System

1. **Unify CSS tokens first:**
   - Replace `--focus-ring: #6b97ff` in `styles.css` with `var(--color-fd-ring)` (olive in light, chartreuse in dark).
   - Map `--surface-1..8` in `styles.css` to warm olive-neutral `oklch` steps matching `theme.css` & `landing.css`.
   - Remove the global `position: fixed` `.sw::after` SVG turbulence overlay; instead apply Clove's tactile craft locally to product panels.
   - Standardize all copy and demos on binary units (`GiB`/`MiB`) to match the real CLI.

2. **Hero Storage Card (replaces flat `QueueDemo` frame):**
   - Adopt Clove's elevated card grammar in Sweep's olive-black palette:
     - Surface: `oklch(18.5% 0.013 128)` (warm olive charcoal, analogous to Clove's `#1b1c1f`), `border-radius: 20px`, layered shadow:
       ```css
       box-shadow:
         inset 0 1px 0 oklch(100% 0 none / 0.09),
         inset 0 0 0 1px oklch(100% 0 none / 0.06),
         0 1px 2px oklch(0% 0 none / 0.2),
         0 16px 36px -12px oklch(0% 0 none / 0.5);
       ```
   - **Header:** Big tabular numeral `57.4 GiB` + dim `reclaimable across 112 projects`, right-aligned dim `31.0 GiB free` (updates live as user ticks rows or clicks "Queue idle").
   - **Dithered Dot-Matrix Bar:** CSS/Canvas interactive segmented bar (2 px dots on 4 px grid, subtle edge dither) split by rebuild cost (`Caches`, `Installs`, `Builds`, `Opt-in`). Hovering any legend cell dims the other segments (`opacity: 0.28`) and swaps the insight sentence beneath the bar (`"Installs take 38.4 GiB · 47.2 GiB sits inside linked git worktrees."`).
   - **3-Column Legend:** Icon + category label + right-aligned `tabular-nums` size (`Caches 1.8 GiB`, `Installs 38.4 GiB`, `Builds 17.2 GiB`).
   - **Interactive Footer:** One honest sentence + one action button that opens **Review** (never instant delete): `"5 finished worktrees hold 3.5 GiB. Their branches are already merged."` `[Review 3.5 GiB]`, advancing to `"26 projects idle 30+ days hold 6.8 GiB."` and finally `"Nothing else is worth clearing right now."` with a receipt line replacing the subtitle (`"✓ Freed 3.5 GiB · 34.5 GiB free now"`).
   - **Fix Hero Copy Command:** Change `npx @kitsunekode/sweep ui .` to a 2-tab pill: `bunx @kitsunekode/sweep ui .` (Interactive UI) and `npx @kitsunekode/sweep --dry-run .` (Node CLI, read-only).

3. **Dot-Grid Canvas Summary Panel (replaces static `Idle` / `Refuses` report card):**
   - Sunken canvas panel: `background-color: oklch(13% 0.01 128)` (`#11130e` dark / `#ecece6` light), `background-image: radial-gradient(circle, var(--canvas-dot) 1px, transparent 1.2px); background-size: 16px 16px; border-radius: 20px;`.
   - Centered **hero numeral** (`47.2 GiB`, `font-family: var(--font-display)`, `2.75rem`, `tabular-nums`) + caption (`reclaimable in idle projects & merged worktrees`).
   - Nested rounded card (`rounded-2xl` outer + `rounded-xl` inner panel, hairline dividers) listing 4–5 realistic categories with colored status subtitles:
     - `node_modules in merged worktrees` — chartreuse `"Reinstalls from lockfile"` — `18.4 GiB`
     - `Cargo target/ in idle crates` — amber `"Rebuilds next compile"` — `14.6 GiB`
     - `.next & .turbo caches` — mint `"Comes back on its own"` — `9.8 GiB`
     - `dist/ (opt-in)` — coral `"Check first · excluded by default"` — `4.4 GiB`
   - Preserves Sweep's safety promise: clicking any row shows the inspect drawer (`why`, `git-tracked check`, `identity pin`), and blocked rows refuse toggling with subtle tactile shake (already present in `QueueDemo`).

---

## 6. What Is Missing (Product Gaps)

1. **No release since `v0.5.2` (Oct 27):** 8 user-facing changesets (including the `@opentui/core` dependency fix for #11, `sweep status`, hero bar by rebuild cost, failure reasons on rows, projects-view polish) are sitting unreleased on `main`. Every new `bun add -g @kitsunekode/sweep` user still hits the broken `0.5.2` release.
2. **Stale `apply.lock` guided inspection & unlock (`G5` / #7):** Users who hit a crash/power-loss during apply have no CLI command (`sweep recover --unlock` with PID/boot-id/start-time verification) and no troubleshooting guide telling them how to safely verify and clear `apply.lock`.
3. **Config JSON Schema & `$schema` support (#8):** Users editing `.sweeprc` in VS Code / Cursor / Zed get no autocomplete or validation, and adding `"$schema"` causes exit 3.
4. **Cloud-sync & active-process hazard warnings (#10):** No detection of cloud-synced roots (`~/Library/CloudStorage`, `~/Dropbox`, `~/OneDrive`, `~/Google Drive`), running dev servers / lock files (`next dev`, `cargo` `.cargo-lock` held, `vite`), or Sweep deleting its own installed `node_modules` directory.
5. **Cross-artifact hardlink / reflink store awareness (`G2b` / #4):** `pnpm` and `bun` global stores make `node_modules` apparent sizes wildly overstate actual disk reclaim. Even before full `st_blocks` / plan-wide inode dedupe lands, detecting a `pnpm-lock.yaml` / `.pnpm` / `bun.lock` store and showing a `"shared store · physical reclaim lower"` note prevents user disappointment.
6. **Windows installation story (#5):** Windows x64 binaries are built and uploaded to GitHub Releases, yet there is no `install.ps1`, Scoop manifest, or Winget manifest, and `README.md` only offers `npm`/`bun` for Windows users.
7. **Linux static/musl & older-glibc support (#1, #5):** Alpine/musl containers, Ubuntu 22.04 LTS, Debian 12, and RHEL 9 users cannot run the native Rust engine today.
8. **`sweep status` parity with W1 worktrees:** Uncommitted W1 surfaces finished worktrees in `ProjectsView`, but `packages/core/src/status.ts` (`sweep status --json`) does not report `finishedWorktrees` count/bytes yet.
9. **Interactive TUI in Node-only environments (`G7`):** Node-only users running `npx @kitsunekode/sweep` have no TUI fallback and hit a confusing error if they follow the landing page's `npx @kitsunekode/sweep ui .`.

---

## 7. Issues to File

### Issue 1 — `[PRIVATE SECURITY ADVISORY, NOT A PUBLIC ISSUE]`

- **Title:** Arbitrary code execution on Windows via bare executable spawns (`git`, `node`, `bun`, `sweep-engine`) from untrusted cwd
- **Labels:** `security`, `windows`, `high-priority`
- **Body:**
  > **Private security advisory — do not file publicly until fixed and released.**
  >
  > **Summary:** On Windows, `CreateProcessW` searches the current working directory before `PATH` for unqualified executable names. Multiple read-only scan and startup paths spawn bare executable names (`git`, `node`, `bun`, `sweep-engine`), allowing a malicious cloned repository containing e.g. `git.exe`, `node.exe`, or `sweep-engine.exe` to execute arbitrary code when a user runs `sweep scan .` or `sweep ui .`.
  >
  > **Affected locations:**
  >
  > - `packages/core/src/rust-engine.ts:182,227,518,713-738` (even validates a `PATH` file in `isRustEngineAvailable` then spawns bare `"sweep-engine"`)
  > - `packages/core/src/directory-reader.ts:74` (`spawn("node", ...)`)
  > - `packages/core/src/git-tracked.ts:108` (`spawnSync("git", ...)`)
  > - `packages/core/src/worktree-info.ts:44` (uncommitted `spawnSync("git", ...)`)
  > - `crates/sweep-engine/src/git_index.rs:387` (`Command::new("git")`)
  > - `apps/cli/src/handlers/ui.ts:42,64` (`spawnSync("bun", ...)`)
  >
  > **Fix:** Resolve all external binaries strictly to absolute paths from `PATH` entries (rejecting `.` and empty entries) before spawning; in standalone binaries, never fall back from failed embedded-engine extraction to `PATH`.

### Issue 2 — `[PRIVATE SECURITY ADVISORY, NOT A PUBLIC ISSUE]`

- **Title:** OS system subtrees (`C:\Windows\System32`, `/etc/*`, `/sys/*`, `/dev/*`) bypass `assertSafeCwd` and `SYSTEM_TOOL_DIRS`; terminal escape injection via `.git/HEAD` branch names
- **Labels:** `security`, `guardrails`, `tui`
- **Body:**
  > **Private security advisory — do not file publicly until fixed and released.**
  >
  > **Summary:**
  >
  > 1. `BLOCKED_ROOTS` in `packages/core/src/guardrails.ts` and `crates/sweep-engine/src/guardrails.rs` checks exact paths, and the depth rule permits `>= 2` segments. As a result, `C:\Windows\System32`, `/etc/ssh`, `/sys/class`, `/dev/disk`, `/proc/sys`, and `/boot/grub` pass `assertSafeCwd`, and `Windows`/Unix OS dirs are absent from `SYSTEM_TOOL_DIRS` (`classification.ts:54-70`, `classify.rs:39-55`).
  > 2. `packages/ui/src/ProjectDetails.tsx:117` renders `facts.branch` (read from `.git/HEAD` in `project-details.ts:79-94` without size/symlink bounds) without `sanitizeTerminalText()`, allowing terminal escape injection and FIFO/large-file DoS from an untrusted repo.
  > 3. `crates/sweep-engine/src/git_index.rs:180` opens `.git/index` without `O_NOFOLLOW`/`O_NONBLOCK`, allowing a planted FIFO to hang `sweep-engine tracked` for 60 s and bypass git-tracked blocking.
  >
  > **Fix:** Prefix-block OS/kernel system roots in `assertSafeCwd` (both engines) and add them to `SYSTEM_TOOL_DIRS`; sanitize `facts.branch` and bound `.git`/`HEAD` reads; open `.git/index` with `O_NOFOLLOW | O_NONBLOCK`.

### Issue 3

- **Title:** Moving `@opentui/core` to hard `dependencies` breaks Node 20/22/24 (`EBADENGINE >=26.4.0`) and bloats `npx` by ~18 MiB; add startup export check & release gate
- **Labels:** `bug`, `packaging`, `release`
- **Body:**
  > **Problem:**
  >
  > 1. On `main`, `apps/cli/package.json:68` moved `@opentui/core` (`^0.6.8`) into `dependencies`. `@opentui/core@0.6.8` declares `"engines": { "node": ">=26.4.0" }` and is 17.7 MiB unpacked (+ platform Zig binaries), breaking `@kitsunekode/sweep`'s `"node": ">=20.3.0"` promise and bloating headless `npx @kitsunekode/sweep --dry-run`.
  > 2. `isOpenTuiAvailable()` (`apps/cli/src/handlers/shared.ts:313-325`) only calls `resolve("@opentui/core")` and never checks version/exports (`ImageRenderable`, etc.), so a conflicting global install still crashes with an opaque `SyntaxError`.
  > 3. `apps/cli/src/handlers/doctor.ts:71` ignores `registeredUiModule`, causing standalone binaries to report `warn opentui` and exit 5.
  > 4. `apps/cli/scripts/prepack.ts` leaves `devDependencies` (`workspace:*`, `catalog:`) and monorepo `scripts` in the published tarball.
  >
  > **Acceptance criteria:**
  >
  > - Keep Node 20/22/24 `npm i -g` and `npx` warning-free and lightweight without breaking `bun add -g @kitsunekode/sweep && sweep ui`.
  > - Verify `@opentui/core` required exports at startup and in `preflight.ts` against `dist/sweep-ui.js` imports.
  > - Add a conflicting-`@opentui/core` smoke test to `scripts/smoke-package.ts`.
  > - Strip `devDependencies` and `scripts` in `prepack.ts`; fix `doctor` standalone `opentui` check.

### Issue 4

- **Title:** Ship Linux static musl (or older-glibc) engine binaries and switch `install.sh` + Homebrew to `.gz` downloads
- **Labels:** `bug`, `packaging`, `linux`, `release`
- **Body:**
  > **Problem:**
  >
  > - Published `@kitsunekode/sweep-engine-linux-64@0.5.2` (and `linux-arm64`) require `GLIBC_2.39` (`pidfd_spawnp@GLIBC_2.39`, `pidfd_getpid@GLIBC_2.39` in `DT_VERNEED` from building Rust 1.99 on `ubuntu-24.04`), failing on Ubuntu 22.04, Debian 12, RHEL 9, and Alpine/musl.
  > - Silent fallback to JS under Bun then crashes if `node` is not on `PATH` without reporting the glibc error.
  > - `install.sh` and `homebrew-tap/Formula/sweep.rb` download 80–104 MiB uncompressed binaries even though `.gz` + `.gz.sha256` assets (32–45 MiB) are already published.
  > - GitHub Release binaries lack SLSA provenance attestations (`actions/attest-build-provenance`).
  >
  > **Acceptance criteria:**
  >
  > - Build `sweep-engine` for static `x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl` (or glibc <=2.31) and verify zero `GLIBC_2.39` `VERNEED` in CI.
  > - Surface engine probe stderr in `sweep doctor` and fallback warnings.
  > - Update `install.sh` and `Formula/sweep.rb` to fetch `.gz`, verify `.gz.sha256`, and add `actions/attest-build-provenance` to `cli-binaries.yml`.

### Issue 5

- **Title:** Production `sweep-ui.js` ships React DEV build (`377 jsxDEV`, `66 runWithFiberInDEV`) and CLI/lib bundles duplicate 475 KB
- **Labels:** `performance`, `packaging`
- **Body:**
  > **Problem:** `scripts/bundle.ts` and `scripts/build-standalone.ts` omit `NODE_ENV=production` / `define: { "process.env.NODE_ENV": '"production"' }`. Inspecting published `@kitsunekode/sweep@0.5.2` shows 377 `jsxDEV` and 66 `runWithFiberInDEV` occurrences in `dist/sweep-ui.js` (1.58 MiB). Additionally, `dist/sweep.js` (476 KB) and `dist/sweep-lib.js` (475 KB) bundle the entire core/CLI twice.
  >
  > **Fix:** Enable production React defines + identifier minification in both bundle scripts, have `sweep.js` import `./sweep-lib.js`, and add a `preflight.ts` guard rejecting `jsxDEV`/`runWithFiberInDEV` in `dist/`.

### Issue 6

- **Title:** Fix `worktree-info.ts` false-positive `merged` on 0-commit worktrees and non-English `upstream_gone` detection
- **Labels:** `bug`, `core`, `worktrees`
- **Body:**
  > **Problem (in `feat/worktree-units`):**
  >
  > 1. `packages/core/src/worktree-info.ts:154-164` uses `git for-each-ref --merged=<baseRef>`, which matches freshly branched 0-commit worktrees (including ones with uncommitted WIP) and places them under **Finished worktrees** after 24 hours.
  > 2. Line 141 checks `track === "[gone]"` without `LC_ALL=C` in `GIT_ENV` (`git-tracked.ts:24-30`), breaking `upstream_gone` on all non-English locales.
  > 3. Default-branch fallback checks only `main`/`master` when `origin/HEAD` is unset instead of checking the main worktree's `HEAD`.
  >
  > **Fix:** Add `LC_ALL: "C"` to `GIT_ENV`, distinguish 0-commit branches at `baseRef` from actually merged branches, add non-English locale and 0-commit dirty-worktree tests, and surface finished worktrees in `sweep status`.

### Issue 7

- **Title:** `ProjectActivityIndex` can misclassify active projects as idle (unsorted 256-entry slice, top-level-only mtimes, climbing into `$HOME`)
- **Labels:** `bug`, `core`, `safety`
- **Body:**
  > **Problem:** In `packages/core/src/project-activity.ts`:
  >
  > 1. `readdirSync(dir).slice(0, 256)` truncates in arbitrary filesystem hash order, potentially missing `.git`, manifests, or recent files in roots with >256 entries.
  > 2. `projectRoot()` does not stop at `HOME` (unlike `workTree()`), so a stray `~/Makefile` or `~/package.json` claims non-git projects under `~`.
  > 3. Only direct children of `root` are stat'd; nested edits under `src/...` in non-git or uncommitted trees do not update `root/src` mtime.
  >
  > **Fix:** Probe markers directly instead of slicing unsorted `readdirSync`; stop `projectRoot()` at `HOME`; sample bounded depth-2/3 source mtimes or document the exact signal contract.

### Issue 8

- **Title:** `sweep init` writes group-writable `.sweeprc` under `umask 002`, and `sweep doctor` falsely reports it `ok`
- **Labels:** `bug`, `config`, `dx`
- **Body:**
  > **Problem:**
  >
  > - `packages/core/src/config.ts:271` (`writeInitSweeprc`) writes `.sweeprc` with default permissions (group-writable `0664` under `umask 002`) and non-atomically, causing `findProjectConfig` (`config.ts:122`) to immediately reject it with exit 3.
  > - `writeProjectSweeprc` (`line 331`) preserves existing group-writable bits on update.
  > - `validateProjectConfigFile` (`line 206`, used by `sweep doctor`) omits `requireOwned = true`, reporting `ok config` on a file `sweep` refuses.
  > - Support `"$schema"` in `.sweeprc` and publish/export `config.schema.json` via `sweep schema`.

### Issue 9

- **Title:** Fix TUI & Landing UX bugs: nonexistent `idle:30d` placeholder, broken `npx ... ui .` hero command, right-click queueing, and Windows path bugs
- **Labels:** `bug`, `ui`, `docs`
- **Body:**
  > **Problems:**
  >
  > 1. `packages/ui/src/ProjectsView.tsx:563` placeholder advertises `idle:30d`, which `filter-query.ts` does not support (`older:30d` only), resulting in 0 matches; `ProjectsView` also omits `filterAdvice()`.
  > 2. `apps/docs/src/components/landing/landing.tsx:209` hero copy box recommends `npx @kitsunekode/sweep ui .`, which fails on Node-only machines (requires Bun).
  > 3. `ProjectsView.tsx:610` queues on `onMouseDown` for right/middle clicks (violates `ux-principles.md` §6).
  > 4. `ProjectsView.tsx:466`, `ProjectDetails.tsx:49`, `app.tsx:869`, and `project-details.ts:86` hardcode `/` or `process.env.HOME`, breaking Windows display/branch detection.
  > 5. `app.tsx:1586` reads stale `expandedProjects` in bursts; `project-details.ts` caches leak across rescans/switches; `meter-draw.ts:331` eviction timer is not `.unref()`'d.

### Issue 10

- **Title:** Fix `sweep apply` confirmation target omission, CLI `--help`/completions drift, and `doctor --json` stdout drain
- **Labels:** `bug`, `cli`, `dx`
- **Body:**
  > **Problems:**
  >
  > - `apps/cli/src/handlers/apply.ts:106-117` prompts without showing `plan.targetDir` or dangerous item count (should reuse `confirmPlanDeletion()`).
  > - `apps/cli/src/handlers/completions.ts:18-29` leaks `--allow-dangerous` onto read-only subcommands and omits `--view`/`--theme` word completions.
  > - `sweep init --help` and `sweep ui --help` omit `--dry-run` even though both handlers support it (and docs document `sweep init --dry-run`).
  > - `apps/cli/src/handlers/doctor.ts:191-203` skips `await drainStdout()` before `exitWith()`.
  > - `apps/cli/src/handlers/scan.ts:64-71` (`--json-stream`) emits pre-enrichment `riskTier: "safe"` for git-tracked entries; document provisional status or emit final enrichment events.

### Issue 11

- **Title:** Adopt Clove-inspired Storage Card & Dot-Grid Canvas patterns across `packages/ui` and `apps/docs`
- **Labels:** `enhancement`, `ui`, `design`
- **Body:**
  > Track the Clove-inspired redesign (dithered Kitty/Braille `StackBar` with `NO_COLOR` patterns, unified rebuild-cost tokens in `theme.ts`, 3-column legend, single-sentence insight + next action footer, unified keycaps & `◆ sweep` mark, and matching landing-page storage card + dot-grid canvas panel) while unifying `styles.css`/`theme.css`/`landing.css` tokens (replacing `#6b97ff` focus rings and aligning `GiB`/`MiB` units).

---

## 8. Recommended Focus Order

1. **Immediate release-blocker sprint (Ship `v0.5.3` / `v0.6.0`):**
   - Resolve **F01 + F02 + F05** (`@opentui/core` Node 20/22/24 compatibility + startup export check + preflight external check + strip `devDependencies`/`scripts` + `doctor` standalone check).
   - Fix **F04** (strip React DEV mode `jsxDEV`/`runWithFiberInDEV` from `sweep-ui.js`, deduplicate `sweep.js`/`sweep-lib.js`).
   - Fix **F12** (static musl Linux engine binary to eliminate `GLIBC_2.39`, switch `install.sh` & Homebrew to `.gz`).
   - Fix **F11** (replace broken `npx @kitsunekode/sweep ui .` on landing hero).
2. **Security hardening PR (Private advisory fixes, paired with next release):**
   - Fix **F03** (prefix-block `C:\Windows` & `/etc`, `/sys`, `/proc`, `/dev`, `/boot`, `/bin`, `/sbin`, `/lib*` + expand tool-home list #9 and tighten `*.app` check).
   - Fix **F07** (resolve absolute `PATH` binaries for `git`, `node`, `bun`, `sweep-engine`; no cwd spawn on Windows; no standalone fallthrough to `PATH`).
   - Fix **F09** (`O_NOFOLLOW | O_NONBLOCK` on Rust `.git/index`, bounded `gitBranch`, `sanitizeTerminalText(facts.branch)`).
3. **Correctness & W1 completion PR:**
   - Fix **F06** (W1 `worktree-info.ts` 0-commit false-positive `merged` + `LC_ALL=C` + custom default branch) before merging `feat/worktree-units`.
   - Fix **F08** (`ProjectActivityIndex` unsorted 256-entry slice + `$HOME` boundary), **F14** (`sweep init` `0600` + `doctor` ownership check + `apply-session.ts` guidance), **F13** (`apply` confirm target + `--json-stream` contract), **F15** (Windows junction fail-closed + path separators + standalone temp extraction cache), **F17** (`--engine js` isolation).
4. **TUI polish & Clove-inspired redesign (W2 / I1 / I2 / M1 + website):**
   - Fix **F10 + F16** (`idle:` filter alias, left-button press-release, burst refs, cache cleanup, `.unref()`).
   - Land Clove-inspired dot-matrix `StackBar` (Kitty + Braille + `NO_COLOR`), unified `theme.ts` rebuild-cost tokens, 3-column legend, insight sentence, single next action, and landing-page storage card + dot-grid canvas panel while unifying `apps/docs` CSS tokens.
5. **Infrastructure & Product Gaps (aligning with `G5`, `G6`, `G8`):**
   - Guided `apply.lock` inspection/unlock + troubleshooting docs; `.sweeprc` `$schema` + `config.schema.json`; `flake.nix` fix; Windows PowerShell/Scoop installer; SLSA provenance attestations on GitHub Releases; decompose `packages/ui/src/app.tsx`.

---

## 9. What Was Not Audited

- **Runtime test execution & builds:** Per audit rules (concurrent install in checkout), no `bun test`, `cargo test`, `bun run build`, `bun run check`, or live PTY/browser tests were executed.
- **Live physical terminal rendering:** Kitty graphics rendering, terminal palette OSC 11 queries, SGR mouse escape sequences, and ConPTY/Windows Terminal behavior were audited statically only (not in Ghostty, Kitty, iTerm2, Alacritty, tmux, or Windows Terminal).
- **Large-scale runtime profiling:** Peak RSS, FD counts, 200–600 GiB allocated disk workloads, NFS/SMB/FUSE stalls, and `dm-delay` latency were not benchmarked live (tracked in `G2a`/`G2b`).
- **Complete Rust `sweep-fs/src/lib.rs` & `apply.rs` tail:** Key security-critical sections (`removal.rs`, `identity.rs`, `guardrails.rs`, `classify.rs`, `git_index.rs`, `apply.rs` revalidation & delete loop) were read in full; low-level platform-specific Windows/macOS deletion branches inside `apply.rs` lines 451–1500 (already tracked under `G3`) and all 43 `apps/docs/src/components/ui/*` vendored primitives were only spot-checked.
- **External repositories beyond `Formula/sweep.rb`:** `KitsuneKode/homebrew-tap`'s `bin/update-formula` script internals, Vercel deployment settings, and npm registry 2FA/trusted-publisher settings were not inspected.
