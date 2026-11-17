---
"@kitsunekode/sweep": patch
---

`sweep status [path]` says what you could free right now: the total, which
kinds hold it, the idle projects holding the most, and how many items are
protected. `--json` emits that as a small summary (a few hundred bytes, not a
whole plan), for status lines and widgets. Only safe and caution items count
as space; dangerous and blocked ones are reported separately and never added
to a size. It is read-only.
