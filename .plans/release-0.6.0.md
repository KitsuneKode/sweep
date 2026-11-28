Status: planned
Scope: release
Created: 2026-11-28
Updated: 2026-11-28
Commit: uncommitted

# sweep 0.6.0 release execution plan

This is the single execution plan for sweep 0.6.0. It consolidates the two
independent release plans in `/var/tmp/sweep-060-plan/codex.md` and
`/var/tmp/sweep-060-plan/grok.md`, the repository ledger, the Kuwai island
plan, the Direction C+ TUI audit, the Space report plan, open issues, and open
PRs. Where those inputs disagreed, the decision is recorded once in
[Conflicts resolved](#conflicts-resolved); do not reopen them inside individual
implementation PRs unless new evidence contradicts the decision.

Milestone: [`0.6.0`](https://github.com/KitsuneKode/sweep/milestone/1).
Baseline for this plan: `origin/main` `8f04ea4fe3bf82ab194deb32a4d0c03267df2c91`.

## Execution rules

- Implementation owner for every engineering item: **Devin SWE-2.1 xhigh/max**.
- Every PR gets one review. Only rows marked **External: yes** get the external
  risky-PR review by **Grok 4.7 xhigh on `cursor_2`**. Small review findings are
  fixed directly; they do not start another review round.
- Final UI, README, and docs review before promotion: **Antigravity-2 Neon high**.
- One concern per PR. Apply-authority changes (revalidation, identity,
  confirmation, journal, locks, containment) are isolated from UI, docs, paging,
  schema, and distribution work.
- Every PR passes `bun run check`; Rust changes also pass `bun run rust:check`;
  release-shape changes run `bun run verify` or the narrower exact command named
  in the item. Use isolated temporary state:
  `HOME=/var/tmp/... TMPDIR=/var/tmp/... SWEEP_CONFIG_DIR=/var/tmp/... XDG_CONFIG_HOME=/var/tmp/...`.
- Destructive qualification runs only on generated disposable roots. Harnesses
  must refuse non-generated targets.
- Size means implementation effort excluding review: `S` < half a day,
  `M` roughly one day, `L` multi-day or cross-layer.

## Goals

- Ship 0.5.4 first as the security/trust release, then make 0.6.0 the first
  release line candidate for the redesigned terminal UI, honest CLI output,
  hardened apply lifecycle, read-only Space reporting, widget/Kuwai contract,
  updated toolchain, and broader install reach.
- Publish iterative `0.6.0-rc.N` builds on npm dist-tag `next` and GitHub
  prereleases, then promote one exact commit to `0.6.0`/`latest` only after all
  gates pass on that commit.
- Keep deletion authority fail-closed: exact reviewed candidates, canonical
  target, mode, backend, policy, engine identity, locks, durable journal, and
  platform containment must agree before any new mutation surface exists.
- Keep machine-readable compatibility explicit for CLI consumers, widget JSON,
  saved plans, journals, caches, and streamed protocol consumers.
- Update documentation only with commands and claims that were executed.

## Non-goals

- Paid code signing or notarization.
- A deletion-capable MCP server or autonomous cleaner in 0.6.0.
- Issue #10 `--watch` daemon mode or background continuous deletion.
- Space deletion phases 4a/5a/6a, cache deletion, trash purge, or a deletion
  handoff from the home/Space view. 0.6.0 ships read-only Space information.
- Full trash management (L1 restore/purge) beyond the existing trash mode.
- Windows ARM64 support claims.
- A claim of 200-600 GiB allocated-file readiness unless that exact real run is
  executed and recorded.
- Moving stable Homebrew, Scoop, AUR, winget, mise, or aqua manifests because
  an rc exists.

## Fixed owner decisions already made

- 0.5.4 is the security/trust release: #181 was merged as `8f04ea4`, #158 has
  already been regenerated to include its changeset, and the three draft
  advisories will be published with 0.5.4.
- Everything else listed in the owner brief is in 0.6.0: open follow-up issues,
  the full TUI redesign, widget #166 plus the Kuwai panel contract, CLI text
  #179/#180, read-only Space report, website/docs/SEO and README, AUR and
  winget, the tooling upgrade, and remaining ledger items.
- Reclaimable means safe + caution only; dangerous and blocked bytes are shown
  separately as guarded.
- Unknown activity is not idle; proven-merged worktrees only are "Finished".
- `sweep ui ~` routes to read-only Space information; destructive commands on
  `~` remain refused.
- Binary units only for Space output; no `--si` in 0.6.0.
- Cloud-sync folders under protected personal/system locations stay dangerous;
  fix documentation and explicit reasons, not the classifier.

## 0.5.4 cut checklist

This section exists so 0.6.0 does not inherit release ambiguity. It is not a
0.6.0 workstream.

- [ ] Merge #158 (`chore: version packages`, head `f5a1d0de45707201c8948748e2835b65aa664bfd` at planning time) after confirming it still contains `.changeset/sizing-identity-starvation.md` for #181.
- [ ] Let `.github/workflows/release.yml` publish npm, create tags through `apps/cli/scripts/reconcile-release.ts`, and dispatch binaries/downstream work.
- [ ] Publish the three draft advisories with the release; do not include exploit detail in public issues or release notes.
- [ ] Add one residual-risk sentence to the 0.5.4 notes: closing or killing the terminal host during native apply can leave the native engine running without host control; do not close the terminal during apply, and do not claim parent-death coverage until #185 lands.
- [ ] Merge #182 (`docs: refresh README and user guides for 0.5.4`, head `c963cc18804eae9e9bf2a3ec496bf661056697eb`) once its `cross-platform (windows-latest)` failure is explained or fixed. Do not treat the Vercel rate-limit failure as a code failure.
- [ ] Record the released 0.5.4 commit, npm version, scoped tag, public `v*` tag, GitHub release, and downstream channel states as the compatibility baseline for #192 and #196.

## Verification of disputed claims

- **Grok H1 is confirmed on main.** `packages/core/src/rust-engine.ts:489-548`
  spawns cooperative apply with `detached: true` outside Windows, forwards
  `SIGTSTP`/`SIGCONT` to the child process group, and has no parent-death
  mechanism. There is no `PR_SET_PDEATHSIG` in `crates/` or `packages/core`.
  This contradicts the older Kuwai process-group-only model and is tracked as
  #185.
- **Grok's Full-view dangerous-byte claim is false at the current TUI head.**
  At `origin/feat/tui-cplus-3-modal-shell` `d9f02b1e7d86419d949f4a0e816398b5faa4ea5a`,
  `packages/ui/src/LedgerBand.tsx:38-64` defines reclaimable as
  `bytes.safe + bytes.caution`, guarded as dangerous + blocked, and lines
  224-330 render guarded bytes separately. #127 remains open because the rule
  must be unified and tested across every CLI/TUI surface, not because this
  specific file still has the alleged bug.
- **Codex's C+ confirmation-binding requirement is partly implemented but not
  closed.** On PR #184 head `822de13c7ba43aea5a39bf3f208cc96adc9eefe2`,
  `packages/ui/src/reviewed-apply.ts` freezes selected candidate IDs and nested
  plan data with `structuredClone`; `packages/ui/src/app.tsx` uses only
  `reviewedApplyRef` for queued, project-scoped, and single-item apply. Target
  identity is inside the frozen plan, and trash/size-override intent is captured
  before `operations.run`. #186 remains open to prove exact mode binding,
  invalidation rules, keyboard/mouse/dry-run parity, and mutation-after-review
  adversarial tests end to end.
- **PR inventory changed after both input plans.** #184 (`feat(ui): C+ confirm
  and apply`, Batch 2) now exists on top of #178, head
  `822de13c7ba43aea5a39bf3f208cc96adc9eefe2`, and has a failing `rust` check at
  planning time. It must not be merged green-by-accident.

## Conflicts resolved

| Conflict                                    | Decision                                                                                                                                                                                                                                                                  | One-line reasoning                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tooling upgrades vs the in-flight TUI stack | Land the non-renderer toolchain slice first (Bun, Rust/Zig validation, Changesets, TypeScript 7, #114), then safety authority, then rebase the TUI stack once.                                                                                                            | These upgrades touch the lockfile/typechecking globally, so doing them before the stack avoids repeated rebases while keeping renderer churn separate.                                         |
| OpenTUI 0.9 timing                          | Finish already-open Batches 0-2 on OpenTUI 0.6.8 (#163, #167, #178, #184), then cut OpenTUI 0.9 in one renderer-only PR before starting Batches 3-5.                                                                                                                      | #184 now exists and was written for 0.6.8, but Batches 3-5 do not; upgrading after #184 avoids rewriting reviewed work without building new visual batches on a runtime that will be replaced. |
| OpenTUI 0.9 release blocker                 | Yes for 0.6.0, because the owner explicitly included the tooling upgrade.                                                                                                                                                                                                 | Unlike Grok's optional recommendation, the owner fixed 0.9 as in scope; if the cutover is hard, the release schedule slips rather than silently dropping the requirement.                      |
| Apply engine process lifetime               | Keep cooperative apply in a controlled child process group for correct Ctrl+Z semantics, but make it host-bound and fail-stop: parent-death teardown on Linux/macOS, a Windows job object or refusal, explicit cancel, durable unknown outcomes, and no automatic replay. | Deletion must not outlive the consenting host merely to survive a crash, while simply removing `detached` would reintroduce the terminal job-control bug the detach was solving.               |
| Kuwai lifecycle wording                     | Split scan and apply lifecycles in `.plans/kuwai-island.md`: widget scans remain host-killable/cgroup-scoped; destructive apply follows #185 and never depends on process-group survival.                                                                                 | The old text used one process-group model for two different operations and contradicted the actual cooperative-apply implementation.                                                           |
| Space report scope                          | Ship read-only `sweep space` and read-only `SpaceView` only; omit deletion phases 4a/5a/6a and all Space delete handoffs from 0.6.0.                                                                                                                                      | The owner scoped the feature as read-only, and the destructive phases require a fully qualified G3 matrix that should not be rushed by UI scheduling.                                          |
| Paging as a release blocker                 | G1 shadow/differential work is in scope, but default-on production paging is not a promotion blocker.                                                                                                                                                                     | The visual/trust release should not be hostage to an architecture migration; incomplete scans must remain honest under the existing cap.                                                       |
| 200-600 GiB real allocation run             | G2b measurement work is in scope, but a 200-600 GiB allocated-file run is not a promotion blocker unless the owner assigns hardware.                                                                                                                                      | Release notes may state only the largest real run actually performed; sparse-file runs are not evidence of allocated-file readiness.                                                           |
| MCP server and #10 watch daemon             | Both are out of 0.6.0; #195 produces only a read-only automation/advisory contract.                                                                                                                                                                                       | A daemon or tool proxy around deletion needs its own threat model and conflicts with the fail-stop lifecycle being built in #185.                                                              |
| Command name                                | Implement `sweep space`, not `sweep report`; retitle/close the naming mismatch when #140 is implemented.                                                                                                                                                                  | The detailed Space plan already uses `sweep space`, and shipping two names would create compatibility debt before the feature exists.                                                          |
| Prerelease package channels                 | npm `next` and GitHub prereleases yes; stable Homebrew, Scoop, AUR, winget, mise, and aqua manifests no.                                                                                                                                                                  | Prereleases must be easy to install for testers without moving stable end-user channels or declaring support before promotion.                                                                 |
| npm dist-tag mechanics                      | Keep Changesets pre mode name `rc` (versions `0.6.0-rc.N`) but change `apps/cli/scripts/release-policy.ts` so this pre mode publishes npm dist-tag `next`.                                                                                                                | The owner requires rc version strings on `next`; do not use `next` as the Changesets pre-mode name because that would produce `0.6.0-next.N`.                                                  |

## Workstreams

Issue references are GitHub issue numbers in `KitsuneKode/sweep`; PR references
are current open PRs unless marked as future.

### W0. Ledger and release hygiene

| Done | ID   | Item                                                                                                          | Owner | Size | Dependencies     | Acceptance criteria                                                                                                                                                                                             | Risk | External |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------- | ----- | ---- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| [ ]  | W0-1 | Reconcile stale ledger/checkbox state (#141, `.plans/remaining-work.md`, `.plans/audit-2026-11-27/README.md`) | Devin | S    | This plan merged | Merged AU items are marked closed with commit SHAs or explicitly mapped to open issues; no item is reimplemented because a stale checkbox says open; `.plans/remaining-work.md` points here for 0.6.0 ordering. | Low  | No       |
| [ ]  | W0-2 | Keep the milestone truthful                                                                                   | Devin | S    | Milestone exists | Every implementation PR references its issue; milestone scope changes are reflected in this plan in the same PR; #10 stays outside the milestone unless the owner reverses D-L.                                 | Low  | No       |

### W1. Toolchain and runtime foundation

Land these serially after 0.5.4. Each PR must update pins, lockfiles, docs, and
CI references together.

| Done | ID   | Item                                       | Owner | Size | Dependencies    | Acceptance criteria                                                                                                                                                                                                                                                                              | Risk   | External |
| ---- | ---- | ------------------------------------------ | ----- | ---- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------- |
| [ ]  | W1-1 | Bun 1.4.5 alignment                        | Devin | S    | 0.5.4 published | `bun-version` in all workflows is 1.4.5, `@types/bun` catalog is aligned, `bun.lock` regenerated, `bun run check` and isolated install/global smoke pass.                                                                                                                                        | Medium | No       |
| [ ]  | W1-2 | Rust 1.100 + Zig/cargo-zigbuild validation | Devin | M    | W1-1            | `rust-toolchain.toml` and workflow `toolchain:` pins move together; `setup-zig` and `cargo-zigbuild` versions are explicit; `bun run rust:check`, native matrix, ELF/glibc gates, musl package build, and old-distro container smoke pass.                                                       | High   | Yes      |
| [ ]  | W1-3 | Changesets 3 + rc-on-next policy           | Devin | M    | W1-1            | `@changesets/cli` and `.changeset/config.json` schema agree; `changesets/action` compatibility is explicit; `apps/cli/scripts/release-policy.ts` maps pre-mode `rc` versions to npm dist-tag `next`; tests cover `0.6.0-rc.0` and reject `latest` prerelease tags.                               | High   | Yes      |
| [ ]  | W1-4 | TypeScript 7 replacement for #87           | Devin | M    | W1-1            | Close or supersede conflicting dependabot PR #87; catalog and all workspaces compile on the chosen TypeScript 7 version; no typecheck suppressions are added without comments; `bun run check` passes.                                                                                           | High   | Yes      |
| [ ]  | W1-5 | Production React/entrypoint split (#114)   | Devin | M    | W1-4            | `sweep-ui.js` uses production React, `sweep.js`/`sweep-lib.js` duplication is removed or justified by size proof, standalone bundle smoke passes, and startup export/version preflight still fails closed on incompatible OpenTUI.                                                               | Medium | No       |
| [ ]  | W1-6 | OpenTUI 0.9 renderer-only cutover          | Devin | L    | TUI-4 merged    | Catalog/lockfile move to the selected 0.9.x version; no authority or visual redesign rides along; optional dependency/export preflight, native ABI, text fallback, mouse/focus, bracketed paste, and before/after PTY goldens pass at 60/80/100/120 columns on Linux, macOS, and Windows ConPTY. | High   | Yes      |

### W2. Apply trust foundation

These are authority-only PRs. Order matters: lifecycle first, then lock/journal,
then identity/containment, then UI confirmation integration. Existing related
safety follow-ups are included so they do not become unscheduled drive-by fixes.

| Done | ID   | Item                                                                                        | Owner | Size | Dependencies | Acceptance criteria                                                                                                                                                                                                                                                                                                                                                               | Risk   | External |
| ---- | ---- | ------------------------------------------------------------------------------------------- | ----- | ---- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| [ ]  | W2-1 | Engine lifecycle and host-death semantics (#185)                                            | Devin | L    | W1-1         | Implements the process-lifetime decision above; preserves Ctrl+Z behavior with a controlled child group; Linux parent-death proof plus race-close control channel/pidfd; macOS equivalent or documented mechanism; Windows job object or explicit unsupported refusal; kill-after-consent tests prove no orphan continues deletion; interrupted items become unknown/unattempted. | High   | Yes      |
| [ ]  | W2-2 | Cross-config apply locks (#187, G5)                                                         | Devin | M    | W2-1         | Canonical target/device/volume identity; ancestor/descendant overlap detection; authority namespace independent of config dir; host/boot/session/PID/start/executable identity; guided stale takeover; concurrent and PID-reuse tests.                                                                                                                                            | High   | Yes      |
| [ ]  | W2-3 | Durable journals and recovery (#188, G6)                                                    | Devin | L    | W2-1         | Intent is durable before mutation; exact terminal receipt; unknown never becomes success; schema versioning; bounded retention; `sweep recover`/`doctor` read-only accuracy; torn-write, EPIPE, ENOSPC, fsync/rename, downgrade, and kill-point tests.                                                                                                                            | High   | Yes      |
| [ ]  | W2-4 | Engine identity residuals (#190)                                                            | Devin | L    | W1-2, W2-1   | Extends existing file binding in `packages/core/src/rust-engine.ts`; spawned-image proof or platform fail-closed refusal; no fallback/respawn after apply may start; extracted/embedded/global/npm namespaces and concurrent update tests.                                                                                                                                        | High   | Yes      |
| [ ]  | W2-5 | Platform destructive boundary (#189, G3)                                                    | Devin | L    | W2-1         | Linux `openat2`/no-cross-mount behavior is qualified; macOS descriptor/no-follow path; Windows parent-handle/reparse semantics; live mount verification; network/FUSE fail-closed; locked/busy honesty; both direct Rust entrypoint and host-mediated paths tested.                                                                                                               | High   | Yes      |
| [ ]  | W2-6 | Reviewed-consent contract core (#186)                                                       | Devin | M    | W2-2, W2-3   | Canonical committed-review record binds ordered candidate IDs, canonical target identity, risk set, mode, dry-run, size override, backend/engine binding, scan generation, and policy; saved-plan loader refuses mismatches; no UI redesign in this PR.                                                                                                                           | High   | Yes      |
| [ ]  | W2-7 | Windows/WSL/path safety batch (#132, #151, #152)                                            | Devin | M    | W2-5         | Broken junctions fail closed; Windows path separators/homedir/display/temp leaks fixed; `\\.\` namespace stripping; WSL `/mnt/<drive>/Windows` prefix block; cloud-sync locations keep dangerous classification with explicit reasons; real Windows junction test included.                                                                                                       | High   | Yes      |
| [ ]  | W2-8 | Worktree/idle/selection/status safety follow-ups (#125, #150, #154, #171, #173, #175, #183) | Devin | M    | W1-1         | Each merged PR's follow-up is closed with a regression test; tracked-file cost is bounded; stream selection and apply prompt semantics stay aligned; sizing budget never blocks directory admission in a way that undercounts silently; no behavior change lacks parity evidence.                                                                                                 | Medium | No       |
| [ ]  | W2-9 | Adversarial filesystem/protocol fixtures (#193, G9, #168)                                   | Devin | M    | W2-1         | Fixture harness covers the shapes listed in #193; canaries assert zero authority widening; stuck-engine tests leak zero processes; seeds recorded; destructive cases run only in generated isolated roots.                                                                                                                                                                        | High   | Yes      |

### W3. Direction C+ TUI foundation and batches

Current open stack bottom-up: #163 -> #167 -> #178 -> #184. Rebase after W1/W2
foundation, then merge in order. #176 is an issue, not a PR; port it as its own
small PR only when the byte-wrapper ownership is clear.

| Done | ID    | Item                                                                                     | Owner | Size | Dependencies | Acceptance criteria                                                                                                                                                                                              | Risk   | External |
| ---- | ----- | ---------------------------------------------------------------------------------------- | ----- | ---- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| [ ]  | TUI-1 | Rebase/merge #163 Direction C+ tokens                                                    | Devin | M    | W1-5, W2-6   | `origin/main` base; exact head revalidated; 16-color/light/dark/NO_COLOR token tests pass; no selection/apply behavior changes.                                                                                  | Medium | No       |
| [ ]  | TUI-2 | Rebase/merge #167 Projects view and Storage Card                                         | Devin | L    | TUI-1        | Exact selection parity, partial/provisional totals, distinct rebuild-cost categories, screenshots/goldens pass at 60/80/100/120 columns.                                                                         | Medium | No       |
| [ ]  | TUI-3 | Rebase/merge #178 modal shell                                                            | Devin | M    | TUI-2        | B1/B2/B4/B5/B11/B12 fixed; modal focus/escape invariants pass; screenshots/goldens pass.                                                                                                                         | Medium | No       |
| [ ]  | TUI-4 | Finish/rebase/merge #184 Batch 2 confirm/apply                                           | Devin | M    | TUI-3, W2-6  | Current `rust` check fixed; warning visible without scroll at 80x24/100x32; override only near/over ceiling; exact reviewed plan integration; trash/dry-run/dangerous/single/queued/stopping/receipt tests pass. | High   | Yes      |
| [ ]  | TUI-5 | OpenTUI 0.9 cutover execution                                                            | Devin | L    | TUI-4        | Same as W1-6; this row is the scheduling dependency for Batch 3.                                                                                                                                                 | High   | Yes      |
| [ ]  | TUI-6 | Batch 3 Full view, LedgerBand, ReviewPane, grouped list/sidebar, patterns controls       | Devin | L    | TUI-5, #127  | Uses one shared reclaimable helper; preserves frozen candidate identity; range/filter/group behavior and hidden counts tested; `LedgerBand` regression test locks safe+caution semantics.                        | Medium | No       |
| [ ]  | TUI-7 | Batch 4 action palette, inspect, responsive help, filter picker, folder jump             | Devin | M    | TUI-6        | Modal focus and accessible key paths work at 60/80/100/120; keyboard-only and mouse-only journeys complete; no stale query/index can act on the wrong row.                                                       | Medium | No       |
| [ ]  | TUI-8 | Batch 5 zero-match, badges/name fitting, color separation, footers plus #176 APC wrapper | Devin | M    | TUI-6, #176  | B6/B9/B10 fixed; APC/raw byte behavior correct; NO_COLOR/16-color light/dark pass; no apply authority changes.                                                                                                   | Medium | No       |
| [ ]  | TUI-9 | G7 usability/accessibility closure (#133, audit B-items not already closed)              | Devin | M    | TUI-8        | Keyboard-only and mouse-only launch-to-receipt journeys pass; hidden/blocked counts visible; `scan` output grouping and copy consistent; 2,000-row render budget respected.                                      | Medium | No       |

### W4. CLI, protocol, compatibility, and distribution-facing machine interfaces

| Done | ID    | Item                                                             | Owner | Size | Dependencies | Acceptance criteria                                                                                                                                                                                         | Risk   | External |
| ---- | ----- | ---------------------------------------------------------------- | ----- | ---- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| [ ]  | CLI-1 | Merge #179 and close #180                                        | Devin | M    | W1-5         | Batch 6 doctor/status/scan/clean dry-run/inspect/stats/init/help/errors merged; contract tests cover JSON/exit codes and piped human output migration; #180 follow-ups closed.                              | Medium | No       |
| [ ]  | CLI-2 | Schema/config compatibility (#139, #128, #126, #131, #136, #138) | Devin | M    | CLI-1        | `$schema` support and `config.schema.json`; final stream risk tiers and prompt coverage; honest scan status; hardlink/reflink accounting; completions/help/docs aligned; mountinfo caching bounded.         | Medium | No       |
| [ ]  | CLI-3 | Compatibility/downgrade matrix (#192)                            | Devin | M    | W2-3, CLI-2  | Machine-readable version/capability matrix in `docs/users/automation.md` and `sweep doctor --json`; actual 0.5.3/0.5.4 and rc artifacts tested in both directions; additive/strict schema rules documented. | High   | Yes      |
| [ ]  | CLI-4 | Read-only automation contract (#195)                             | Devin | S    | CLI-2        | One-page protocol/threat model; read-only only; redaction/bounds/timeouts; explicit unknown/partial/stale/active states; no MCP implementation or deletion capability.                                      | Medium | No       |

### W5. Widget and Kuwai contract

| Done | ID   | Item                                                          | Owner | Size | Dependencies | Acceptance criteria                                                                                                                                                                                                                                    | Risk   | External |
| ---- | ---- | ------------------------------------------------------------- | ----- | ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------- |
| [ ]  | W5-1 | Rebase/merge initial widget PR #166                           | Devin | M    | CLI-2        | `sweep widget --json` remains read-only; stale/missing/partial/error states distinct; cache mode/schema/owner checks pass; branch is rebased after the 10-commit drift rather than merged stale.                                                       | Medium | No       |
| [ ]  | W5-2 | Widget lifecycle/cache/receipt authority (#191)               | Devin | L    | W2-3, W5-1   | `active-apply.json` and `last-receipt.json` authoritative; liveness cannot be fooled by PID reuse; cache identity binding and privacy rules; widget/cache JSON never applicable as a plan; malformed/symlink/wrong-owner/oversize/non-UTF8 tests pass. | High   | Yes      |
| [ ]  | W5-3 | Update Kuwai integration contract in `.plans/kuwai-island.md` | Devin | S    | W2-1, W5-2   | Scan lifecycle and apply lifecycle are separate; cgroup scope teardown, parent-death model, receipt staleness, cache paths, and `--view` invocations match implementation; no deletion action is exposed from the island.                              | Medium | No       |
| [ ]  | W5-4 | Kuwai panel implementation coordination                       | Devin | L    | W5-2, W5-3   | Sweep-side contract fixtures are published; Kuwai consumes only documented files/commands; `kuwai-check` proves zero orphan processes, 0% idle CPU, correct AC/battery scan policy, and correct stale/error rendering.                                 | Medium | No       |

### W6. Read-only Space report

Implement the Space plan's read-only core, not its destructive phases. Relevant
source plan: `.plans/space-report.md`. Issue #140 is the tracking issue even
though its title still says `sweep report`; implementation uses `sweep space`.

| Done | ID   | Item                                                                              | Owner | Size | Dependencies | Acceptance criteria                                                                                                                                                                                                                                     | Risk   | External |
| ---- | ---- | --------------------------------------------------------------------------------- | ----- | ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| [ ]  | SP-1 | Space Phase 0a guardrail hardening and Phase 0b decision-log/product docs         | Devin | M    | W2-7         | Prefix blocks and product/decision docs match `.plans/space-report.md`; `/var/www` and `/usr/local` behavior preserved; destructive `~` refusals tested in both engines.                                                                                | High   | Yes      |
| [ ]  | SP-2 | Space Phase 1 protocol/schemas/read-only guard/L4 cache contract                  | Devin | M    | SP-1         | Draft 2020-12 schemas validate exactly 11 unique categories; actions empty for non-local/incomplete scopes; additive `ScanPlan` policy profile remains standard-only; redaction is typed and closed.                                                    | Medium | No       |
| [ ]  | SP-3 | Space Phase 2 Rust engine walker and `scripts/bench-space.ts`                     | Devin | L    | SP-2         | Single-pass bounded walker; invoking-user isolation; Linux mount identity, macOS TCC/APFS rules, Windows known-folder/cloud-recall rules; measurement-only network/FUSE with zero actions; benchmark evidence recorded.                                 | High   | Yes      |
| [ ]  | SP-4 | Space Phase 3 CLI `sweep space`, JS fail-closed fallback, display renderer, cache | Devin | L    | SP-3         | `sweep space [path] --json/--json-stream/--redact/--metric/--no-cache` works; zero destructive flags; JS fallback refuses unqualified platforms/mounts; shell completions and docs examples execute.                                                    | High   | Yes      |
| [ ]  | SP-5 | Read-only `SpaceView` subset                                                      | Devin | L    | SP-4, TUI-8  | `sweep ui --view space` and home routing render the 11-category read-only view at 80/100/120 and narrow fallbacks; no destructive action, no `c` handoff, and incomplete/non-local coverage disables actions by absence rather than refusal copy alone. | Medium | No       |
| [ ]  | SP-6 | Explicitly defer destructive Space phases                                         | Devin | S    | SP-5         | `.plans/space-report.md` and release notes state phases 4a/5a/6a are not in 0.6.0; schema keeps `space_handoff` out of accepted apply authority.                                                                                                        | Low    | No       |

### W7. Scale, performance, and remaining ledger gates

| Done | ID     | Item                                        | Owner | Size | Dependencies   | Acceptance criteria                                                                                                                                                                                             | Risk   | External |
| ---- | ------ | ------------------------------------------- | ----- | ---- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| [ ]  | PERF-1 | G2a measurement baseline (#111, #196)       | Devin | M    | W1-5           | Per-stage harness measures discovery, sizing, transport, UI ingest, first row/paint, completion, preparation, removal, cancellation settle, RSS/FD/process counts; baseline commit and machine recorded.        | Medium | No       |
| [ ]  | PERF-2 | G1 shadow/differential paging               | Devin | L    | TUI-8          | Native index owns queries/aggregates in shadow mode; explicit-ID compilation at review; cursor continuity/range/filter parity differential tests; feature flag off by default unless green before pre mode.     | High   | Yes      |
| [ ]  | PERF-3 | G1 default-on decision and migration        | Devin | M    | PERF-2         | If enabled, paging is default only after goldens/PTY/stress tests pass; otherwise this item is explicitly deferred in release notes without blocking promotion.                                                 | High   | Yes      |
| [ ]  | PERF-4 | G2b scale/cancellation qualification (#196) | Devin | L    | PERF-1, PERF-2 | Real allocated trees measured on named hardware; largest real allocated-byte run recorded; sparse runs labeled sparse; regression band is p50 >25% worse on same machine/profile; cancellation settle measured. | Medium | No       |
| [ ]  | PERF-5 | G4 stalls/lifecycle residual closure        | Devin | M    | W2-1           | Progress-aware stall detection, bounded child shutdown, no post-mutation retry/fallback, async probes, fatal-render teardown tests.                                                                             | High   | Yes      |

### W8. Distribution, installers, and release pipeline

| Done | ID     | Item                                                                  | Owner | Size | Dependencies | Acceptance criteria                                                                                                                                                                                                                | Risk   | External |
| ---- | ------ | --------------------------------------------------------------------- | ----- | ---- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| [ ]  | DIST-1 | Release pipeline follow-ups (#153, #172)                              | Devin | L    | W1-3         | Attestation, historical asset matrix, concurrency, clean pack, npm error taxonomy, no-op reconcile behavior, trusted-publishing bootstrap, and stale-run protection are fixed with tests.                                          | High   | Yes      |
| [ ]  | DIST-2 | Release state machine/channel drift (#194)                            | Devin | L    | DIST-1       | Recorded state per channel keyed by version/commit/artifact manifest; read-back integrity; no stale retry rewinds stable pointers; cross-channel report covers npm/tags/GitHub/Homebrew/Scoop/AUR/winget/mise/aqua/docs/Kuwai pin. | High   | Yes      |
| [ ]  | DIST-3 | Homebrew/Scoop hardening and rebase #85 AUR                           | Devin | M    | DIST-1       | Existing Homebrew/Scoop prerelease skip remains; #85 either rebased green or superseded; AUR build/install tested in clean Arch container; no stable manifest moves for rc.                                                        | Medium | No       |
| [ ]  | DIST-4 | winget, mise, aqua channels                                           | Devin | M    | DIST-2       | Unsigned manifests/scripts are validated in clean Windows/Linux/macOS environments; identifiers and ownership documented; moderated-listing state reported honestly rather than claimed as availability.                           | Medium | No       |
| [ ]  | DIST-5 | Installer and platform qualification (#132 parts, AU11-AU14 residual) | Devin | L    | W1-2, DIST-1 | `install.sh` staged probe/.gz/retry/v-prefix/musl; `install.ps1` + Scoop; glibc 2.17 and musl smokes; production `NODE_ENV`; prepack manifest hygiene; no broken Nix default package.                                              | High   | Yes      |

### W9. Website, docs, SEO, and user-facing truth

| Done | ID    | Item                                                            | Owner                   | Size | Dependencies                            | Acceptance criteria                                                                                                                                                                     | Risk   | External |
| ---- | ----- | --------------------------------------------------------------- | ----------------------- | ---- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| [ ]  | DOC-1 | 0.5.4 README/docs refresh follow-through (#182)                 | Devin                   | S    | 0.5.4                                   | Windows check explained/fixed; refresh merged or superseded; 0.6.0 docs branch starts from that state.                                                                                  | Low    | No       |
| [ ]  | DOC-2 | Landing/docs accessibility and performance (#134, #135, AU26)   | Devin                   | M    | TUI-8                                   | Focus restoration and 320px layout fixed; initial-load JS budget enforced; CSS tokens unified; docs build/prerender pass in isolation.                                                  | Medium | No       |
| [ ]  | DOC-3 | User docs/examples (#136, #127 copy, Space/widget/release docs) | Devin                   | M    | CLI-2, SP-5, W5-2                       | Every documented command is executed; dangerous cloud-sync rationale explained; one reclaimable definition everywhere; automation/schema/widget/space/release rollback docs match code. | Medium | No       |
| [ ]  | DOC-4 | SEO plan execution from `.plans/docs-seo-2026-11-27.md`         | Devin                   | M    | DOC-2                                   | SEO items 1-7 implemented with #134/#135 inside the relevant items; generated metadata validated; no unshipped feature claims.                                                          | Low    | No       |
| [ ]  | DOC-5 | Final Antigravity UI/README/docs review                         | Antigravity-2 Neon high | M    | All implementation work before final rc | Review report attached to final rc PR or release issue; only regressions block promotion; copy and visual evidence match the exact rc commit.                                           | Medium | No       |

## Merge order and dependency graph

Merge bottom-up. Rebase stacked PRs after their base lands; do not merge a green
check run from an old SHA as proof for a new head.

```text
0.5.4: #158 + advisories + #182
  -> W0 ledger hygiene
  -> W1-1 Bun -> W1-2 Rust/Zig -> W1-3 Changesets -> W1-4 TypeScript -> W1-5 #114
  -> W2-1 lifecycle -> W2-2 locks -> W2-3 journals
       -> W2-4 identity -> W2-5 containment -> W2-6 consent core
       -> W2-7 Windows/WSL/path -> W2-8 follow-ups -> W2-9 adversarial fixtures
  -> CLI-1 #179/#180 (may parallel W2 after W1)
  -> TUI-1 #163 -> TUI-2 #167 -> TUI-3 #178 -> TUI-4 #184
  -> W1-6/TUI-5 OpenTUI 0.9
  -> TUI-6 Batch 3 -> TUI-7 Batch 4 -> TUI-8 Batch 5/#176 -> TUI-9 G7
  -> CLI-2 -> CLI-3 -> CLI-4
  -> W5-1 #166 -> W5-2 widget authority -> W5-3/W5-4 Kuwai contract
  -> SP-1 -> SP-2 -> SP-3 -> SP-4 -> SP-5 -> SP-6
  -> PERF-1 -> PERF-2 shadow; PERF-3 only if green; PERF-4/5 qualification
  -> DIST-1 -> DIST-2 -> DIST-3/DIST-4/DIST-5
  -> DOC-2/DOC-3/DOC-4 -> DOC-5 final review
  -> enter rc pre mode
```

Parallelism allowed only when file ownership is disjoint: CLI-1 can parallel
W2 after W1; DIST-1 design can parallel late UI work; DOC-2 can parallel Space
implementation. Do not parallel authority changes with UI batches even if files
do not overlap.

## RC release process

### One-time pre-mode setup

1. Confirm DIST-1/DIST-2 and W1-3 are merged; the pipeline must understand
   `0.6.0-rc.N` and npm `next` before pre mode starts.
2. From clean `origin/main`:
   ```sh
   git switch -c release/0.6.0-rc origin/main
   bunx changeset pre enter rc
   git add .changeset/pre.json .changeset/config.json
   git commit -m "chore: enter 0.6.0 rc prerelease mode"
   gh pr create --title "chore: enter 0.6.0 rc prerelease mode"
   ```
3. Merge that PR. Do not manually edit versions.

### For each rc

1. Ensure every merged feature PR since the last rc has a changeset. In pre
   mode, applied changesets remain represented according to Changesets pre-mode
   rules; `.github/workflows/release.yml` already accounts for `.changeset/pre.json`.
2. Let the existing Changesets workflow create/update `chore: version packages`.
   Inspect the diff: expected version is `0.6.0-rc.N`, native package versions
   are synchronized by `bun run sync-engine-versions`, and no stable package
   manifest moved.
3. Merge the version PR. `release.yml` must:
   - run native-engine builds when release intent requires them,
   - run `bun run scripts/publish-release.ts`,
   - pack `@kitsunekode/sweep` from the exact commit with embedded `gitHead`,
   - publish native packages before the CLI,
   - publish the CLI tarball to npm dist-tag `next` (after W1-3),
   - create/verify the scoped tag only at the npm `gitHead` commit,
   - reconcile the public `v0.6.0-rc.N` tag through `apps/cli/scripts/reconcile-release.ts`.
4. `cli-binaries.yml` attaches verified standalone binaries to a GitHub
   prerelease. `release-downstream.yml` may attach prerelease assets, but its
   existing prerelease guard must continue to skip stable Homebrew/Scoop.
5. AUR, winget, mise, and aqua stable channels are not updated for rc. If a
   maintainer manually tests an rc package recipe, keep it local or in a clearly
   separate prerelease channel; do not submit it as stable.
6. Install and qualify the exact rc from the registry and binaries:
   ```sh
   npm view @kitsunekode/sweep@0.6.0-rc.N version gitHead dist-tags --json
   npm install -g @kitsunekode/sweep@next
   sweep --version
   sweep doctor --json
   ```
7. Record the rc evidence in the release tracking comment/issue: exact commit,
   npm gitHead, workflow run IDs, asset checksums, install matrix, test matrix,
   known failures, and whether each gate passed or was explicitly not yet run.

### Final promotion

1. After all promotion criteria pass on the final rc commit, create a small PR
   that runs `bunx changeset pre exit` and contains only pre-mode exit plus any
   final release-notes/changeset metadata.
2. Merge it, let the version PR produce exactly `0.6.0`, inspect it, and merge.
3. The same pipeline publishes `0.6.0` with npm dist-tag `latest`, creates the
   scoped/public tags at the verified npm `gitHead`, attaches final GitHub
   release assets, and then updates stable downstream channels.
4. Do not reuse or move any rc tag. Do not delete tags. The stable release must
   be a forward commit on canonical main.

## Promotion criteria

Promotion requires all of these on the **same final rc commit**:

- [ ] Hosted CI green on exact SHA, including Linux x64/ARM64, macOS ARM64/Intel, Windows x64, Rust, docs, and package workflows.
- [ ] `bun run check`, `bun run rust:check`, `bun run fixtures:sync`, `bun run fixtures:validate-goldens`, and `bun run verify --all` pass in fully isolated `/var/tmp` HOME/TMPDIR/config state.
- [ ] Installed-from-registry smoke passes on Linux x64, Linux ARM64, macOS ARM64, macOS Intel, and Windows x64; GitHub binary smoke passes on the same matrix.
- [ ] A CentOS 7-compatible glibc 2.17 userland/container smoke passes for the floor claim, a current Debian/Ubuntu container smoke passes for normal GNU Linux, and Alpine/musl smoke passes if musl packages are shipped or mentioned.
- [ ] Interactive TUI confirm/cancel/receipt smoke passes on real Linux, macOS Terminal, and Windows ConPTY; one Windows junction fixture fails closed.
- [ ] Parent-death/host-kill test from #185 passes; no `sweep-engine` orphan continues deletion after host death.
- [ ] Apply lock, journal, confirmation, engine identity, and destructive boundary adversarial suites pass with zero canary deletion.
- [ ] One macOS `~/Library` cloud-sync/protected path remains dangerous; selection diff records zero unexpected safe additions.
- [ ] Widget contract tests pass and Kuwai `kuwai-check` evidence shows zero orphan processes and correct stale/error rendering if the panel is advertised.
- [ ] Read-only `sweep space` and `SpaceView` pass schema, privacy/redaction, mount-boundary, non-local zero-action, and docs-example tests; no destructive Space action exists.
- [ ] Performance baseline is recorded. Regressions beyond the agreed band are fixed or explicitly documented; no unsupported 200-600 GiB claim appears.
- [ ] npm trusted publishing, attestations, exact optional native dependency versions, executable modes, archive safety, gitHead, tag ancestry, and registry read-back all verify.
- [ ] Docs, README, website, SEO, and examples match the exact rc behavior; Antigravity-2 Neon high final review is complete.
- [ ] Milestone contains no open issue planned for 0.6.0, or the owner explicitly approves each deferral in writing in the release PR.

## Quality gates and commands

Run all commands with isolated state unless explicitly testing installation:

```sh
root="$(mktemp -d /var/tmp/sweep-check.XXXXXX)"
mkdir -p "$root/home" "$root/tmp" "$root/config" "$root/xdg"
env HOME="$root/home" TMPDIR="$root/tmp" \
  SWEEP_CONFIG_DIR="$root/config" XDG_CONFIG_HOME="$root/xdg" \
  bun run check
env HOME="$root/home" TMPDIR="$root/tmp" \
  SWEEP_CONFIG_DIR="$root/config" XDG_CONFIG_HOME="$root/xdg" \
  bun run rust:check
env HOME="$root/home" TMPDIR="$root/tmp" \
  SWEEP_CONFIG_DIR="$root/config" XDG_CONFIG_HOME="$root/xdg" \
  bun run verify --all
```

Required evidence categories:

- **Tests/goldens:** `bun run fixtures:sync`, `bun run fixtures:validate-goldens`,
  focused UI suites, protocol/schema contract tests, docs link check.
- **Fuzz/soak:** adversarial protocol fragmentation, malformed plans/configs,
  long-running scan/apply cancellation soak, watcher/cache staleness, repeated
  resize/keyburst/mouse events.
- **Fault injection on delete boundaries:** kill host/engine before intent,
  after intent, during preparation, after first mutation, before receipt, after
  receipt; EPIPE, ENOSPC, fsync/rename failure, locked files, permission loss,
  mount disappearance, and process suspension. Outcomes must be exact and no
  automatic destructive retry may occur.
- **Real hardware smoke matrix:** Linux x64, Linux ARM64, macOS ARM64, macOS
  Intel, Windows x64; plus WSL where relevant, glibc-floor container, Alpine if
  musl is shipped, physical Kitty/tmux/low-color SSH where terminal behavior is
  claimed, and native Hyprland/Quickshell if Kuwai is claimed.
- **Focused smoke commands already in repo:** `python3 scripts/smoke-focused-ui.py`,
  `python3 scripts/smoke-active-ui.py`, `python3 scripts/smoke-apply-pipe.py`,
  `python3 scripts/smoke-engine-binding-ui.py`, `python3 scripts/qualify-linux-deletion.py`,
  `python3 scripts/qualify-linux-mounts.py`, `python3 scripts/resource-stress.py`,
  `bun run scripts/bench-engines.ts`, `bun run scripts/selection-diff.ts`, and
  `bun run scripts/validate-parity-goldens.ts`. Add `bun run scripts/bench-space.ts`
  when SP-3 lands. Record exact flags and fixture roots in the evidence comment.
- **Performance budgets:** use PERF-1 baseline; regression means >25% worse p50
  on same machine/profile or a materially worse peak RSS/FD/cancel-settle result
  without documented justification.
- **Docs examples:** every command in README, user docs, release notes, and
  automation docs is executed in an isolated fixture root.

## Rollback by channel

Never delete or force-move the public `v0.6.0` tag, never rewrite canonical
main, and never reuse an npm version. Rollback is forward correction plus
channel pointer repair.

| Channel               | Rollback                                                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm `latest`          | Repoint dist-tag to the last known-good version: `npm dist-tag add @kitsunekode/sweep@<good> latest`; publish a forward corrective patch/minor. Native engine packages are exact-version dependencies and are not independently rolled back. |
| npm `next`            | Repoint `next` to the last good rc or remove it only if no good rc exists; publish a forward `0.6.0-rc.N+1` rather than reusing a version.                                                                                                   |
| GitHub release/assets | Mark the bad release prominently in release notes, attach corrected assets only through a forward tag, and use release-downstream reconciliation; do not delete protected tags.                                                              |
| Homebrew tap          | Revert the formula commit in `KitsuneKode/homebrew-tap` to the last good version/sha256, then forward-update when fixed.                                                                                                                     |
| Scoop bucket          | Revert `bucket/sweep.json` in `KitsuneKode/scoop-bucket`, then forward-update.                                                                                                                                                               |
| AUR                   | Revert/forward-fix the AUR package commit according to AUR norms; do not hide the bad upstream tag.                                                                                                                                          |
| winget                | Close or supersede the bad manifest submission and submit a forward fixed manifest; do not claim installation until ingestion completes.                                                                                                     |
| mise/aqua             | Revert or forward-fix registry/plugin metadata; verify clean install after the fix.                                                                                                                                                          |
| Docs/website          | Revert the incorrect docs commit or forward-fix immediately; do not leave rollback instructions that contradict package availability.                                                                                                        |
| Kuwai pin             | Repin Kuwai to the last compatible sweep version or mark the panel integration unavailable; never hide stale/unknown state as fresh.                                                                                                         |

## Release-day checklist

- [ ] Confirm final rc commit SHA, npm `gitHead`, scoped tag, public tag, and workflow run IDs all refer to the same commit.
- [ ] Confirm all promotion criteria boxes above on that exact SHA.
- [ ] Confirm `.changeset/pre.json` is removed only by the approved pre-exit PR and final version is exactly `0.6.0`.
- [ ] Confirm npm dist-tags: `latest` points to `0.6.0`; `next` points either to the same or a deliberately newer prerelease policy documented in the release notes.
- [ ] Confirm GitHub release is non-prerelease, assets match the strict checksum manifest, and attestations verify.
- [ ] Confirm Homebrew, Scoop, AUR, winget, mise, and aqua states individually: published, pending moderation, intentionally unsupported, or failed; no vague "available" language.
- [ ] Install from npm and each stable package manager channel that claims support; run `sweep --version`, `sweep doctor --json`, one owned scan, and one interactive confirm/cancel smoke.
- [ ] Publish release notes with fixed issues, known limitations, residual risks, platform support truth, rollback instructions, and exact qualification evidence.
- [ ] Close or defer milestone issues explicitly; update `.plans/remaining-work.md` and this plan's checkboxes with commit SHAs.
- [ ] Announce only after stable channels either verify or are accurately described as pending.

## Owner decisions needed

Only genuine decisions remain. Recommendations are included; everything else in
this plan is already decided.

1. **AU28 boundary beyond the explicitly named channels.** Should mise/aqua and
   running-process/cloud-sync advisory work be treated as 0.6.0 requirements,
   while MCP and #10 stay out? **Recommendation:** yes for mise/aqua and
   documentation-only/read-only advisory groundwork; no MCP server implementation
   and no watch daemon in 0.6.0. #195 is the contract-only deliverable.
2. **AUR/winget identifiers, accounts, and moderation expectations.** Which
   package identifiers/accounts are canonical, and is external moderated-listing
   availability required before the 0.6.0 announcement? **Recommendation:** use
   one owner-approved winget identifier and one owner-controlled AUR account,
   submit them during rc qualification, but report moderation honestly and do not
   block npm/GitHub promotion solely on third-party ingestion unless the owner
   wants channel availability to be a launch gate.
3. **Real hardware assignments.** Which owner machines represent Linux x64,
   Linux ARM64, macOS ARM64, macOS Intel, and Windows x64, and what is the
   largest real allocated-byte tree available? **Recommendation:** assign one
   machine/VM per row before rc.1; if a row cannot be assigned, mark that row
   unsupported or unverified rather than weakening the evidence language.

## Initial checkbox map for milestone issues

This list is intentionally high level; each workstream row above is the unit of
execution and each PR must reference the issue it closes.

- [ ] #111, #114, #125, #126, #127, #128, #131, #132, #133, #134, #135, #136, #137, #138, #139, #140, #141
- [ ] #150, #151, #152, #153, #154, #168, #171, #172, #173, #175, #176, #180, #183
- [ ] #185, #186, #187, #188, #189, #190, #191, #192, #193, #194, #195, #196
- [ ] Open PRs: #85, #163, #166, #167, #178, #179, #182, #184; close/supersede #87 when W1-4 lands; #158 is 0.5.4 only and must not enter the 0.6.0 train.
