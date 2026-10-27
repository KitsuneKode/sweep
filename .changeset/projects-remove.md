---
"@kitsunekode/sweep": patch
---

The projects view can remove things directly: `x` on a project reviews just
that project's removable items (never dangerous ones), and `x` on an item
reviews that item; whatever else is queued stays queued. The footer shows `a`
to queue everything removable and, once something is queued, `c` to review
and `u` to clear. Review dialogs name what they remove, the help lists the
keys inside a review (y remove, t trash, esc cancel), and the message after a
removal says what went and what it freed, leaving out zero counts.

A first look gets one plain line above the footer (space picks, c shows what
would go, nothing is deleted until y) until something is queued. The next
step in the footer is drawn in the accent, and `? keys` always fits.
