---
title: Safety, trash and interruption
description: Understand what Sweep checks and where recovery has limits.
---

Sweep treats a match as a candidate for review. Generated names are useful hints,
not proof that every file inside them is disposable. Verify custom names, stop
active builds and keep backups of work you cannot recreate.

## Checks before cleanup

Sweep protects filesystem roots and VCS internals, validates candidate paths and
entry types, rejects blocked selections, deduplicates overlapping candidates and
refreshes sizes at apply. Normal size ceilings require complete refreshed sizing.
Changing a plan's numbers cannot authorize unchecked path traversal.

New scans record the filesystem identity of the root and each artifact. If a
directory or file has been replaced since scanning, apply refuses the changed
entry. Replacing the root refuses the whole apply. Older saved plans without
these snapshots remain inspectable; scan again to create an applicable plan.
These identifiers detect replacement, not every content change inside the same
directory. Preview totals remain estimates, and plans are not authenticated
proof of who created them: review the target and selected paths.

A failed discovery or resource limit does not produce a usable complete plan.
The UI blocks apply and export for that scan generation, including after you
close the error dialog.

These checks reduce risk but do not eliminate every concurrent filesystem race.
Native Linux removal uses directory descriptors and kernel resolution
restrictions to refuse symlinked ancestors and mount crossings, including bind
mounts. It requires `openat2` support and stops at 32 nested directory frames
rather than retaining unlimited handles. A refusal during recursive removal may
leave a partially removed artifact. JS checks the Linux mount table before
removal; it still uses pathname operations, so this is a preflight snapshot,
not atomic containment. Other platforms retain their existing removal paths and
need actual runtime qualification. A leaf name or contents can still change
near an unlink syscall. Avoid cleaning trees whose
paths or mounts are being actively replaced. Do not run as administrator merely
to bypass a refusal.

## Delete versus trash

Permanent deletion removes contents. Trash moves selected artifacts into a
`.sweep-trash-*` directory under the scan target. This is a local holding directory,
not the desktop recycle bin, and it does not free the occupied storage yet.

To recover, inspect the trash contents and move the desired artifact back manually.
On Windows, each reserved trash slot contains a `payload` file or directory;
restore that payload to the original artifact location.
Check its original location first: do not overwrite a newly recreated directory.
There is no documented automatic `undo` command. Remove trash only after you have
verified the recovered project and no longer need those contents.

## Ctrl-C during apply

Sweep requests cooperative cancellation: stop admitting new candidates, allow
the current operation to settle and report outcomes. Cancellation does not roll
back deletions. Reports distinguish deleted, failed, covered by a parent deletion,
and unattempted selections. Keep the final report before retrying.

A failed recursive removal may already have removed some files inside that
artifact. A failed outcome is not a rollback, and an unattempted nested selection
is not proof that its contents survived a failed parent operation. Inspect or
re-scan the tree before retrying.

If a native engine stops responding, the host's watchdog may terminate it and
report an unknown outcome. An OS crash, forced kill or power loss may also prevent
a final receipt. Re-scan the actual tree before deciding what remains; do not
blindly retry an old plan as if no deletion happened.

## Sizes and disk space

Displayed bytes describe a metadata estimate of matched contents. Sparse files,
hardlinks, filesystem compression, snapshots and concurrent changes can make
physical storage reclaimed differ substantially. History reports estimated
removed or moved bytes, not a measured before/after free-space guarantee.

## Interrupted-process journals

CLI apply records intent in the private config directory before removal starts,
then commits outcomes when the engine returns a complete report. Inspect one
with `sweep recover --journal /absolute/path/to/journal.jsonl` (or `--json`).
The command reads receipts; it never restores, unlocks or retries deletion.
An incomplete armed journal reports unknown outcomes. An unresolved apply lock
blocks another CLI apply using that config directory, because a detached engine
may still be active. This cooperative lock does not stop external filesystem
writers or callers invoking the core engine API directly.

A size-ceiling refusal or a lock conflict before removal preserves the TUI scan
and queue. A fresh-size refusal commits an all-unattempted journal; an early
estimate refusal creates no apply journal. Missing or inconsistent final reports
still block another apply until rescan. `doctor --json` reports held apply locks,
and recovery cross-references the journal with its recorded host PID. Neither
command automatically unlocks a crashed session.

Pause builds, package installs and sync tools inside artifacts being removed.
Candidate and ancestor identities are rechecked; interior contents are not a
frozen snapshot. Newly created files may be removed by the active directory walk.
The per-config lock serializes Sweep CLI sessions sharing that config directory;
other users, config directories, native-only invocations and external tools do
not participate. Advisory locks cannot stop arbitrary filesystem writers.

Trash slot identities are checked again before a move. Pathname checks on
Windows/JS still have a check-to-syscall race; they are not a descriptor-pinned
transaction against a hostile writer. Do not use shared writable trash roots.
