# sweep TUI design system

## Intent

Quiet utilitarian terminal for artifact cleanup review — a trust-first reclaim
tool that feels like a better alternative to blunt disk cleaners (npkill-class).
Structure in muted charcoal; meaning in restrained semantic color; identity in
ember amber. Users scan scopes, tune patterns, select safely, apply.

Who: a developer reclaiming space across a project tree, often a monorepo.
Job: pick the right artifacts, understand risk, free bytes without fear.
Feel: dense like a trading floor for disk, calm like a review pane — not a toy.

## Palette

### Dark (default)

- Canvas: `#090b10`
- Surface: `#10141c`
- Surface inset: `#0c1018`
- Border soft: `#94a3b824`
- Border focus: `#d97706` (ember)
- Text primary: `#e2e8f0`
- Text secondary: `#94a3b8`
- Text muted: `#64748b`
- Accent: `#d97706`
- Positive (safe / to-free): `#34d399`
- Warning (caution): `#fbbf24`
- Danger: `#f87171`
- Blocked: `#a78bfa`
- Selection bg: `#1a1510` (warm tint)

### Light

- Canvas: `#f7f6f3`
- Surface: `#ffffff`
- Surface inset: `#f9f9f8`
- Border soft: `#0000000f`
- Border focus: `#956400`
- Text primary: `#111111`
- Text secondary: `#5c5a56`
- Accent: `#956400`
- Selection bg: `#f5ead4`

## Depth

Borders-only. No drop shadows. Soft borders between panels; ember border + optional `title` on the focused panel (ghui/hunk chrome pattern).

## Typography

Fixed-width byte column (7–9 chars + unit). Compact sidebar bytes (`1.2GB`).
Risk markers: `·` safe, `?` caution, `!` dangerous, `×` blocked.
Selection: `[ ]` / `[x]`. Cursor rail: `│` on the active artifact row.

## Spacing

OpenTUI base unit `1` for padding and gap.

## Layout

```
header (sweep · path · selected / visible / to free)
────────────────────────────────
[ scopes ] [ filter ]
           [ artifact list ]
           risk · … (1-4)
────────────────────────────────
detail (truncated)
footer hints                         selection tally
```

Body is a horizontal split when `width >= 72`:

- **Scope sidebar** — `24`–`32` cols; label + count + compact bytes
- **Review pane** — plain filter input, bordered list, muted risk line

## Scope sidebar

Keep the ghui list pattern (`SelectableRow` + scrollbox). No panel titles, no
in-panel footer hints. One header line: `scopes · N  size`.

Rows: `› label  count  bytes` — no selected-count column (too cramped).

## Filter

Plain `<input>` with live `onInput` → `setFilter`. No bordered filter chrome.

## Risk

Muted one-liner under the list: `risk · all risks  (1-4)`. Keys still work.
No chip bar.

## Footer

Context on its own truncated line. Footer hints on the next line; selection
tally right-aligned. Never put a long path beside the keymap — it collides.

## Code map

| Module                              | Role                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| `packages/ui/src/ScopeSidebar.tsx`  | Scope panel UI                                           |
| `packages/ui/src/SelectableRow.tsx` | Reusable row wrapper                                     |
| `packages/ui/src/sidebar.ts`        | Row data + bytes helpers                                 |
| `packages/ui/src/ArtifactList.tsx`  | Main artifact scroll list                                |
| `packages/ui/src/ReviewPane.tsx`    | Split layout, filter, risk chips                         |
| `packages/ui/src/keymap.ts`         | Focus-aware keyboard routing                             |
| `packages/ui/src/presentation.ts`   | Header / footer / row StyledText                         |
| `packages/ui/src/theme.ts`          | Ember reclaim palette                                    |
| `packages/ui/src/state/store.ts`    | `sidebarIndex`, `moveSidebarCursor`, `applySidebarScope` |
