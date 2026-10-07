# sweep — Technical Specification

Implementation contract: behavioral guarantees, guardrails, and output shapes.
User-facing install, flags, and TUI keys live in `README.md` — that table is the
contract; this file is the reasoning behind it.

## Problem

`rm -rf node_modules` does not scale. Developers keep dozens of projects and
monorepos; build artifacts accumulate silently. `find -name node_modules | xargs rm`
is unsafe (no depth guard, follows into the wrong tree) and `npx rimraf` /
`cargo clean` clean one directory, not a project tree.

## Goals

1. **Safe by default** — hard guardrails, confirmation before deletion, and a
   reversible `--trash` mode.
2. **Recursive** — cleans every matching artifact below the target, not just the
   root.
3. **Monorepo-aware** — one pass handles nested packages.
4. **Zero-config** — sensible defaults cover most projects out of the box.
5. **Composable** — `-y` for CI, `--dry-run`/`--json`/`scan --json-stream` for
   scripting, `.sweeprc` for project rules, `plan`/`apply` for deferred runs.
6. **Fast** — single bundle, ~100ms startup, parallel filesystem work where safe,
   optional Rust scan engine via `--engine rust|auto`.

## Non-Goals

- Not a general-purpose `rm` replacement.
- Not a full disk analyzer (no treemap explorer); `sweep ui` is the interactive
  review surface.
- Not a file watcher or auto-cleaner.
- Not responsible for git history or Docker images.

## Behavior flow (`clean`)

```
1. Parse CLI args
2. Resolve targetDir (absolute path)
3. Assert guardrails on targetDir            → exit 2 on violation
4. Load + merge config (defaults ← global ← project .sweeprc ← CLI flags)
5. Validate patterns (assertSafePattern)      → exit 3 on bad pattern
6. Scan targetDir recursively
   - lstat entries, never follow symlinks
   - dedupe inode aliases (dev,ino), count unreadable dirs as skipped
   - compute size estimates (in-process metadata walk; unreadable subtrees
     are flagged `bytesKnown: false` and `bytes` is a floor)
7. Compile selection policy into explicit candidate ids
8. If --dry-run / scan-only: print and exit 0
9. If selected set empty: exit 0 with guidance
10. Assert size guardrail (≤ maxSizeGB)       → exit 2 without --force-large
11. If !--yes: confirmation prompt            → 'n'/empty aborts, exit 1
12. Revalidate each selected path immediately before acting
    - vanished paths, changed types, symlink escapes, containment breaks
      skip that entry and are reported as failures
13. Delete (rm -rf equivalent) or --trash (atomic rename into
    .sweep-trash-<ts>/ with preserved relative path, realpath-containment
    checked after mkdir)
14. Append record to history.jsonl (0600 under 0700 config dir)
15. Print summary; exit 0, or 4 if any deletions failed
```

The TUI (`sweep ui`) is the same scan → select → revalidate → apply engine with
an interactive selection layer; apply always confirms, and dangerous-tier items
require a deliberate per-item toggle.

## Engine contract

`scan → ScanPlan` and `apply plan → ApplyReport` are engine-boundary types in
`packages/protocol`, with JSON Schema artifacts beside them. The JS engine is
the reference implementation; the Rust engine (`crates/sweep-*`) must produce
parity on the wire — same candidates, same order, same summary shape
(`skippedDirs` is omitted at zero on both). Streaming `ScanEvent`s are emitted
on `scan --json-stream` and consumed by the TUI.

`ScanEntry.bytesKnown` (`bool`, optional) reports size completeness: `false`
means part of the subtree was unreadable so `estimatedBytes` is a lower bound
(shown as `~` in the UI); omitted/`true` means the size is complete. When any
candidate is partial, `summary.exact` demotes to `false` even under `--exact`.

`ApplyReport.outcomes` partitions every selected candidate into
`deleted` / `failed` / `covered` (removed because it lived inside another
deleted candidate — `coveredBy` names it) / `unattempted`. `interrupted: true`
marks a report written after cancellation, when `unattempted` holds the
entries that were never scheduled.

## Guardrails

### Hard-blocked `targetDir` (exit 2, not configurable)

- `/` and any path resolving to fewer than 2 segments below root
- `/home`, `/usr`, `/etc`, `/opt`, `/var`, `/bin`, `/sbin`, `/lib`, `/lib64`,
  `/boot`, `/sys`, `/proc`
- `os.homedir()` — the home root itself
- Anything inside `.git`, `.svn`, `.hg`

### Deletion-time guarantees

- `lstat` everywhere; symlinks are unlinked as entries, never followed.
- Revalidation immediately before each delete/trash catches symlink swaps,
  type changes, vanished paths, and containment breaks (canonical ancestors
  must stay inside the target).
- Optional size guardrail: `maxSizeGB` defaults to `null` (no byte cap). A numeric
  ceiling is enforced before removal, with `--max-size-gb` for a deliberate
  per-run policy or `--force-large --yes` to bypass it. Dry-run previews are
  independent of this policy. Zero remains a zero-byte cap.
- Trash moves are rename-only on the same filesystem; EXDEV is reported, never
  silently copy-deleted.
- Ctrl+C mid-apply stops scheduling, lets in-flight work finish, and reports
  exactly what was removed.

### Pattern safety (`assertSafePattern`)

- No `/` at start, no `..`, no NUL, no whitespace; ≤128 chars per pattern.
- Merged pattern lists cap at 512 entries.
- Only names covered by a shipping-default pattern land the `safe` tier.
  Opt-in catalog names (`dist`, `build`, `out`, `coverage`, …) and custom
  patterns land `dangerous` - they can never be bulk-selected or pre-selected.

### Config safety

- `.sweeprc` must be a regular file (FIFOs/devices rejected before read) and
  ≤1 MiB.
- Discovery walks up from the target; later sources merge earlier.
- `maxSizeGB`, `depth`, and other scalars are validated; `ignore` and
  `disabledPatterns` can only narrow, never widen selection.

## Output contract

- `--json` produces machine-readable shapes (`scan`, `apply`, `doctor`,
  `clean`, `inspect`, `stats`, `recover`); fatal errors carry stable codes,
  a retryable indicator and apply outcome certainty when known.
- `scan --json-stream` emits newline-delimited `ScanEvent`s:
  `scan_started`, `candidate_found`, `candidate_updated` (sized enrichments),
  `scan_progress`, and `scan_completed` (always last). The raw engine stream
  batches candidates as `candidates_found`/`candidates_updated`; the CLI
  re-emits them per candidate. A `warning` event is reserved in the schema -
  no producer emits it yet.
- `ApplyReport.failedPaths[].code` is one of: `missing` (vanished before
  delete), `changed_symlink_state`, `changed_entry_type`, `outside_target`,
  `protected_path` (VCS metadata or protected segment), `permission_denied`,
  `busy`, `filesystem_error`.
- Exit codes: `0` success, `1` aborted, `2` guardrail or invalid arguments, `3` config error,
  `4` operation failed, `5` doctor warnings. The Rust engine exits with the
  same codes and the JS wrapper re-throws the matching class, so
  `--engine rust` and `--engine js` agree.
- Non-TTY output disables color and spinners automatically.

## Distribution

- npm: `@kitsunekode/sweep` (bundled ESM, Node ≥20.3.0 or Bun), optional native
  engine packages `sweep-engine-*` per platform.
- Standalone binaries on GitHub releases (Bun-compiled, `--minify`), each with
  a `.sha256` sidecar; `install.sh` verifies the checksum before install.
- Homebrew: `brew install kitsunekode/tap/sweep` — formula auto-bumped by the
  binary release workflow.
- Trusted publishing via OIDC (`id-token: write`); no long-lived npm token.

## Versioning

SemVer: patch = fixes/guardrail tweaks, minor = flags/patterns/config fields,
major = breaking config schema or binary rename.
