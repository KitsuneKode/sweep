# sweep TUI design system

## Intent

Quiet utilitarian terminal for artifact cleanup review. Structure in muted gray; meaning in restrained semantic color. Users scan, tune patterns, select safely, apply.

## Palette

### Dark (default)

- Canvas: `#090b10`
- Surface: `#10141c`
- Surface inset: `#0c1018`
- Border soft: `rgba(148, 163, 184, 0.14)`
- Border focus: `#d97706`
- Text primary: `#e2e8f0`
- Text secondary: `#94a3b8`
- Text muted: `#64748b`
- Accent: `#d97706`
- Positive (safe): `#34d399`
- Warning (caution): `#fbbf24`
- Danger: `#f87171`
- Blocked: `#a78bfa`

### Light

- Canvas: `#f7f6f3`
- Surface: `#ffffff`
- Surface inset: `#f9f9f8`
- Border soft: `rgba(0, 0, 0, 0.06)`
- Border focus: `#956400`
- Text primary: `#111111`
- Text secondary: `#787774`
- Accent: `#956400`

## Depth

Borders-only. No drop shadows. One-pixel soft borders between panels; accent border on focused panel.

## Typography

Fixed-width byte column (7 chars + unit). Risk markers: `·` safe, `?` caution, `!` dangerous, `×` blocked. Selection: `[ ]` / `[x]`.

## Spacing

OpenTUI base unit `1` for padding and gap.

## Layout

Header (title + stats) | body (scope sidebar + list) | context | footer (contextual shortcuts).

Body is a horizontal split when `width >= 72`:

- **Scope sidebar** — fixed width (`28` at `width >= 100`, else `22`)
- **Review pane** — filter input, bordered artifact list (or pattern editor), risk filter hint

## Scope sidebar (ghui / hunk pattern)

**Do not use `<select>` for scope navigation.** `<select>` is a dropdown picker; it fights global keymaps, truncates labels badly, and reads as the wrong control.

**Use instead:**

- `ScopeSidebar.tsx` — panel header + `scrollbox` list
- `SelectableRow.tsx` — row hover/selection background + mouse handlers (ghui `SelectableRow`)
- `sidebar.ts` — `buildScopeSidebarRows`, index ↔ `scopeFilter` mapping

### Surface

- Background: `tokens.bg` (same as canvas — not `tokens.surface`)
- Border: `tokens.borderSoft`; focused panel → `tokens.borderFocus`
- Padding: `paddingX={1}` `paddingY={1}` inside the bordered box
- Panel label: muted `"scopes"` line above the scrollbox

### Rows

- First row is always **all scopes** (`scopeFilter === null`)
- Then one row per workspace folder from `groupCandidatesByScope`
- Marker column: `·` inactive, `›` active filter (accent)
- Count column: right-aligned with shared `countWidth` (hunk stats alignment)
- Label truncation: 18 chars + `…` when needed

### Interaction

| Input              | Behavior                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| `tab`              | Focus sidebar (`setFocus` syncs `sidebarIndex` to current `scopeFilter`) |
| `j` / `k` / arrows | `moveSidebarCursor` — cursor only, filter unchanged                      |
| `enter`            | `applySidebarScope` — set `scopeFilter`, move focus to list              |
| click              | Apply scope immediately + focus list                                     |

Scroll focused row into view: `scrollChildIntoView(\`scope-row-${index}\`)`.

### State

- `sidebarIndex` — cursor while sidebar focused
- `scopeFilter` — active filter (`null` = all scopes)
- `setScopeFilter` keeps `sidebarIndex` in sync

## Artifact list

- `ArtifactList.tsx` — `scrollbox` + inline `▸` scope group headers in the main pane
- Same row chrome idea as sidebar: cursor `selectionBg`, hover `hoverBg`, click toggles selection
- j/k via `moveCursor` (skips header rows)

## Pattern editor

`<select>` is still acceptable for the **pattern catalog** (true pick-list semantics) when `focus === "patterns"`.

## Keymap

- `keymap.ts` owns global shortcuts; one handler path per `focus` (`search`, `sidebar`, `list`, `patterns`, help, confirm)
- Sidebar must **not** early-return without handling j/k/enter — do not delegate navigation to `<select>`

## Anti-patterns (avoid)

- `<select>` for scope / file / repo navigation sidebars
- Different background color for sidebar vs canvas (“sidebar world” vs “content world”)
- Plain string rows without `StyledText` markers and aligned columns
- stdout spinners while alternate-screen TUI is mounted (stop spinner in `onScanComplete` before `runSweepUi`)

## Signature

Scope sidebar + pattern palette + tabular risk-aware artifact rows.

## Code map

| Module                              | Role                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| `packages/ui/src/ScopeSidebar.tsx`  | Scope panel UI                                           |
| `packages/ui/src/SelectableRow.tsx` | Reusable row wrapper                                     |
| `packages/ui/src/sidebar.ts`        | Row data + index helpers                                 |
| `packages/ui/src/ArtifactList.tsx`  | Main artifact scroll list                                |
| `packages/ui/src/keymap.ts`         | Focus-aware keyboard routing                             |
| `packages/ui/src/state/store.ts`    | `sidebarIndex`, `moveSidebarCursor`, `applySidebarScope` |
