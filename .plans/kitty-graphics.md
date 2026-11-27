Status: proposal
Scope: ui, terminal-graphics
Created: 2026-11-27
Updated: 2026-11-27
Commit: uncommitted

# Kitty Graphics Protocol in `sweep` TUI: Current State and Next Uses

An opinionated engineering review of what `sweep`'s OpenTUI terminal interface
already renders with the Kitty graphics protocol, where pixel graphics genuinely
improve scanning and triage clarity, where Unicode glyphs win, and what `sweep`
should refuse to do.

All byte sizes use binary IEC units (`KiB`, `MiB`, `GiB`).

## 1. What `sweep` already does today

Inspecting [packages/ui/src/Meter.tsx](../packages/ui/src/Meter.tsx),
[packages/ui/src/meter-draw.ts](../packages/ui/src/meter-draw.ts), and
[packages/ui/src/dot-matrix.ts](../packages/ui/src/dot-matrix.ts) shows a
small, clean first layer of Kitty pixel graphics alongside a separate Unicode
dot loader:

1. **Detection (`useKittyGraphics`, `Meter.tsx:100-108`):** Checks
   `renderer.capabilities?.kitty_graphics === true && renderer.resolution !== null && renderer.width > 0 && renderer.height > 0`.
2. **Three pixel-backed components (`Meter.tsx` + `meter-draw.ts`):**
   - `Meter` (`meterPixels`): 1-row anti-aliased rounded capsule meter with a
     track, a 38%-alpha preview fill, and a solid fill. Value changes ease over
     `180 ms` (`1 - (1 - t)^4`, `setInterval(..., 16)`). Falls back to `━`/`─`
     or `█` eighths (`magnitudeBar`).
   - `StackBar` (`stackPixels`): 1-row proportional stacked capsule bar with
     1 px ground seams and `STACK_DIM = 0.38` dimming for unfocused shares.
     Used as the hero rebuild-cost bar in `ProjectsView.tsx` and the breakdown
     bar in `ProjectDetails.tsx`. Falls back to `stackLine`.
   - `ScanMeter` (`glidePixels`): 1-row indeterminate gliding pill (`1400 ms`
     cycle, 56 discrete steps = 40 Hz, `GLIDE_RUN = 0.24`). Used in
     `ProjectsView.tsx` and `LedgerBand.tsx`. Falls back to `glideLine`.
3. **Pixel buffer cache (`meter-draw.ts:309-342`):** Software-rasterized RGBA
   buffers are wrapped with `NativeImage.fromRgba()` and stored in a 256-entry
   LRU `Map`. Evicted entries call `oldest.dispose()` after a 1,000 ms delay;
   teardown calls `releaseMeterImages()`.
4. **What is NOT Kitty graphics yet (`dot-matrix.ts` + `widgets.tsx:141-210`):**
   `DotMatrix` (5x5 loader) and `DotStrip` (statusline sweep) render pure
   Unicode `•` text cells stepped at `160 ms` (6.25 Hz), not pixel buffers.

### Concrete gaps in the current implementation

- **Hardcoded `protocol="kitty"` (`Meter.tsx:166, 226, 286`):** Forces Kitty
  output instead of letting OpenTUI resolve `auto` (which safely falls back to
  blocks inside tmux where direct Kitty placement breaks scrolling and panes).
- **Cache churn during animated eases:** `Meter` keys `cachedImage` by every
  integer pixel step (`valueStep`) across a 60 Hz `setInterval(..., 16)`, and
  `ScanMeter` allocates up to 56 separate `NativeImage` buffers per bar width.
  With `IMAGE_CACHE_MAX = 256`, resizing or scrolling through a project list
  evicts active row bars and re-uploads PNG/RGBA frames.
- **Transparency over painted row backgrounds (`meter-draw.ts:54-56`):**
  Kitty blends transparent image pixels against the terminal's default
  background, not the cell background underneath. On `auto` theme (`bg:
  "transparent"`), any pixel bar inside a highlighted or hovered row must
  either bake the exact row background hex or avoid overlapping row highlights.
- **Pinned on `@opentui/core ^0.6.8`:** OpenTUI `0.8.1+` and `0.9.0` ship
  `NativeImagePool` (fixed-slot buffer reuse with zero allocation churn),
  8 MiB/frame upload pacing, `kittyImageTransport` (`raw` / `zlib` / `file`),
  and fixed resize/scroll re-placement.

---

## 2. Further uses, ranked by value and cost

| Rank | Use case | Value | Cost | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Pixel dot-matrix storage bar (Direction C+) | High | Medium | **Build next** |
| 2 | Unicode placeholders (`U=1`, `U+10EEEE`) for tmux and scroll safety | High | Medium-High | **Build next (pair with OpenTUI upgrade / fallback)** |
| 3 | Event-driven scan progress & right-edge clearing dissolve | Medium-High | Low | **Build next** |
| 4 | Compact size-history sparklines (ledger I3) | Medium | Low-Medium | **Build after I3 history lands** |
| 5 | Colored category icons as 1x1 Kitty images vs Nerd Font glyphs | Low-Medium | High friction | **Legend only, opt-in; keep glyphs default** |
| 6 | Project thumbnails, repo previews, 2D treemaps | Low / Negative | High | **Do not build** |

### Rank 1: Pixel dot-matrix storage bar per Direction C+ (High value, Medium cost)

Replacing the flat 1-row capsule in `StackBar` with a 2-row (or 3-row) C+
dot-matrix bar is the highest-leverage visual upgrade Kitty graphics can give
`sweep`:

- **Why pixels beat Unicode Braille here:** Unicode Braille (`⣿`, `⣶`, `⣤`,
  `⠒`) only gives 2x4 rectangular pips per cell with terminal-dependent line
  gaps and uneven dot aspect ratios across fonts. A Kitty RGBA strip renders
  crisp circular dots (e.g. 6 rows of 4-5 px circles with 2 px spacing), clean
  2x2 Bayer edge dithering at bucket transitions, exact 1-dot ground seams
  between buckets, and smooth dim-to-0.24 focus highlighting when the user
  points at or focuses a rebuild-cost bucket or one of the 11 Space categories.
- **Visual continuity:** Makes `sweep ui`, the web docs (`Direction C+`), and
  the Kuwai island (`SweepDotBar.qml`) share one unmistakable storage visual.
- **Tiny footprint:** A 100-column x 2-row bar at 10x20 px cells is
  `1000 x 40 px` = `160 KiB` raw RGBA (`~4-8 KiB` with `zlib` transport),
  uploaded **once** when settled and never redrawn until selection or cursor
  focus changes.
- **Fallback:** Shares the same segment allocator (`dot-matrix.ts`) with a
  2-row Braille (`⣿`/`⣶`/`⣤`/`⠒`) fallback for non-Kitty terminals and
  distinct density patterns for `NO_COLOR`.

### Rank 2: Unicode placeholders (`U=1`, `U+10EEEE`) for tmux and scroll safety (High value, Medium-High cost)

Today, direct Kitty placements (`a=T` without `U=1`) float in a separate
graphics plane anchored to absolute cursor cells. Inside `tmux`, pane splits,
or scrolled viewports, direct placements clip badly, bleed across pane borders,
or vanish after a pane redraw.

- **How Unicode placeholders solve it:** Transmit the image once as a virtual
  placement (`a=T,U=1,i=<id>,c=<cols>,r=<rows>`), then write normal terminal
  cells containing `U+10EEEE` with the 24-bit foreground color encoding the
  image ID and combining diacritics encoding `(row, col)`. Because the
  placement lives inside the cell grid:
  - `tmux` (3.4+ with `set -g allow-passthrough on`) and Kitty/Ghostty scroll,
    clip, and split panes cleanly without ghost images.
  - Overlapping modals (`ApplyOverlay`, `FilterPicker`, `Modal` in `widgets.tsx`)
    naturally cover placeholder cells at whole-cell granularity without leaving
    pixel bars bleeding through dialogs.
  - Resizing a split pane never strands an orphaned image outside the box.
- **Practical caveat:** Check OpenTUI's native emitter before hand-rolling
  escape sequences. If the pinned OpenTUI release does not yet emit `U=1`
  virtual placements, keep `auto` falling back to Braille inside tmux rather
  than forcing raw passthrough, and track `U=1` support as an upstream OpenTUI
  requirement (with `SWEEP_KITTY_PLACEHOLDERS=1` opt-in once available).

### Rank 3: Smooth scan progress and clearing dissolve, only while work runs (Medium-High value, Low cost)

Align Kitty animation strictly with `.docs/ux-principles.md` ("motion only
while work runs", `SWEEP_REDUCED_MOTION=1`, `m` toggle):

- **During scanning:** Replace `ScanMeter`'s 40 Hz (`56` steps / `1400 ms`)
  cache-thrashing loop with a 3-slot `NativeImagePool` (once on OpenTUI 0.8.1+)
  running at `<= 15 fps` (`66-80 ms` per step). Drive the dot bar's left-to-right
  fill from real `scan_progress` totals instead of a disconnected spinner.
- **During apply (`ApplyOverlay`):** Drive right-edge dot extinguishment from
  real `onDeleted` completion events (180 ms ease-out per completed item), never
  a synthetic timer. Trash mode on the same volume draws zero byte gain, so it
  animates progress count without pretending disk space shrank.
- **Settled state:** The instant `scan_completed` or `apply` finishes, release
  the animation timer and hold one static image. Zero frames per second at rest.

### Rank 4: Compact size-history sparklines for ledger item I3 (Medium value, Low-Medium cost)

Once `sweep` records a bounded local size-history journal (ledger **I3**),
showing a tiny 1-row anti-aliased Kitty sparkline (e.g. `16 cols x 1 row`,
`~160 x 20 px` = `12 KiB` raw) beside a project in `ProjectDetails` or in
`sweep status` answers "is this project's build output growing again?" at a
glance:

- Pixel anti-aliasing resolves subtle slopes that 8-step Unicode blocks
  (`▁▂▃▄▅▆▇█`) flatten when values span two orders of magnitude.
- Costs one tiny cached image for the currently focused project only (never
  one per row in the list).
- Cleanly degrades to Unicode block sparklines on non-Kitty terminals and omits
  color cues under `NO_COLOR`.

### Rank 5: Colored category icons as 1x1 Kitty images vs Nerd Font glyphs (Low-Medium value, High friction)

Should `sweep` render its 4 rebuild-cost icons and 11 whole-disk category icons
as tiny 1-cell Kitty images?

- **Why Nerd Font glyphs + 1-cell text fallbacks win by default:**
  - Zero upload latency, zero image-ID consumption, clean terminal text
    selection/copy-paste, crisp baseline alignment with adjacent text, and
    native support in `captureCharFrame()` snapshot tests.
  - `SWEEP_ICONS=nerd` already maps every category to a single-cell Nerd Font
    codepoint (`design-notes-cplus.md` §3.2), with `●` (color) and single
    letters (`c`/`i`/`b`/`?`, `D`/`A`/`P`...) under `NO_COLOR`.
- **Where pixel icons earn a narrow exception:** Only inside the static 4-item
  or 11-item **legend** (never inside scrollable artifact/project rows) on
  terminals that support Kitty graphics *without* a Nerd Font installed. Even
  there, keep it opt-in or behind a single rasterized legend strip rather than
  11 separate 1x1 image placements, so baseline drift and placement overhead
  stay near zero.

### Rank 6: Project thumbnails and 2D treemaps (Reject)

Do **not** use Kitty graphics for project thumbnails, favicon/README previews,
or 2D squarified treemaps:

- **Thumbnails** add unrequested filesystem/network reads, waste megabytes of
  RGBA memory and upload bandwidth, and tell the user nothing about age, risk
  tier, or rebuild cost.
- **2D treemaps** look flashy in screenshots but fail keyboard triage: arrows
  cannot traverse irregular rectangles predictably, small dangerous items get
  crushed to unreadable pixels, and Sweep's product roadmap explicitly keeps
  the UI cleanup-first rather than a general disk explorer.

---

## 3. Terminal detection and fallback rules

Never trust a single environment variable (`TERM_PROGRAM` lies over SSH and
inside stale tmux shells). Follow OpenTUI's live capability snapshot
(`renderer.capabilities` + `CliRenderEvents.CAPABILITIES`) and add explicit
multiplexer and remote guards:

| Terminal / Environment | Kitty Graphics | Unicode Placeholders (`U=1`) | Recommended `sweep` policy |
| --- | --- | --- | --- |
| **Kitty** (local) | Yes (native) | Yes | Full Kitty pixel dot-matrix bar (`zlib` or `raw` transport; `file` only after verified `t=f` ack). |
| **Ghostty** (local) | Yes (native) | Yes | Full Kitty pixel dot-matrix bar; identical to Kitty. |
| **WezTerm** | Yes (partial) | Partial / version-dependent | Use Kitty pixels with `raw`/`zlib` transport only (never assume `t=f` upload ack on older builds); fall back to Braille if `resolution` is absent. |
| **Konsole** | Yes (22.04+) | Limited | Use direct Kitty placement for static hero/details bars only; fall back to Braille when scrolling or inside splits. |
| **foot / Alacritty / iTerm2 / Windows Terminal** | No (Sixel or none) | No | Use 2-row Unicode Braille dot-matrix fallback (`⣿`/`⣶`/`⣤`/`⠒`). Do not force Sixel for tiny 1-row meters (Sixel flashes during scroll and redraws slower than Braille). |
| **tmux** | Only with `allow-passthrough on` + outer Kitty/Ghostty | Required for safe pane clipping | Default to **Braille fallback** when `capabilities.multiplexer === "tmux"` unless both `allow-passthrough` and `U=1` placeholders are confirmed; never emit unwrapped direct Kitty escapes inside tmux. |
| **Zellij / GNU Screen** | No / unreliable | No | Always use Braille fallback; disable graphics probes. |
| **SSH / mosh (`capabilities.remote === true`)** | Depends on client | Same as client | Never use `t=f` temp-file transport (wrong filesystem); prefer `zlib` transport; disable smooth scan/clear pixel animation or cap at `<= 6 fps` so slow links never queue stale frames. |
| **`NO_COLOR` / `OPENTUI_GRAPHICS=false` / `SWEEP_GRAPHICS=off`** | Disabled | Disabled | Always render Braille density + single-letter fallback (`c`/`i`/`b`/`?`) with zero escape sequences. |

### Detection rules to enforce in `Meter.tsx`

1. Listen to `CliRenderEvents.CAPABILITIES` (capabilities can arrive after
   first paint; do not freeze a `false` read from frame 0).
2. Switch `<image protocol="kitty">` to `<image protocol="auto">` (or gate on
   `capabilities.kitty_graphics && capabilities.multiplexer === "none"` until
   `U=1` placeholder support lands).
3. Respect `SWEEP_GRAPHICS=off` alongside `OPENTUI_GRAPHICS=false` and
   `NO_COLOR` so users on quirky terminal setups always have a one-env escape
   hatch.

---

## 4. Performance limits and hard budgets

Kitty graphics must stay invisible to latency and battery life. Enforce these
concrete limits in `packages/ui`:

| Dimension | Hard limit | Rationale |
| --- | --- | --- |
| Live Kitty image IDs | `<= 32` active IDs at once (`<= 64` LRU cache cap, down from `256`) | Hero bar (1), details bar (1), sparkline (1), optional legend strip (1), plus a small headroom of cached resize/hover states. Send `a=d,d=i,i=<id>` on eviction and `a=d,d=A` on teardown. |
| Total RGBA pixel memory | `<= 4 MiB` across all cached images; `<= 256 KiB` per bar image | Well below OpenTUI's 100 MiB/image and 8 MiB/frame caps; keeps RSS flat during long TUI sessions (`ui-long-session` budget). |
| Animated redraw rate | `<= 15 fps` (`66-80 ms` step) during active scan/apply; `0 fps` at rest | Cuts CPU and terminal upload bytes by 60-75% vs today's 40-60 Hz `setInterval(..., 16)` with no perceptual loss on a dot bar. |
| Animation allocation | `0` new `NativeImage` objects per frame (use `NativeImagePool` with `capacity: 3`) | Eliminates GC churn and LRU eviction storms during scans and eases. |
| Transport payload per frame | `<= 64 KiB` encoded (`zlib` level-1 when smaller than raw) | Prevents pipe stalls over SSH and keeps every frame under `4 ms` on slow terminals. |
| Per-row images in virtualized lists | `0` | Scrollable project and artifact lists (`ArtifactList`, `ScopeSidebar`, `ProjectsView` rows) use Unicode eighths (`magnitudeBar`) or plain cell text, never per-row Kitty images. |

---

## 5. What NOT to do

1. **Do not animate at rest.** Once a scan settles or an apply finishes, zero
   timers fire and zero Kitty frames upload. No breathing glow, no ambient dot
   shimmer, no looping logo.
2. **Do not draw text or numbers as pixels.** Headline totals, byte sizes,
   paths, keycaps, and risk badges must remain real terminal text so screen
   readers, terminal search, copy/paste, font scaling, and `captureCharFrame()`
   tests keep working.
3. **Do not put Kitty images inside scrolling list rows.** Replacing 20-40 row
   magnitude bars with Kitty images turns every `↓` keypress or wheel tick into
   dozens of placement updates and visibly smears on scroll. Keep Kitty pixels
   for the 1-3 pinned summary graphics (hero dot bar, details bar, optional
   sparkline).
4. **Do not force `protocol="kitty"` inside tmux, Zellij, or Screen.** Broken
   escape bleed destroys user trust faster than plain Unicode bars ever could.
5. **Do not use `t=f` file transport unconditionally.** It fails over SSH,
   needs verified ack cleanup (older WezTerm omits acks), and risks leaving
   orphan temp files on `SIGKILL`. Use `raw`/`zlib` by default; bars are small
   enough (`< 16 KiB` compressed) that temp files buy almost nothing.
6. **Do not fake progress or particle physics.** Clearing dissolve dots must
   extinguish strictly on real `onDeleted` outcomes, never on a speculative
   countdown timer that can disagree with a failed or stopped removal.
7. **Do not turn `sweep` into a graphical disk treemap.** Pixel clarity should
   make rebuild cost, age, and trust boundaries faster to read, never turn a
   keyboard-first cleanup tool into an image viewer.
