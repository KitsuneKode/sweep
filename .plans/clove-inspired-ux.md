Status: in_progress
Scope: product, ui, core
Created: 2026-11-18
Updated: 2026-11-18
Commit: uncommitted

# Clove-inspired review: one number, one insight, one action

Source: a real-machine audit on 2026-11-18 (two disks, `~/Projects` at 89%)
and the storage scanner in Clove 3.4 (clove.kshv.me, demo video in
x.com/kshvbgde/status/2120782192385355974). Notes on what Clove does live in
[.reference/clove-storage-2026-11-18.md](../.reference/clove-storage-2026-11-18.md).

## What the audit showed

`sweep scan ~/Projects --json` (0.5.2) found 4,483 candidates and 67.4 GiB:

| Finding                                          | Evidence                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Most reclaimable space sits in linked worktrees  | 4,263 candidates, 47.2 GiB under `.worktrees/` or `.claude/worktrees/`                 |
| One repository holds 87 worktrees                | kitsunesnipe; 7 branches merged by ancestry, most PRs squash-merged                    |
| Workspace stubs drown the list                   | 3,613 of 4,483 rows are `workspace-stub` `node_modules`, 0.2 GiB total                 |
| Half the machine's junk is outside project trees | pacman 8.7 GiB, AUR builds 9.2 GiB, two bun caches 10 GiB, cargo 3.8 GiB, docker 6 GiB |
| Nothing says _why_ it grows                      | no history of sizes; agent worktrees add ~0.6 GiB each and are never retired           |

Already on main since that build: hero bar by rebuild cost (#102), the bar
lights the kind under the cursor (#95), one reclaimable number (#101),
`sweep status` (#96). This plan does not redo them.

## What Clove's storage screen gets right

1. The scan fills one dithered bar left to right, a count runs up, and one dim
   line names the path being measured. Nothing else moves.
2. Pointing at a part dims the rest and gives one sentence of insight.
3. The footer holds one recommendation and one button. After it runs, the
   next one takes its place, ending at "Nothing else is worth clearing right now."
4. Clearing dissolves the segment from its right edge while the count runs down.
5. The receipt replaces the subtitle: "Freed 31.4 GB · 231.2 GB available".

Sweep's own rules already match the motion stance (animate only during work,
static alternative, keyboard movement instant). The gaps are the unit of
review, the insight sentence and the single next action.

## Phases

### W1 — Worktrees are a unit of review (read-only metadata) — this branch

No new destructive authority. Removal still goes through the existing apply
path and only ever removes artifacts.

- Protocol: two optional, additive candidate fields, passed through the Rust
  types untouched like `projectRoot`:
  - `worktreeOf` — the main work tree when the project is a linked worktree.
  - `worktreeState` — `merged` (branch is an ancestor of the default branch)
    or `upstream_gone` (its tracked remote branch was deleted, which is what a
    merged-and-deleted PR leaves). Absent means unknown or still open; unknown
    is never treated as finished.
- Core: `worktree-info.ts` reads `.git` pointers and `commondir` without
  spawning; per repository (not per worktree) at most two bounded `git`
  calls give the default branch, merged branches and gone upstreams.
  Timeouts and failures leave the fields absent.
- UI: a "Finished worktrees" section above idle, so the clearest space reads
  first; worktree rows name their repository instead of the `.worktrees` path.
- Tests in core (fixture repo with a merged and an open worktree) and UI
  (section ordering, labels).

`worktreeState` is a triage hint, never a safety boundary: what it unlocks is
removal of build output, which is already removable in any project.

Measured on the audit machine (`sweep scan ~/Projects --json`, this branch):
87 worktrees found across 5 repositories, detection 125 ms for 106 project
roots. 8 merged (4.4 GiB), 5 of them quiet for a day and listed as finished
(3.5 GiB). 79 open (43.3 GiB). Cross-checked by hand in kitsunesnipe: of 80
worktree branches 10 are merged locally, 4 more only on the remote, and
**44 were never pushed**. Ancestry is right there (the repo merges PRs with
merge commits); the space is mostly unfinished agent work, not finished work.
No branch reads `upstream_gone` because GitHub's "delete branch on merge" is
off for both repositories; turning it on plus `fetch.prune` makes squash
merges visible without any extra git calls.

One repository (`.worktrees/main-regression-20261007`) is a full clone inside
another repo's `.worktrees`, with 27 worktrees of its own. It is reported as
its own repository, which is correct.

Follow-up (I1): an "abandoned" sentence for worktrees whose branch was never
pushed and that are idle, e.g. "44 worktrees in kitsunesnipe were never
pushed; 31 untouched for 30+ days". Their build output is already covered by
`i`; the sentence is what makes the pile legible.

### W2 — Workspace stubs fold into their install

A `workspace-stub` `node_modules` is listed under the root install it belongs
to, counted once, never its own row. Selection of the root install carries
the stubs. Removes ~80% of rows on a monorepo-heavy tree.

### W3 — Removing a finished worktree (new authority, own PR)

Per remaining-work rule 5 this lands alone. `git worktree remove` (never
`--force`) for a worktree that is `merged` or `upstream_gone`, clean
(`git status --porcelain` empty, checked at the destructive boundary), not
locked and not the current directory. Dirty worktrees are listed with what is
uncommitted and cannot be queued. Receipt names the branch that stays.

### I1 — One insight sentence per part

`insights.ts` grows a sentence builder: the part, its size, and the one fact
that explains it. "Worktrees 47 GiB · 72 in kitsunesnipe, 9 finished."
"`.next` 9.5 GiB · impact-coaching-center, untouched since Oct 12."
The bar's lit kind shows its sentence in the context row.

### I2 — One next action

The footer shows the single largest finished or idle group with one key,
then the next after its receipt, ending with "Nothing else is worth clearing
right now." `i` (idle) stays; this is its sentence form.

### I3 — Why it grows

Keep a size-only snapshot per target (no paths beyond project roots, bounded,
private file like view preferences). `sweep status` and the header say
"+23 GiB in 14 days, mostly .t3/worktrees".

### M1 — Clearing motion

The cleared part's dots go out from its right edge, driven by engine outcome
events, never a timer; the total counts down; `SWEEP_REDUCED_MOTION` shrinks
it in one step. Receipt moves into the header line. Use the existing
`dot-matrix`, `useCountUp` and Kitty image cache; repaint only the bar line.

### C1 — `sweep caches` (separate scope)

bun, npm, pnpm, cargo, go, uv, pip and docker caches through each tool's own
clean command, each row tagged "comes back on its own". pacman is reported
with the `sudo` command, never run.

## Skills workflow for the UI phases

Emil Kowalski's skills target the DOM; tell each one "OpenTUI cells, 160 ms
frame step, EASE_MS 180, SWEEP_REDUCED_MOTION". Order: animation-vocabulary →
find-animation-opportunities / remove-animations (read-only) → animate or
emil-design-eng for M1 → choreograph for the clear sequence → break-ui through
`packages/ui/benchmarks/review-preview.tsx` (Demo, Worst, Empty, One, Huge) →
animation-performance → review-animations as the merge gate.

## Not in scope

- Agent skill and context cleanup: that is kuwai's `kuwai-cleanup`.
- System-wide category bar (Apps, Photos, System data): sweep stays a
  developer-tree tool; kuwai's island can compose `df` with sweep's JSON.
