# TUI UX Principles

The interactive UI follows these rules. A change that violates one needs an
explicit decision-log entry, not a silent edit.

## 1. Arrows first, aliases second

Primary navigation must work on the keys every terminal user already knows:
`↑↓`, `Home/End`, `PageUp/PageDown`, `Enter`, `Space`, `Esc`, `Tab`. Vim-style
aliases (`j/k/g/G/h/l`) exist for speed but are never required and never
documented as the primary binding.

## 2. Esc walks back — it never quits

`Esc` unwinds exactly one layer of state per press: modal → panel → risk
filter → scope → text filter → expand groups. Quitting is always the
explicit `q`, or `Ctrl-C` — the one chord honoured in every mode, modal, and
input, since raw mode gives us no SIGINT. An accidental `esc` must never
destroy review context or exit the process.

## 3. Nothing destructive is automatic

- Scan, plan, and review are read-only. Deletion requires `Enter` on a
  non-empty selection.
- **Every apply confirms.** The dialog is always there; it turns red only
  when dangerous-tier items are queued. A single `Enter` must never be able
  to delete.
- Bulk select (`a`) covers safe + caution only. Dangerous-tier items enter a
  selection only through deliberate per-item toggles.
- Scope rows in the sidebar are checkbox groups: `Space` on a scope queues or
  dequeues its whole subtree. Entering a scope only narrows the view.
- `Enter` fires the apply dialog only when the cursor is on an artifact. On a
  group header (reachable by mouse) it folds the group, same as `Space`.
- Blocked items (VCS internals, protected roots) cannot be selected in any
  mode — including inside a scope-level bulk queue.

## 4. The screen answers three questions at all times

1. What am I looking at? (mode chip + pane titles — the artifact pane title
   carries the active scope and risk filter at every terminal width)
2. What happens if I press Enter? (selection tally + confirm gate; the dialog
   names the real verb — delete vs trash — and previews the largest targets)
3. How do I get out of here? (footer hints; `?` for the full map)

The list is for triage, `i` is for trust: the inspect overlay shows the full
path, kind, entry type, queued state, and every reason the scanner flagged
the artifact — the "why" that does not fit a row.

## 5. Streaming, not blocking

The UI mounts immediately and fills in as data arrives. Long work shows live
progress (`SCANNING` chip, growing counts). A spinner over a frozen screen is
a bug, not a loading state.

## 6. Mouse is a peer, not a fallback

Rows scroll, hover, click-to-focus, and toggle on click. Headers collapse on
click. Keyboard remains sufficient for every action.

## 7. Feedback beats silence

Every accepted key either changes the screen or updates the statusline. A key
that deliberately does nothing must say why via a one-line notice — e.g.
`Enter` on an empty queue flashes `nothing queued — space on a row queues it`,
`Esc` with nothing left to unwind flashes `nothing to unwind — ctrl-c quits`.

## 8. Cursor and viewport are one

Wheel scrolling moves the _cursor_, not a detached viewport — `Space`/`Enter`
always act on the row under the cursor, which is always visible. The scroll
lane is a passive position indicator, not a drag target. The same rule holds
in the scope sidebar (`scrollbox` is `focusable={false}`; an inner handler
swallows wheel events and moves the cursor instead).

## 9. Chrome fits the terminal

- Modals clamp to the viewport and scroll their contents when they don't fit.
  A fixed-size dialog in a small terminal is a native crash, not an
  inconvenience — this is a hard invariant.
- Every artifact group emits a header; an orphan row must never read as part
  of the group above it.
- The artifact list is windowed — only visible rows mount, so render cost is
  O(viewport), not O(artifacts). While a scan streams, rows hold discovery
  order; the list re-sorts once on completion so nothing moves mid-cursor.
- Narrow widths degrade by shedding detail (brand → `◆`, stats → queued only,
  footer → minimal hints), never by clipping mid-word.
