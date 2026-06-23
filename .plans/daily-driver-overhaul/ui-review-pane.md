# UI review pane — ghui / hunk parity

Status: in_progress
Scope: ui
Created: 2026-06-24
Updated: 2026-06-24
Commit: uncommitted
Parent: [master.md](./master.md)

## Why

The TUI must feel as scannable as ghui/hunk: grouped rows, semantic color, hover,
clear panel focus. The joined-header bug is fixed; remaining work is module depth
and interaction polish.

## Landed

- `packages/ui/src/ArtifactList.tsx` — scrollbox + inline `▸` scope headers
- Risk-colored `StyledText` rows, column header, themed sidebar `select`
- j/k navigation via `moveCursor` (skips headers)

## Steps

### 1. Extract `ReviewPane.tsx`

Move filter input, main bordered panel, risk filter line, sidebar, and pattern
`select` out of `SweepApp`. Shell keeps header, context, footer, overlays,
`useKeyboard`.

```ts
export interface ReviewPaneProps {
  state: SweepUiState;
  plan: ScanPlan;
  tokens: ThemeTokens;
  showSidebar: boolean;
  sidebarWidth: number;
  onMutate: (fn: (s: SweepUiState) => SweepUiState) => void;
  onRequestApply: () => void;
  onFocusPanel: (focus: UiFocus) => void;
}
```

**Verify:** `bun run check`

### 2. Keymap slice

Add `packages/ui/src/keymap.ts` — one handler per focus (`search`, `sidebar`,
`list`, `patterns`, `help`, `confirm`). `SweepApp` dispatches by `state.focus`.
Mirror ghui separation without adding `@ghui/keymap` as a dependency.

**Verify:** `bun test packages/ui/src/app.test.tsx`

### 3. Hover + mouse (ghui `SelectableRow`)

In `ArtifactList.tsx`: track hovered row id; lighter bg on hover; click toggles
selection. Use `tokens.selectionBg` for cursor, muted tint for hover.

**Verify:** manual `sweep ui .` — mouse works; tests optional if renderer lacks
mouse.

### 4. Empty states

- Filter empty: existing centered message
- Scope empty: "No artifacts in this scope" when `scopeFilter` set

**Verify:** `bun run check`

### 5. In-TUI rescan overlay

**Blocked until** [orchestration-seam.md](./orchestration-seam.md) keeps TUI
mounted across rescan. Then show dim overlay + spinner instead of destroy/remount.

## Out of scope

- Streaming scan inside TUI ([streaming-engine.md](./streaming-engine.md))
- Bundling / peer dependency changes

## Done

- [ ] `ReviewPane` extracted; `app.tsx` ≤ ~350 lines
- [ ] Keymap in `keymap.ts`
- [ ] Hover on artifact rows
- [ ] `bun run check` passes
