---
"@kitsunekode/sweep": minor
---

feat(ui): delete the row under the cursor without leaving the session

`x` (or `d`) on a candidate opens the confirmation dialog scoped to that one
artifact and, on `y`, applies it through the same pipeline as a queued apply -
plan validation, containment, revalidation, type-flip detection, outcome
reporting, and history. Deleted and covered rows leave the list in place;
failed and unattempted rows stay put so they can be retried. `ctrl-c` during an
apply stops scheduling new work while in-flight deletions finish, and the
report still lands. Rows that a parent delete covered come along honestly via
`covered` outcomes.
