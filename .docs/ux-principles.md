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
explicit `q`. An accidental `esc` must never destroy review context or exit
the process.

## 3. Nothing destructive is automatic

- Scan, plan, and review are read-only. Deletion requires `Enter` on a
  non-empty selection.
- Bulk select (`a`) covers safe + caution only. Dangerous-tier items enter a
  selection only through deliberate per-item toggles.
- Dangerous selections trigger a red confirmation naming the count and stating
  irreversibility before any deletion begins.
- Blocked items (VCS internals, protected roots) cannot be selected in any
  mode.

## 4. The screen answers three questions at all times

1. What am I looking at? (mode chip + pane titles)
2. What happens if I press Enter? (selection tally + confirm gate)
3. How do I get out of here? (footer hints; `?` for the full map)

## 5. Streaming, not blocking

The UI mounts immediately and fills in as data arrives. Long work shows live
progress (`SCANNING` chip, growing counts). A spinner over a frozen screen is
a bug, not a loading state.

## 6. Mouse is a peer, not a fallback

Rows scroll, hover, click-to-focus, and toggle on click. Headers collapse on
click. Keyboard remains sufficient for every action.

## 7. Feedback beats silence

Every accepted key either changes the screen or updates the statusline. Silent
no-ops are bugs (e.g. `Enter` with an empty selection does nothing _visibly_
— the tally reads "nothing selected" so the reason is on-screen).
