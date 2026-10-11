Status: done
Scope: writing in changed confirmations, receipts, README and public guides
Created: 2026-10-11
Updated: 2026-10-11
Commit: checkpoint based on bda7c82; see git history

# Writing review

Applied `better-writing` to the changed strings. Vocabulary: artifact, candidate,
queue, reviewed path, permanent deletion, local trash and final outcome. Review
covers these changes; it is not a certification of every error in the repository.

| Severity | Location                                                   | Before                                     | After                                                         | Why                                                            |
| -------- | ---------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------- |
| HIGH     | packages/ui/src/app.tsx:388; docs/users/safety.md:56       | Small link rows resemble small directories | Link-only confirmation, destination contents stay             | Explain the actual destructive scope before consent            |
| HIGH     | packages/ui/src/app.tsx:459; README.md                     | Trash described only as reversible         | Manual restore; storage remains occupied                      | State the recovery mechanism that exists                       |
| HIGH     | packages/ui/src/app.tsx:463                                | No dangerous items                         | No items classified dangerous; permanent deletion has no undo | Classification is not a guarantee that contents are disposable |
| HIGH     | packages/ui/src/app.tsx:488                                | Inspect path clipped in a single line      | Full path wraps in a scrollable inspector                     | Keep the reviewed identity readable                            |
| MEDIUM   | packages/ui/src/app.tsx:998; docs/users/troubleshooting.md | Receipt identifies only a count            | Reviewed path plus remaining queue and outcomes               | Distinguish same-named siblings and recreated entries          |
| MEDIUM   | README.md                                                  | Instant startup claim                      | Describe the generated-artifact cleanup task                  | Keep claims within measured evidence                           |

Verification: successive same-named link removals retain distinct IDs and receipts;
the long-path inspector test checks rendered text; narrow OpenTUI rows retain
sizes; dry-run says that no files will be removed. Manual trash guidance was
checked against the implemented holding-directory/payload layout. No server or
CMS strings are involved. Long footer receipts can still clip; the inspector is
the full-path review surface. Broader error-remediation coverage remains open.

Approve the inspected changes.
