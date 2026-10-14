Status: in_progress
Scope: bounded folder navigation, cursor continuity and terminal sidebar clarity
Created: 2026-10-12

# Review navigation

Use the existing validated index/page owner. Do not feed a partial page into the
production UI's all-candidate reducers or change deletion authority.

1. Page immediate folder children with authoritative descendant totals. Include
   the target-root items separately, reject prefix siblings, and bound temporary
   aggregation and response size. Verify every folder receipt using host witnesses.
2. Seek an artifact ID in the current query and keep a cursor across page movement,
   selection and retirement. A missing cursor falls to a nearby reviewed row; it
   never changes a single-item confirmation into a queue confirmation.
3. Preserve locale-aware item ordering through explicit host-supplied name ranks,
   including collation-equivalent names and age/size ties. Do not introduce an
   implicit byte-order replacement.
4. Review and improve the production sidebar: distinguish browsing, folder
   expansion and queue state; show full current-folder context and concise key
   guidance. Use terminal cells and existing theme/motion tokens.
5. Verify native/host reference parity, narrow/empty/long-name/large-folder renders,
   repeated navigation and child cleanup. Run check, rust:check and the clean-source
   verification ladder, then commit, push and inspect exact-SHA hosted CI.

The production migration remains blocked until grouped rows, range/filter bulk
actions and progressive handover preserve the complete current behavior. Initial
scan/snapshot peak memory and real allocated 200–600 GiB deletion are separate gates.

Requested design skills apply to the folder-review flow. Browser CSS, DOM/ARIA,
touch and screen-reader claims do not apply automatically to OpenTUI. Keyboard
navigation, Unicode cells, text/shape cues, contrast and animation pause must be
verified in the terminal. Keep row movement, disclosure, confirmation and resizing
instant; moving targets during review would add risk. Loading uses the existing
160 ms activity cadence with static progress/labels when animation is paused.

## Checkpoint 2026-10-14

Implemented: bounded immediate-folder pages in the native index and validating
host owner; synthetic reference parity, malformed-reply rejection, explicit
selection/retirement and child cleanup. The production TUI still uses the full
candidate graph. Cursor seek, locale collation ranks, grouped artifact pages,
range/filter parity and progressive handover remain open; steps 2 and 3 above
are not complete.

The production folder review now separates checkbox selection, expansion,
navigation cursor and the active view. Ctrl+K / F2 searches actions; menu text
cannot invoke background shortcuts. Mouse controls activate on left release,
and scrollbar cells have fixed geometry. The repeated sidebar risk summary and
redundant toolbar clear action are removed. Details and confirmation stay
scrollable; confirmation captures the exact plan, puts paths before optional
policy text and survives resize. Fresh interactive scans start unselected.
Only appearance settings persist. An optional size override belongs to one
review and resets on closure; mandatory guards remain enforced.

Required check and rust:check passed locally. Linux real-PTY tests passed for
native and JS size refusal/override, one-item scope and preserved remaining
queue. Clean-source/release-shape verification and exact-SHA hosted results are
recorded in the final verification receipt, not inferred from focused tests.

See [terminal review evidence](terminal-interface-review-2026-10-14.md).
