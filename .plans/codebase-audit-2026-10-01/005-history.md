# Bounded history reads and honest totals

- **Status:** done — platform qualification pending
- **Priority:** P2 correctness and memory
- **Scope:** history, stats, privacy
- **Created:** 2026-10-01
- **Updated:** 2026-10-02
- **Commit:** uncommitted
- **Effort:** M

## Problem

`readHistory` reads the entire file before applying its 8 MiB tail slice.
Rotation likewise reads an unbounded file and retains only half. The stats
handler passes MAX_SAFE_INTEGER, so the issue is byte retention, not a 200-session
limit. Truncated retained totals must not be presented as lifetime totals. A10.

## Implementation

Allowed: core history and tests, CLI stats/history output and tests, owning docs.
Do not change destructive apply semantics or upload any paths to analytics.

1. Define retained-window reporting explicitly. Add coverage/truncation metadata
   to the reader result without breaking callers unnecessarily. Label current
   stats as retained history; past erased records cannot be reconstructed.
2. Open once, fstat the handle, and read at most 8 MiB from the end with bounded
   Buffer reads. If starting mid-record, drop only the leading partial line.
   Handle UTF-8 boundaries, oversized records, append races and malformed lines.
   Use a no-follow policy where supported and reject non-regular handles. Retain
   0700 directory / 0600 file privacy and best-effort apply behavior.
3. Rotate using bounded tail reads to a unique sibling temp file and atomic
   rename. Define coordination between concurrent appenders and rotation; a
   shared fixed .tmp filename is insufficient. If correctness cannot be proven
   with lock/append protocol, defer rotation rather than losing accepted writes.
4. If lifetime stats are desired, introduce an explicit aggregate with a
   migration start point and reconciliation strategy. Do not infer old lifetime
   numbers from a truncated log. History remains a convenience, not a recovery
   journal or an exactly-once destructive transaction log.

## Verification

Use temporary config roots and sparse oversized files. Test byte-cap enforcement,
multibyte records crossing the cut, missing files, malformed/oversized records,
symlinks, restrictive permissions and concurrent append/rotation behavior. Assert
stats labels and totals describe the retained data. Run `bun run check`.

STOP if reliable concurrent rotation requires a schema/lifecycle redesign outside
this scope. Refresh other work before edits. No real-history cleanup, commit,
merge or publish without explicit authorization.

## Execution evidence

Implemented and checked in the authorized inline remediation. See
[remediation](remediation.md) for behavior, regressions, measurements and limits.
The design above records the original intent; owning current behavior is in
[architecture](../../.docs/architecture.md). No commit or publish was performed.
