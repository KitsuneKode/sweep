# TUI UX Principles

The interactive UI follows these rules. A change that violates one needs an
explicit decision-log entry, not a silent edit.

## 1. Arrows first, aliases second

Primary navigation must work on the keys every terminal user already knows:
`↑↓`, `Home/End`, `PageUp/PageDown`, `Enter`, `Space`, `Esc`, `Tab`. Vim-style
aliases (`j/k/g/G/h/l`) exist for speed but are never required and never
documented as the primary binding.

## 2. Esc walks back - it never quits

`Esc` unwinds exactly one layer of state per press: modal → panel → risk
filter → scope → text filter → expand groups. Quitting is always the
explicit `q`, or `Ctrl-C` - the one chord honoured in every mode, modal, and
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
  mode - including inside a scope-level bulk queue.
- A visual range (`v`, then `Space`) follows the bulk-select rule: it queues
  safe and caution rows and skips dangerous and blocked ones, reporting how
  many it skipped. A span can never smuggle a dangerous item past the red
  confirm.

- The confirm dialog is where reversibility is offered: `t` flips between
  deleting and moving to trash, and the verb in the dialog always matches
  what will happen.

`x` / `d` on an artifact row or inside `i` inspect requests a confirmation for
exactly that artifact ID. Inspect pins that ID while the overlay is open. This
does not expand to a group, current scope or the existing queue. Header rows,
blocked paths and running/incomplete scans cannot start it. The normal apply
path revalidates the target and candidate at the destructive boundary; no UI
action invokes recursive deletion directly. Concurrent path/mount races remain
a qualification limit, so do not promise absolute deletion immunity.

## 4. The screen answers three questions at all times

1. What am I looking at? (mode chip + pane titles - the artifact pane title
   carries the active scope and risk filter at every terminal width)
2. What happens if I press Enter? (selection tally + confirm gate; the dialog
   names the real verb - delete vs trash - and previews the largest targets)
3. How do I get out of here? (footer hints; `?` for the full map)

Age is the strongest triage signal a cleaner has. Rows show how long ago the
artifact changed, anything touched within the week is tinted, and `o` sorts
stalest first. An unknown modified time renders blank, never as a guess, and
never matches `older:` or `newer:` filters.

The list is for triage, `i` is for trust: the inspect overlay shows the full
path, kind, entry type, queued state, and every reason the scanner flagged
the artifact - the "why" that does not fit a row.

## 5. Streaming, not blocking

The UI mounts immediately and fills in as data arrives. Long work shows live
progress (`SCANNING` chip, growing counts). A spinner over a frozen screen is
a bug, not a loading state.

Live scan delivery waits for a React commit receipt before admitting the next
batch; a bare event-loop turn is insufficient. Receipts are scoped to a scan
generation and released on cancellation/unmount. This bounds outstanding UI
frames, not total candidate memory or physical terminal output. Sizing updates
reuse folder topology only when candidate IDs and paths are unchanged. The
60 ms coalescing window remains; burst frames adapt from 200 up to 2,000 records
to amortize index rebuilding. Candidate lookups share one immutable index per
array revision, and caches are released at generation/session boundaries.

Queue coverage names its units: item count and share of estimated bytes are
different facts. Unknown byte coverage is labeled partial. A queued zero-byte
item must not display as an empty queue. Single-item confirmation names its
scope and the other queued items it leaves behind. Enter inside confirmation
explains `y`; it does not silently disappear or implicitly change scope.
Confirmation requires a committed dialog for the current item/queue; elapsed time
cannot arm unseen consent. Missing single items show an unavailable-item dialog instead of falling back
to a queue dialog. Quitting after an apply reports the session outcomes, including
failures/interruption or an unknown report, rather than calling completed work an
abort. Changing trash mode is an explicit choice in either direction.

## 6. Mouse is a peer, not a fallback

Rows scroll, hover, click-to-focus, and toggle on click. Headers collapse on
click. The scrollbar is a real track: click or drag it to seek the list.
Keyboard remains sufficient for every action.

Scrollbar seek uses OpenTUI's SliderRenderable model: a track press maps the
pointer linearly onto the row index, while a thumb drag preserves the grab
offset and maps the thumb's top over its travel range (`height - thumbHeight`,
not `height - 1` - mapping over the full track leaves the last rows
unreachable). `preventDefault` on press keeps a scrub from starting a text
selection.

## 7. Feedback beats silence

Every accepted key either changes the screen or updates the statusline. A key
that deliberately does nothing must say why via a one-line notice - e.g.
`Enter` on an empty queue explains Space to queue and x to delete this item,
`Esc` with nothing left to unwind flashes `nothing to unwind - ctrl-c quits`.

## 8. Cursor and viewport are one

Wheel scrolling moves the _cursor_, not a detached viewport - `Space`/`Enter`
always act on the row under the cursor, which is always visible. Scrollbar
seeks move the cursor too: a click or drag lands the cursor on the
corresponding row rather than sliding the view under it. The same rule holds
in the scope sidebar (`scrollbox` is `focusable={false}`; an inner handler
swallows wheel events and moves the cursor instead).

Two corollaries that keep the list stable at boundaries:

- The sticky group-header slot is reserved whenever the list can scroll. If
  it mounted only when a header was pinned, its one row would shrink the
  viewport, pull the owning header back into the window, unpin the slot, and
  oscillate forever - this was the end-of-list flicker.
- Hover state must not chase rows during wheel input: repaints slide content
  under a static pointer and re-fire `over`/`out`, so hover-set is suppressed
  briefly after each wheel event (`out` still clears, so nothing sticks).

## 9. Chrome fits the terminal

- Modals clamp to the viewport and scroll their contents when they don't fit.
  A fixed-size dialog in a small terminal is a native crash, not an
  inconvenience - this is a hard invariant.
- Every artifact group emits a header; an orphan row must never read as part
  of the group above it.
- The artifact list and scope sidebar are windowed - only visible rows mount,
  so row rendering costs O(viewport). Folder aggregation and filtering still
  process the retained candidates. Both scrollbars seek the actual cursor;
  resizing keeps the cursor in view. While a scan streams, rows hold discovery
  order; the list re-sorts once on completion so nothing moves mid-cursor.
- Narrow widths degrade by shedding detail (brand → `◆`, stats → queued only,
  footer → minimal hints), never by clipping mid-word.

An incomplete review requires a rescan before applying. Its sizes can be partial
estimates or stale after an apply without authoritative outcomes; do not label
all such totals as lower bounds. A typed refusal before deletion preserves the
queue and review generation.

## Queue clearing and folder movement

`u` clears the entire queue from the artifact or scope pane, including hidden
items, and prevents streaming discoveries from restoring defaults in that scan.
`U` unqueues only currently visible items. Text inputs and pattern editing retain
their own keys. Ctrl+U and Ctrl+D page in either pane without altering the queue.
Right expands a scope and then enters its first visible child;
Left collapses or moves to the visible parent. Streaming sizes preserve folder
identity under the cursor. Rescan and session teardown release retained display,
summary, scope topology and path caches.

Live discovery reuses artifact groups and folder observations. Sizing and
selection update affected ancestors; earlier frame rows remain immutable.
Folder compression is a view, so new siblings can split a displayed chain.
Literal POSIX backslashes remain filename characters in scopes and previews;
only Windows separators are normalized for tree display.

## Apply feedback

Confirmation is compact, shows the exact reviewed selection and keeps long
paths scrollable. A missing byte ceiling is neutral policy information.
Confirm/cancel and stop controls stay outside the scrollable details; PageUp
and PageDown scroll long modal contents without changing the selection.
Preparation and removal show separate progress. Removal percentages count
completed artifact operations, not files or bytes inside a directory; final
success requires the authoritative report. Esc, Ctrl+C and the visible stop
control request cancellation, keep the session open and wait for the report.
Cancellation does not restore contents already removed.
