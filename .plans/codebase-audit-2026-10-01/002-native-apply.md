# Native apply outcomes and cancellation

- **Status:** done — platform qualification pending
- **Priority:** P1 correctness
- **Scope:** protocol, Rust apply, host adapter, history
- **Created:** 2026-10-01
- **Updated:** 2026-10-02
- **Commit:** uncommitted
- **Depends on:** no additional deletion concurrency

## Problem

`applyPlanWithBackend` in `packages/core/src/engine.ts` reconstructs deletion
success as selected candidates minus failed paths. Rust's nested dedupe means
that list can exceed `report.deletedCount`. Cancellation currently sends SIGTERM
and then SIGKILL after 250 ms in `rust-engine.ts`, preventing a reliable final
report even when disk changes already happened. A02 and A06 in [audit](audit.md).

## Scope and design

Allowed: shared ApplyReport types/schemas, `sweep-types`, Rust apply/CLI,
`rust-engine.ts`, `engine.ts`, focused contract tests, deletion history/display
consumers, and owning lifecycle docs. Preserve existing selection, guardrails,
trash fallback, serial deletion and confirmations. No new delete concurrency.

1. Specify outcomes for every selected candidate: deleted, failed, covered by
   a successfully deleted ancestor, or unattempted. Duplicate selected IDs are
   normalized; unknown IDs retain existing validation behavior. Add optional
   outcome IDs to the report so older producers remain readable. Distinguish
   an interrupted report from an unknown outcome after forced process death.
2. Rust records outcomes at the filesystem operation boundary. Retain original
   candidate identity through revalidation and nested dedupe. The host uses
   those IDs for callbacks/history rather than inferring success from absence
   of failures. Never invent deletion success for legacy reports with ambiguous
   counts; return a visible limitation or disable per-item success callbacks.
3. Add a portable cooperative cancellation control channel. A new explicit
   apply stream mode may accept a bounded plan line followed by a cancel line;
   the native reader owns an atomic stop flag, checked before each next delete.
   Keep old EOF-delimited apply compatible. Let an in-flight directory delete
   finish, then emit the complete outcome partition and final report.
4. Abort in the host writes cancellation and drains the final report. A watchdog
   handles stuck filesystems but must report unknown outcomes if forced kill
   is needed. Do not automatically retry destructive operations. Unix signal
   handling can complement the channel; Windows process.kill(SIGTERM) is not
   a portable graceful-cancellation mechanism. Verify real Windows behavior.
5. Make CLI exit status, UI interrupted feedback and history agree with the
   returned outcomes. Document estimates versus observed removals.

## Tests and completion

Use disposable trees: parent/child selections, duplicate paths, mixed failed
revalidation, a successful delete followed by cancellation, cancellation before
starting, broken control channel, and a stuck-child watchdog. Assert selected
IDs partition exactly once and all callbacks/counts/history agree. Exercise
both engines and OS runners. Run `bun run check`, `bun run rust:check`, and
native contract integration tests. Do not call cancellation complete on Windows
without executing the cooperative path there.

STOP if the channel cannot preserve the plan validation boundary, if any test
requires real user files, or if another actor owns these paths. Refresh the
shared diff first; do not commit, merge, publish or overwrite unrelated work.

## Execution evidence

Implemented and checked in the authorized inline remediation. See
[remediation](remediation.md) for behavior, regressions, measurements and limits.
The design above records the original intent; owning current behavior is in
[architecture](../../.docs/architecture.md). No commit or publish was performed.
