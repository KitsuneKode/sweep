---
title: Safety and trash
description: Explain what Sweep protects, how trash recovery works, and which checks apply before removal.
---

Sweep separates **scanning** from **applying**. Scans, saved plans, dry runs, and interactive browsing do not write to the scanned tree. `apply` is the only phase that removes selected artifact paths. `sweep recover` only reports journal state. There is no silent undo, repair, or restore mode.

## Protected content

The scanner and apply phase protect these independently of artifact names:

- git-tracked files inside a worktree
- files inside a git repository whose tracked status cannot be verified
- project files such as manifests and `.env*`
- `.git`, `.hg`, and `.svn` internals
- operating-system roots, mount roots, your home folder, and common system folders
- tool and package-manager homes such as version managers, Docker contexts, package caches, and credential folders

A directory candidate containing a `.git` entry is at least dangerous. It is refused in automated `--yes` cleanup unless the operator deliberately includes dangerous candidates and approves their listed paths. Git-tracked content is always blocked. An unknown git check is never treated as clean; it is blocked and checked again during apply.

Sweep does not know which untracked files matter to you. Generated artifacts can contain experiments, scratch outputs, credentials copied by accident, or files that a tool does not recreate. Review every dangerous or unusual path before selecting it. Git protection is a floor, not proof that untracked content is disposable.

## Selection and unknown state

Safe artifacts can be pre-selected because their names are machine-created and canonical. Caution artifacts are visible but not automatically selected. Dangerous artifacts require explicit per-item intent. Blocked artifacts cannot be selected.

Project activity is evidence, not a guess. If no trustworthy activity signal exists, the project shows idle `?` and is never treated as idle. `sweep status` counts only projects with proven inactivity. `--idle` selection also excludes unknown projects.

## Scan scope and symlinks

The scan target itself is not an artifact. Artifact symlinks are scanned as filesystem entries but their targets are never traversed or removed. Deleting a symlink artifact removes only that link.

The scanner does not cross filesystem boundaries. It does not descend through ordinary symlinks. It does not use `..` segments to escape the scan target. Linux native scans use directory descriptors and a path lookup constrained by `RESOLVE_BENEATH` and `RESOLVE_NO_MAGICLINKS` where supported. These controls are one layer of containment, not the whole safety model.

## What apply checks again

Apply validates the complete candidate set before writing a journal. For each selected artifact it verifies:

- the path stays inside the scan target and is not a protected root
- the filesystem identity still matches the reviewed plan or confirmed UI operation
- no selected path is a symlink
- the artifact does not unexpectedly contain project files, nested tool homes, or VCS internals
- repositories are still readable and selected content is not git-tracked
- directories that contained repositories do not gain a new repository interior
- parent and artifact paths have not been replaced to redirect removal

Fresh sizes are measured immediately before apply when a size ceiling applies. The reviewed selection can be stale. A changed or unverifiable artifact is refused rather than adapted silently.

Removal is failure-first: a failed directory operation leaves the artifact in `failed` state instead of falling back to a different filesystem shape. When removing a non-empty directory would remove more entries than the scan observed, Sweep refuses that whole directory. A same-artifact move failure does not silently fall back to copy-and-delete.

## Size and hardlink accounting

`bytes` is apparent size: logical file bytes plus directory metadata. It is the amount the paths appear to occupy.

Package managers can hardlink one store file into several `node_modules` trees. Sweep tracks shared inodes and reports **unique-inode bytes** (`uniqueBytes` per candidate and `uniqueTotalBytes` in summaries). A shared inode contributes only when all observed links are inside the scanned candidates. When shared hardlinks reduce what removal can free, plan reports, `sweep status`, and `sweep ui` show `about X freed` beside the apparent size.

Linux Btrfs, XFS, APFS, and Windows ReFS can also share extents through copy-on-write clones. Those clones do not have cheap portable detection, so Sweep does not promise extent-aware space accounting.

When a candidate containing shared hardlinks cannot be fully sized, Sweep marks unique-byte accounting partial (`uniqueBytesPartial`) instead of silently reporting the apparent total as exact. Interfaces that cannot distinguish that partial state fall back to the apparent total with `shared hardlinks not fully counted`.

`~` means partial or approximate sizing. Status exposes `bytesPartial` and `partialByteCount`, plus skipped-directory coverage. A zero or exact-looking number is not proof that every unreadable subtree was measured.

## Resource limits and scan resource failures

Resource allowances stop runaway scans and removals. `balanced` is the default. `low-memory` lowers scan depth, file, byte, and time allowances, disables whole-project source evidence, and uses conservative scheduling. Neither profile is a size ceiling.

When the scan reaches an allowance, Sweep exits `2` and does not apply that partial scan. A skip caused only by depth is visible as incomplete coverage. If a scan reports a resource limit, narrow the target or choose a larger explicit allowance. Do not treat partial output as a successful cleanup.

## Cloud-synced folders

Candidates under common cloud-sync roots receive a non-blocking `cloud-sync` reason. The scan notice names roots under `~/Dropbox`, `~/OneDrive`, `~/OneDrive - <Org>`, `~/Google Drive`, `~/My Drive`, and macOS `~/Library/CloudStorage/*` when candidates are present.

This notice does not change risk tier or default selection. Pause sync before applying in those folders. A cloud service can recreate, replace, or conflict-copy files while Sweep is measuring or removing artifacts.

## Confirmation and selection authority

Interactive CLI and UI operations confirm the scan target, count, estimated bytes, dangerous artifacts, and deletion mode. The terminal UI captures the candidate IDs visible in that confirmation. Applying does not silently use a newly changed queue.

`--yes` skips the interactive prompt but does not weaken guardrails. Pass `--yes` only after separately reviewing the target and exact selection. `--allow-dangerous` is still required for automated dangerous deletion, and every dangerous path is listed. Blocked paths cannot be authorized.

## Trash behavior and recovery

`--trash` moves artifacts into `.sweep-trash-<timestamp>` inside the scan target. This is not the operating system recycle bin. It still uses disk space.

Trash moves are ordered by depth so nested selected artifacts move with their parent. Before each move, Sweep revalidates the artifact. Because a move creates a new path, an attacker with write access could attempt to race it. Sweep uses targeted rename and descriptor-based controls on supported platforms, but no local trash implementation can make an actively hostile writable directory fully safe.

After a trash operation:

1. Read the apply report or journal.
2. Verify the artifact is gone from its original path.
3. Verify the exact `.sweep-trash-<timestamp>` folder.
4. Copy back anything you need.
5. Delete the trash folder when satisfied.

Interrupting a move can leave an artifact at either location. There is no transaction across independent filesystem operations.

## Journals, locks, and interrupted apply

Apply writes recovery records in a journal before destructive work. Entries are append-only. Write failure closes the operation instead of silently continuing without evidence.

CLI applies hold a cooperative lock. Other CLI instances report `apply_busy`. `sweep recover` reports journal and lock state but never retries, restores, or releases a lock. A PID being absent or reused is not enough to delete a lock safely. If the owner is still running, wait. If you intentionally stop it, inspect the artifacts and then choose the next reviewed operation yourself.

After SIGINT, SIGTERM, process failure, terminal failure, or an uncertain native-engine report, do not assume completion or safety. Use the journal and disk state as evidence, then scan again before retrying. A native engine that crashes or loses its final report makes the outcome unknown even if some deletion already happened.

## Native engine identity and trust

The Rust engine is a high-privilege filesystem component even though Sweep runs unprivileged. On POSIX systems Sweep trusts an engine only when the engine file and every ancestor directory are owned by the effective user or root and are not writable by group or others. When running through `sudo`, the original user from `SUDO_UID` is also accepted for the actual sudo invocation. Generic inherited `SUDO_UID` values do not widen trust.

The engine file content is fingerprinted after the ownership check. Before destructive use, Sweep revalidates metadata and content. On Linux it also compares the running process image identity with the reviewed engine. A changed, replaced, or untrusted engine is refused before removal. If the engine descriptor or process image cannot be rechecked, native apply is conservative.

`--engine auto` falls back to the JavaScript engine with an explicit note. `--engine rust` refuses instead. Homebrew prefixes often use group-writable directories. That is normal for Homebrew, but Sweep treats group-writable ancestry as untrusted and uses the JavaScript engine until permissions are tightened. These checks do not make a compromised user account safe; they prevent writable install locations and replacement races from silently becoming trusted deletion engines.

## Config trust

Automatically discovered `.sweeprc` files, the global config, and their directories are rejected on POSIX systems when owned by another user or writable by other users. Files or directories writable by a non-primary group are rejected. A primary-group group-writable file is accepted.

An explicit `--config` path is still parsed and schema-validated, but discovery ownership rules do not apply to it. Apply creates missing operational state with owner-only permissions and rejects symlinked or group-writable state directories.

## What Sweep does not protect

- files deleted or replaced by other programs while Sweep runs
- untracked work you did not review
- data loss after you explicitly authorize dangerous artifacts
- hostile processes already running as your user
- complete recovery after permanent deletion
- cloud synchronization behavior outside the local filesystem

Sweep reduces accidental cleanup risk. It does not replace backups, version control, or operator review.
