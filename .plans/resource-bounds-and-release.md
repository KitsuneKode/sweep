# Resource bounds and release qualification

Status: in_progress
Scope: engine, ui, release
Created: 2026-10-02
Updated: 2026-10-04
Commit: included in the authorized production-qualification checkpoint

October 4 follow-up: [production qualification](production-qualification.md)
records native Linux descriptor removal, actual private bind mounts, installed
Linux tarballs, final streaming fixes, long-session UX and refreshed gates.
Real-platform, adversarial race/crash and publication qualification remain open.

Progress note (2026-10-03): local implementation and required gates passed.
The million-entry fixture, 200 GiB sparse metadata probe, read-only Projects
comparison and real Linux focused-delete PTY smoke passed. The competing session
has been paused by the user and source ownership assigned to this session.
Remaining qualification: hosted Windows/macOS/ARM64, actual installers/consoles,
mount/race containment and registry trusted-publisher configuration.

Goal: keep one-shot scans responsive and bound tree-dependent retained data;
never turn resource exhaustion into a successful partial cleanup plan.
Execution is inline, authorized by the user. Preserve the existing dirty work.

## Architecture and invariants

Both engines use a per-operation budget with candidate, directory admission,
queued directory, inode identity, path byte, and estimated retained byte limits.
Admission happens before insertion. Counts are conservative across the operation:
path and estimated memory charges are not refunded, so a very large operation
may stop even after earlier data was released. Estimated retained bytes are a
logical accounting limit, not a bound on process RSS or a guarantee against OOM.
Discovery retains cumulative admission accounting. Sizing has a separate,
shared live reservation pool across jobs, returning directory/path reservations
when popped and identity reservations at job exit. Saturation makes sizes partial
without starving subsequent jobs or poisoning discovery. Standalone sizing gets
its own default pool.
Resource failure stops scheduling, drains admitted work, and returns an error.
The UI retains its existing incomplete-scan state and refuses apply/export.
Directory enumeration is incremental, with bounded batches for metadata I/O.
Protocol byte counts must fit JavaScript safe integers; overflow fails explicitly.

## Tasks and acceptance

- [x] Add shared limits and budget accounting (`packages/protocol`,
      `packages/core/src/resource-budget.ts`, `crates/sweep-fs/src/budget.rs`).
      Small injected limits must reject before excess insertion, without wrapping.
- [x] Stream JS discovery and metadata sizing (`scanner.ts`); share budgets
      across admitted sizing tasks; close handles on error/abort. Test raw filenames.
- [x] Bound Rust discovery and sizing; consume final candidates and drain the
      sizing map instead of cloning both. Budget errors must prevent final plans.
- [x] Check byte aggregation and untrusted plan numeric boundaries. Overflow
      must never advertise complete/exact totals or start destructive operations.
- [x] Add reproducible resource-pressure qualification and measurements:
      flat/wide shapes, repeated scans, tiny limits, low descriptor limits, slow
      consumers (`scripts/resource-stress.py`). Million-entry disk fixtures
      remain opt-in and require capacity checks; the current million-entry run passed.
- [x] Repair release tag routing, prerelease dist-tags, release serialization,
      and native matrix prerequisites (`apps/cli/scripts/release-policy.ts`,
      `publish-release.ts`, workflow fixes). Test policy without registry writes.
- [x] Document operational limits, remaining pathname race windows, platform
      qualification and staged preview/stable release gates
      (`.docs/resource-limits.md`, `.docs/release.md`).
- [x] Run `bun run check`, `bun run rust:check`, release build and targeted
      resource/engine comparisons. Record evidence separately from hosted CI.

## Review focus and limits of evidence

Do not block all discovery workers on a full producer queue: fail clearly rather
than deadlocking. Resource errors must escape filesystem-error catch blocks.
Native streams must not send a final success after a budget failure. The user
authorized a checkpoint commit on October 4; publish, merge and tag remain
separate. Linux local evidence does not
qualify Windows, macOS, ARM64, terminal emulators, cold network filesystems, or
registry trusted-publisher configuration. Dependencies must not be uploaded
for advisory checking without the previously requested approval.

Current evidence and boundaries: [large-tree qualification](codebase-audit-2026-10-01/large-tree-2026-10-03.md).
Turbo 2.11.7 keeps the experimental Cargo/task-command integration, limits task
concurrency and cache disk use, and avoids cached filesystem/native false passes.
