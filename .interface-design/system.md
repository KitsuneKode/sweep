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

Header (title + stats) | body (sidebar + list) | context | footer (contextual shortcuts).

## Signature

Scope sidebar + pattern palette + tabular risk-aware artifact rows.
