---
"@kitsunekode/sweep": minor
---

Make deletion byte ceilings opt-in: the default is now `null`, existing numeric
caps remain enforced, zero remains a zero-byte cap, and `--max-size-gb` accepts a
per-run GiB ceiling or `none`. Dry-run previews no longer require destructive
permission flags. Path, identity, mount and resource guards remain enforced.

Fix final JSON delivery on slow consumers and late broken-pipe failure reporting,
route deletion progress to stderr, and add retry guidance to JSON errors. Reject
unknown native plan/options fields, unsafe protocol integers and untrusted config
shapes. Freeze native deduplication keys and preserve valid deletion receipt owners.

Use binary size units, clarify cancellation feedback, improve reader diagnostics
and allow installed-engine fallback after extraction errors. Update fast-uri,
crossbeam-epoch and anyhow within their compatible ranges for security advisories.
