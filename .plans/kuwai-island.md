Status: planned
Scope: integrations, protocol, cli, core, docs
Created: 2026-11-27
Updated: 2026-11-27
Commit: uncommitted

# Kuwai Island Integration for `sweep`

Design and contract specification for showing `sweep` inside Kuwai's top-center
island (a notch-like Quickshell surface on Hyprland), inspired by Clove's
storage panel in the macOS notch while keeping Kuwai's exact material, motion,
and trust rules.

This is a design and contract plan for a later implementation pass across
`sweep` and the owner's `rice` repo (`/home/kitsunekode/Projects/rice`). All
disk figures use binary IEC units (`B`, `KiB`, `MiB`, `GiB`, `TiB`).

## Context and current duplication

Today, `/home/kitsunekode/Projects/rice` already ships a first-generation
Sweep integration across four files:

- `bin/kuwai-sweep`: 373-line Python wrapper that runs `sweep status --json`
  (or falls back to `sweep scan --json`), re-implements `summarize()`, caches
  to `~/.local/state/kuwai/sweep-status.json` with a 6 h TTL, and owns terminal
  launch commands.
- `shell/services/Sweep.qml`: polls `bin/kuwai-sweep` on a 45 s startup timer
  and a 300 s repeat timer.
- `shell/services/sweepModel.js`: formats bytes with decimal `1e9` (`GB`/`MB`)
  instead of binary `GiB`/`MiB`, splits kinds with a four-color loop, and owns
  empty/footer copy.
- `shell/modules/island/SweepPanel.qml`: renders a flat segmented bar inside
  `CleanupPanel.qml` under the `Idle projects` sub-tab.

That first pass has four structural problems this plan fixes:

1. **Duplicated domain logic.** Reclaimable math, idle cutoffs, rebuild-cost
   grouping, copy strings, and binary formatting live in both repos and have
   already drifted (decimal GB in Kuwai vs binary GiB in Sweep).
2. **Background polling while closed.** `Sweep.qml` spawns `bin/kuwai-sweep` on
   background timers even when the island is closed, violating Clove's rule
   ("a closed notch never scans, polls, or animates") and Kuwai's 0% idle CPU
   budget.
3. **Missing Direction C+ visual model.** `SweepPanel.qml` uses a flat bar of
   artifact kinds instead of the approved Direction C+ dot-matrix bar grouped
   by rebuild cost (`Caches`, `Installs`, `Builds`, `Opt-in`) with colored
   icons, and has no read-only whole-disk `Where your space goes` view.
4. **Incomplete state coverage.** Scanning progress, stale cached age, active
   clearing observation, post-apply receipt, partial failures, missing native
   engine, and permission denied states are either collapsed into one string or
   absent.

## Skill guidance applied

Skills consulted from `~/.agents/skills/`, `aiforui.dev/skills`, and Kuwai's
repo skills (`.claude/skills/kuwai-ui/SKILL.md`,
`.claude/skills/verify-kuwai/SKILL.md`), mapped to where each governs this
spec:

| Skill | Where applied in this design | Concrete rule carried over |
| --- | --- | --- |
| `kuwai-ui` | Entire QML surface, token usage, idle cost | Use `Theme.qml` tokens and `Label`/`Spring`/`Ui.*` primitives; 0% CPU at rest; `setpriv --pdeathsig KILL`; never name a property `data`; no bare `Text` for external strings. |
| `apple-design` | Island notch morph, spring interruptibility, translucency, reduced motion | Velocity-preserving springs (`surfaceIn`/`surfaceOut`); enter and exit along the top edge; rubber-banding past pull thresholds; `reduceMotion` drops travel/scale and keeps fades. |
| `emil-design-eng` | Animation frequency gate, curves, press feedback, blur-masked swaps | No animation on 100+/day keyboard actions; `cubic-bezier(0.23, 1, 0.32, 1)` ease-out; `scale(0.97)` on press (`140 ms`); never `scale(0)`; subtle blur (`<= 3 px`) only on content swaps. |
| `animate` | Every individual state transition | Pick the cheapest mechanism; every moving element names its purpose (`Feedback`, `State indication`, `Spatial consistency`, `Preventing a jarring change`). |
| `find-animation-opportunities` | Motion restraint audit | Reject ambient idle loops, settled-bar shimmer, and keyboard arrow lag; keep motion strictly to active scan, active clearing, and rare receipt arrival. |
| `improve-animations` | Retiring Kuwai's old SweepPanel wipe/poll behavior | Replace `SweepPanel`'s ad-hoc bar reveal and background timer with event-driven transitions tied to real scan and apply events. |
| `animation-vocabulary` | Precise motion names in the state table | Use exact terms: Morph, Crossfade, Continuity transition, Origin-aware animation, Press feedback, Rubber-banding, Tabular numbers. |
| `choreograph` | Island open/close and view swap sequencing | One entrance per container (the notch shape leads on `pv`, content fades/rises once together; no per-row stagger in high-frequency lists). |
| `animation-performance` | Frame budget and QML layer discipline | Animate transform/opacity only; never leave `ShaderEffectSource` `live: true` over animating content; disable `LiquidRim` pointer specular pass on battery. |
| `transitions-polish` | Open/close asymmetry and hover timing | Close faster than open (`surfaceOut` / `exitMs 140 ms` vs `surfaceIn` / `enterMs 200 ms`); hover highlight responds in `80 ms` (`Theme.hoverMs`). |
| `fluid-functionalism` | Spring tiers, concentric radii, fluid row highlight | `Theme.springFast` / `springModerate` / `springSlow`; `FluidHighlight` for project rows; concentric `Theme.innerRadius(outer, inset)`. |
| `tactile-design` | Hierarchy, button roles, copy discipline, empty/error layouts | One bold hero figure and one primary action per view; destructive actions never primary; copy button ticks immediately with no toast; plain words, no em dashes. |
| `interaction-design` | Loading skeletons, progress feedback, accessible focus | Layout-preserving shimmer skeleton only while actively loading; clear focus rings; never block input during transitions. |
| `gestures` | Capsule pull-down to open and swipe-up to dismiss | 1:1 track phase during drag, damped wrong-way travel (`Theme.swipeDamp`), velocity-seeded spring release via `Fling`. |
| `pick-ui-library` | Confirming native stack choices | In Kuwai QML, reuse `qs.components` and `qs.components.ui` (`LinkedBar`, `Button`, `Card`, `Notice`, `Segmented`, `FluidHighlight`, `Spring`) instead of inventing parallel primitives. |
| `verify-kuwai` | Testing and preview plan | Never move the live pointer, type synthetic keys, or touch `~/.local/share/kuwai`; verify with `qmllint`, `kuwai-rehearse --gate`, and isolated `qs -p <tmpdir>`. |

---

## (a) Integration architecture without duplication

### Comparing the three integration options

| Criterion | Option 1: Existing capsule contract only (`kuwai capsule set/clear/list`) | Option 2: Generic Kuwai Island Panel plugin host + Sweep QML module (Recommended) | Option 3: Kuwai-side module (current status quo, expanded) |
| --- | --- | --- | --- |
| Rich expanded storage card (dot bar, hover, Space view) | Not possible. Capsules only hold 40-char text, 2-char glyph, 4 tones, and one click URL/argv (`bin/kuwai-ext:160-198`). | Full native QML panel inside `NotchShape`, sharing Kuwai's exact material and primitives. | Full native QML panel. |
| Single source of truth for schema, binary units, rebuild costs, copy | Weak: an external script still has to push capsule updates on a timer. | Strong: JSON contract, schema, formatters, and QML surface all live in `sweep` (`packages/protocol`, `integrations/quickshell/Sweep/`). | Weak: logic stays duplicated between `sweep` and `rice` and drifts over time. |
| Background polling at rest | Requires a background daemon/timer to keep capsules fresh. | Zero polling at rest; scans run only on user open/refresh, and `FileView` watches cache/receipt files via inotify. | Same if rewritten, but still tied to `rice` release cadence. |
| Change size in Kuwai (`rice`) | Zero. | One small, reusable extension point (`kuwai-ext panels` + `KuwaiPluginHost` `Loader`), plus deleting 4 Sweep-specific files from `rice`. | Ongoing edits across 4+ files in `rice` for every Sweep feature. |
| Fault isolation | High (JSON file only). | High: `Loader` catches compile/load errors and falls back to a quiet notice without breaking the shell. | Medium: syntax/type error in `shell/modules/island/` blocks shell reload. |

### Recommendation: Option 2 (Island Panel plugin contract + versioned `sweep widget` contract)

Split responsibilities cleanly across the two repositories so zero domain code
is vendored twice:

1. **Owned by `sweep` (this repository):**
   - **Core rebuild-cost & status engine** (`packages/core/src/rebuild.ts`,
     `packages/core/src/widget.ts`): move `rebuildFor()` out of
     `packages/ui/src/project-details.ts` into `packages/core` so CLI, TUI, and
     desktop integrations share one authoritative mapping of artifact kinds to
     rebuild costs (`cache`, `install`, `build`, `custom`).
   - **Versioned read-only JSON contract** (`packages/protocol/src/widget.ts`
     and `packages/protocol/schemas/widget-snapshot.schema.json`): new CLI
     subcommand `sweep widget [path] --json` (snapshot) and
     `sweep widget [path] --json-stream` (NDJSON progress + final snapshot),
     plus `--view projects|space`, `--cache-only`, and `--refresh`.
     `sweep status --json` stays unchanged for backwards compatibility.
   - **L4 cache & passive receipt files** written atomically (`0600`):
     - Cache: `$XDG_CACHE_HOME/sweep/widget-v1.json` (read-only snapshot; never
       authorizes removal).
     - Live apply progress: `$XDG_RUNTIME_DIR/sweep/active-apply.json` (written
       only while `sweep ui` or `sweep apply` is actively removing items;
       unlinked on exit).
     - Post-apply receipt: `$XDG_STATE_HOME/sweep/last-receipt.json` (written
       once when an apply completes, cleanly or partially).
   - **Quickshell QML module** (`integrations/quickshell/Sweep/`):
     - `qmldir`
     - `SweepPlugin.qml` (plugin entrypoint exporting `panelComponent`,
       `capsuleModel`, and `sectionMeta`)
     - `SweepSurface.qml` (the island panel: Projects & Space views, all 17
       states)
     - `SweepDotBar.qml` (C+ 6-row dot-matrix bar with column seams, legend
       icons, hover/keyboard focus, and real-event right-edge dissolve)
     - `SweepService.qml` (FileView watchers + on-demand `Process` runner with
       `setpriv --pdeathsig KILL` and `flock`, zero polling timers)
     - `sweepFormat.mjs` (pure binary IEC formatting `KiB`/`MiB`/`GiB`, age
       formatting, width-tiered insight selection; unit-tested with `bun test`)
     - `manifest.template.json`
   - **Standalone preview harness** (`integrations/quickshell/preview/`): lets
     contributors preview and lint the QML module inside `sweep` via
     `qs -p <tmpdir>` with mocked `Host` and fixture snapshots, without needing
     Kuwai installed.

2. **Owned by Kuwai (`/home/kitsunekode/Projects/rice`):**
   - **Generic Island Panel extension point** in `bin/kuwai-ext` (extending
     `docs/EXTENDING.md` alongside `providers` and `capsule`):
     - Discovers manifests in `$XDG_CONFIG_HOME/kuwai/panels/<id>/manifest.json`.
     - Validates ownership (`st_uid == getuid()`, mode `& 0o022 == 0`, regular
       file, `realpath` pinned inside plugin root, no `..` traversal) using the
       exact `own_file` / `own` rules already in `bin/kuwai-ext`.
     - Exposes `kuwai-ext panels` returning validated plugin descriptors as JSON.
   - **`KuwaiPluginHost` contract** (`shell/services/Plugins.qml` + `Loader` in
     `IslandBar.qml` / `CleanupPanel.qml` / `IslandSplit.qml`):
     - Passes a versioned `host` object (`apiVersion: "1.0"`) into each loaded
       plugin root, exposing only stable, safe capabilities:
       - `host.theme` (read-only access to `Theme` tokens)
       - `host.ui` (references to `Ui.Button`, `Ui.Card`, `Ui.Notice`, `Ui.Chip`,
         `Segmented`, `Label`, `FluidHighlight`, `ScrollFade`, `ScrollHint`)
       - `host.env` (`reduceMotion`, `onBattery`, `textScale`, `highContrast`,
         `screenName`, `panelVisible`, `via`)
       - `host.launchTerminal(argv, cwd)` (validates argv against plugin
         `allowedCommands`, routes through `Apps.run` and `bin/kuwai-term` /
         Kitty inside `systemd-run --user --slice=app.slice` so a shell restart
         never kills an active `sweep ui` session)
       - `host.openSettings(page)` and `host.closeIsland()` and `host.copyText(s)`
     - Isolates `Loader.Error`: a broken plugin logs once and renders a single
       `Ui.Notice`, never breaking shell reload.
   - **Retirement of legacy duplication:** once the plugin host ships, Kuwai
     removes `bin/kuwai-sweep`, `shell/services/Sweep.qml`,
     `shell/services/sweepModel.js`, and `shell/modules/island/SweepPanel.qml`.

### Exact plugin manifest contract (`~/.config/kuwai/panels/sweep/manifest.json`)

```json
{
  "schemaVersion": 1,
  "id": "sweep",
  "title": "Sweep",
  "glyph": "\uf00e2",
  "hostApi": ">=1.0 <2.0",
  "moduleDir": "/usr/share/sweep/quickshell/Sweep",
  "qmlEntry": "SweepPlugin.qml",
  "mount": {
    "section": "cleanup",
    "tabId": "projects",
    "tabLabel": "Projects",
    "panelWidth": "panelM",
    "standaloneAlias": "sweep"
  },
  "capsule": {
    "enabled": true,
    "side": "right",
    "lane": "sys",
    "defaultHidden": true
  },
  "allowedCommands": ["sweep"],
  "watchPaths": [
    "$XDG_CACHE_HOME/sweep/widget-v1.json",
    "$XDG_STATE_HOME/sweep/last-receipt.json",
    "$XDG_RUNTIME_DIR/sweep/active-apply.json"
  ]
}
```

### Consumption without vendoring

- When `@kitsunekode/sweep` is installed (via AUR `sweep`, `bun add -g`, or a
  local checkout), `integrations/quickshell/Sweep/` ships alongside the package
  (or `/usr/share/sweep/quickshell/Sweep/` in the Arch package).
- Running `sweep integrate kuwai` (or the Arch post-install message) writes
  `~/.config/kuwai/panels/sweep/manifest.json` with `moduleDir` pointing to the
  installed `Sweep/` directory (verified read-only and owned by root or the
  invoking user, never world-writable).
- Upgrading `sweep` upgrades both the CLI JSON producer and the QML consumer in
  lockstep. Upgrading Kuwai keeps working across any `1.x` `hostApi` release.
- Neither repository vendors a copy of the other's source files.

### Versioned JSON contract (`sweep widget --json`)

Schema file: `packages/protocol/schemas/widget-snapshot.schema.json`. Additive
evolution within `widgetSchemaVersion: 1`; breaking changes bump to `2` and the
QML module checks `snapshot.widgetSchemaVersion === 1` before rendering (showing
an explicit "Update Sweep or Kuwai plugin" notice on mismatch).

```json
{
  "widgetSchemaVersion": 1,
  "protocolVersion": "1",
  "readOnly": true,
  "view": "projects",
  "targetDir": "/home/kitsunekode/Projects",
  "generatedAt": "2026-11-27T20:15:00.000Z",
  "elapsedMs": 640,
  "source": "live",
  "stale": false,
  "partial": false,
  "skippedDirs": 0,
  "disk": {
    "mountPoint": "/home",
    "totalBytes": 512067452928,
    "usedBytes": 367649177600,
    "freeBytes": 33285996544
  },
  "projectsSummary": {
    "reclaimableBytes": 61632780697,
    "safeBytes": 61202864537,
    "cautionBytes": 429916160,
    "guardedBytes": 4509715660,
    "protectedCount": 22,
    "projectCount": 112,
    "idle": {
      "days": 30,
      "projects": 26,
      "bytes": 7301444403
    },
    "worktrees": {
      "finished": 5,
      "bytes": 3758096384
    },
    "byCost": [
      { "cost": "cache", "label": "Caches", "bytes": 2254857830, "count": 41, "hint": "Comes back on its own" },
      { "cost": "install", "label": "Installs", "bytes": 41446431129, "count": 96, "hint": "Reinstalls from lockfile" },
      { "cost": "build", "label": "Builds", "bytes": 17501991731, "count": 48, "hint": "Rebuilds on next compile" },
      { "cost": "custom", "label": "Opt-in", "bytes": 429916160, "count": 6, "hint": "Check first" }
    ],
    "topProjects": [
      { "name": "feat/old-renderer", "repo": "sweep", "path": "/home/kitsunekode/Projects/sweep/.worktrees/old-renderer", "bytes": 1288490188, "idleDays": 42, "worktreeState": "merged" }
    ]
  },
  "suggestion": {
    "kind": "worktrees",
    "full": "5 finished worktrees hold 3.5 GiB. Merged branches can be reviewed first.",
    "short": "5 finished worktrees hold 3.5 GiB.",
    "action": {
      "intent": "review_projects",
      "label": "Review 5 worktrees",
      "view": "projects",
      "focus": "worktrees"
    }
  },
  "receipt": null,
  "space": null,
  "error": null
}
```

Key protocol invariants:
- `readOnly: true` is always set; `sweep apply --plan` rejects any
  `widgetSchemaVersion` document unconditionally.
- `action` carries a closed discriminated `intent` (`review_projects`,
  `review_space_developer`, `review_space_caches`, `review_space_trash`,
  `inspect_receipt`), never an arbitrary command string. The QML module builds
  the argv array (`["sweep", "ui", ...]`) from a fixed whitelist and hands it
  to `host.launchTerminal`.
- When `--view space` is requested, `space` carries the 11 mutually exclusive
  categories from `.plans/space-report.md` (`developer`, `apps`, `photos`,
  `system_data`, `caches`, `videos`, `documents`, `downloads`, `trash`,
  `music`, `other`), where only `developer`, `caches`, and `trash` may carry a
  review intent; all other 8 categories have `actionable: false`.

---

## (b) Complete state specification

### Trust invariant across every state

1. **The island never deletes on one click.** There is no "Delete", "Clear now",
   or "Empty Trash" button anywhere in the Sweep island surface.
2. **Every removal goes through `sweep ui`.** Clicking `Review in Sweep` (or a
   category review button) launches `sweep ui` in a Kitty window at the right
   view (`--view projects` or `--view space`) with an **empty queue**, where
   Sweep's full review list, risk reasons, blocked-item guards, trash toggle,
   and explicit `y` confirmation run unchanged (see
   [.docs/ux-principles.md](../.docs/ux-principles.md)).
3. **Why Kitty handoff instead of an inline QML confirm sheet:** Duplicating
   Sweep's apply confirmation inside QML would either hide per-item risk reasons
   and blocked subtrees (weakening consent) or re-implement inode/device
   revalidation and dangerous-item confirmation in a second language (creating
   safety drift). Opening `sweep ui` in Kitty takes one keypress, preserves
   every guardrail, and returns a verified receipt to the island when finished.
4. **Guarded bytes never inflate the headline.** Dangerous and blocked items
   are reported separately (`+4.2 GiB guarded`) and never added to the
   reclaimable total.

### Motion rules across every state

All motion uses Kuwai's existing `Theme.qml` tokens (no raw numbers):

- Island open (pointer): `Theme.surfaceIn` (`stiffness: 300, damping: 27.7`),
  content fades/rises once with `pv` (`opacity` + `-8 px` translate + `scale
  0.97 -> 1`, `MultiEffect` blur only mid-flight).
- Island open (keyboard): `Theme.surfaceKeyIn` (`stiffness: 560, damping: 47.3`),
  no blur layer.
- Island close: `Theme.surfaceOut` (pointer) or `Theme.surfaceKeyOut` (keyboard),
  always quicker than open, no overshoot.
- Capsule bud/retract: `IslandSplit` `sv` spring (`surfaceIn` / `surfaceOut`),
  width `wv` spring (`settle()` on first show, never `snap()`).
- Legend/dot hover highlight: `Theme.hoverMs` (`80 ms`) opacity/color fade on
  pointer hover; `0 ms` instant step on `←`/`→` keyboard focus.
- Press feedback on buttons/rows: `scale 0.97` (rows `0.985`), `Theme.pressMs`
  (`140 ms`, `Theme.easeOut`).
- Active scan/clearing only: shimmer sweep `Theme.shimmerMs` (`1300 ms`) or
  `Ui.Button { busy: true }` (`Theme.spinMs 750 ms`). Stops immediately when
  settled or under `Theme.reduceMotion`.
- Settled state: zero timers, zero animations, zero frame redraws.

### State-by-state specification (18 visual states)

| # | State | Surface & Layout | Exact Copy (plain voice, binary units) | Motion & Interactivity |
| --- | --- | --- | --- | --- |
| 1 | **Rest (hidden, default)** | No Sweep capsule shown. Notch shows normal Kuwai rest row (`workspaces · clock · status`). | None. | 0% CPU, zero polling, zero timers. |
| 2 | **Rest (optional capsule)** | Shown only when `Settings.sweepMark` is on, a cached scan exists with idle/worktree bytes `>= Settings.sweepMinGiB` (default `10 GiB`), and bytes grew by `>= 5 GiB` since last viewed. Right-side `IslandSplit` pill (`28 px` tall, `rgba(0,0,0,0.94)`, `1 px rgba(255,255,255,0.07)`). | Glyph `\u{f00e2}` + `10.3 GiB` (tabular). | Buds once via `sv` spring (`surfaceIn`). Completely still once out. Swipe up dismisses until threshold changes; click or pull down opens expanded card. |
| 3 | **Hover (capsule / glance)** | Hovering capsule raises pill fill (`rgba(255,255,255,0.09)`). After `Settings.hoverDelay` (`220 ms`), opens read-only island preview (`Island.preview("sweep")`, `WlrKeyboardFocus.None`) showing compact header + dot bar + one sentence. Hovering the main island never triggers a scan. | Tooltip if preview disabled: `10.3 GiB in 26 idle projects and 5 finished worktrees · click to inspect`. | `80 ms` hover wash (`Theme.hoverMs`). Preview folds `300 ms` (`Theme.hoverLeaveMs`) after pointer leaves unless clicked to pin. |
| 4 | **Expanded storage card (settled)** | `Theme.panelM` (`640 px`) inside `NotchShape` (`30 px` bottom radius, `14 px` ears, `LiquidRim`). Top strip: section tabs + `Projects \| Space` `Segmented` + quiet `Rescan` & `Open TUI` icon buttons. Body: hero number `57.4 GiB` (`26 px` bold sans, tabular) + `reclaimable in ~/Projects`, dim line `31.0 GiB free on volume · +4.2 GiB guarded`, 6-row `SweepDotBar` by rebuild cost, 4-item legend with colored Nerd Font icons, footer insight + single primary `Review in Sweep` button + quiet trust caption. | Hero: `57.4 GiB` `reclaimable in ~/Projects`<br>Sub: `31.0 GiB free on volume · +4.2 GiB guarded`<br>Legend: `Caches 2.1 GiB`, `Installs 38.6 GiB`, `Builds 16.3 GiB`, `Opt-in 410 MiB`<br>Footer: `10.3 GiB is in 26 idle projects and 5 finished worktrees.`<br>Button: `Review in Sweep`<br>Caption: `Nothing is deleted here. Review opens Sweep with an empty queue.` | Opens on `surfaceIn` (or `surfaceKeyIn` via shortcut). Dot bar and hero are completely still once settled. |
| 5 | **Scanning (user-triggered)** | Entered only when the user opens the panel with no cache or clicks `Rescan`. Hero shows `~14.2 GiB` (leading `~` marks incomplete sizing). Subtitle shows live folder count and middle-elided path. Dot bar fills left-to-right from real `scan_progress` buckets with leading shimmer. `Rescan` icon spins (`busy: true`); `Stop` quiet button cancels cleanly. | Hero: `~14.2 GiB` `scanning ~/Projects`<br>Sub: `1,420 folders scanned · packages/ui/node_modules`<br>Footer: `Measuring reclaimable build output. Nothing is removed during a scan.`<br>Buttons: `Stop` (quiet), `Review in Sweep` (disabled). | Live updates coalesced at `<= 12 Hz` (`80 ms`); shimmer `Theme.shimmerMs` (`1300 ms`) paused under `reduceMotion`. Cancels child via `SIGTERM` on `Stop` or panel close. |
| 6 | **Settled (nothing to free)** | Reclaimable is `0 B`. Dot bar shows empty unlit track (`Theme.wash(2)`). No suggestion card, no primary button. | Hero: `0 B` `reclaimable in ~/Projects`<br>Sub: `31.0 GiB free on volume · +4.2 GiB guarded`<br>Footer: `Nothing to clear here right now.`<br>Button: `Rescan` (secondary). | Still. Zero timers. |
| 7 | **Stale cached result (L4)** | Immediate first paint from `$XDG_CACHE_HOME/sweep/widget-v1.json` when older than `60 min` (or on battery). Renders full dot bar and legend at full clarity plus an amber-tinted `Chip` in the header row (`Cached · 3 h ago`) and a `Refresh` button. | Chip: `Cached · 3 h ago` (or `Cached · 3 h ago · on battery`)<br>Footer: `10.3 GiB was idle at last scan. Refresh to measure again, or review live in Sweep.`<br>Buttons: `Review in Sweep` (primary, runs live scan), `Refresh` (secondary). | Instant paint (no skeleton flash). Never auto-scans on battery. |
| 8 | **Point / hover on legend or dot bar** | Pointer over a legend item or dot column (or `←`/`→` keyboard focus) dims all other dot columns to `opacity: 0.24`, highlights the active legend pill (`rgba(255,255,255,0.12)`), and swaps hero + subtitle in place with zero height shift. | Hero: `16.3 GiB` (in `#fb984a` `costBuild`) `Builds`<br>Sub: `48 folders · Rebuilds on next compile (cargo build, next build).` | `80 ms` opacity/color transition (`Theme.hoverMs`) on pointer; `0 ms` on keyboard arrows. Leaving restores whole-tree hero immediately. |
| 9 | **Suggestion (actionable next step)** | When finished worktrees or idle projects dominate, a subtle inner `Ui.Card` highlights the single lowest-regret group above the primary CTA, with top 3 matching project rows (`FluidHighlight`, keyboard `↑`/`↓` + `Enter`). | Card title: `5 finished worktrees hold 3.5 GiB`<br>Detail: `Merged branches can be reviewed first without touching active checkouts.`<br>Rows: `sweep › old-renderer · merged · 1.2 GiB`, `kuwai › blur-spike · merged · 980 MiB`, `docs › v2-draft · branch missing · 740 MiB`<br>Buttons: `Review 5 worktrees` (primary), `All projects` (quiet). | `FluidHighlight` glides on `Theme.springFast` between rows on pointer hover; snaps as focus ring on keyboard. |
| 10 | **Review handoff** | Shown briefly (`~180 ms`) after clicking `Review in Sweep` while `Host.launchTerminal` spawns Kitty with `sweep ui <dir>` (`--view projects` or `--view space`, empty queue). Folds away as soon as Hyprland emits `openwindow` for Kitty. | Button text swaps in place: `Opening Sweep in Kitty…` (pressed `scale 0.97`, disabled against double-launch).<br>Caption: `Queue starts empty. Sweep asks before removing anything.` | Continuity transition: island folds on `surfaceOut` as Kitty maps and takes focus via `Island.giveFocus`. |
| 11 | **Clearing in progress (passive)** | Observed via inotify on `$XDG_RUNTIME_DIR/sweep/active-apply.json` only while the user's confirmed `sweep ui` / `sweep apply` run is executing. Capsule shows broom + `Clearing 3/12`. Expanded panel shows progress bar and right-edge dots dissolving from the active bucket on each real item completion. | Hero: `Clearing 3 of 12` `~1.8 GiB freed so far`<br>Sub: `Removing packages/web/.next`<br>Footer: `Running in Sweep. Focus the terminal window to stop.`<br>Button: `Focus Sweep` (secondary). | Dot dissolve animates strictly on real `deletedCount` increments (`Theme.glideMs 140 ms`, `Theme.easeOut`), never on a fake timer. Under `reduceMotion`, dots step cleanly with no dissolve trail. |
| 12 | **Receipt (clean outcome)** | Shown when `$XDG_STATE_HOME/sweep/last-receipt.json` records `failed === 0 && !stopped`. Capsule briefly flashes green halo once (`celebrate()`, never loops). Expanded header shows green check + freed total and updated free disk space. Trash mode states `0 B freed on volume until purged`. | Hero: `✓ Freed 3.5 GiB` (in `Theme.green`)<br>Sub: `5 items removed · 34.5 GiB free now`<br>Footer: `Next: 26 idle projects hold 6.8 GiB.` (or `Nothing else needs clearing right now.`)<br>Button: `Review idle projects` (primary) or `Done` (secondary). | Rare delight budget: one-time green halo fade (`Theme.enterMs` -> `Theme.breathOutMs`), hero count settles once (`<= 320 ms`, disabled under `reduceMotion`). |
| 13 | **Partial / failed outcome** | Shown when `last-receipt.json` has `failed > 0` or `stopped: true`. Uses `Ui.Notice` in amber (`Theme.orange`). Never calls partial work clean. | Notice title: `Removed 3.1 GiB, 2 items failed` (or `Stopped early · 3 removed, 2 not attempted`)<br>Detail: `2 items stayed queued because files were busy or lacked permission.`<br>Action: `Inspect in Sweep` (opens `sweep ui` showing per-row failure reasons). | Static amber notice. No shake or looping pulse. |
| 14 | **Error (scan failed / timeout)** | Shown when `sweep widget` exits non-zero or times out. Uses `Ui.Notice` in red (`Theme.red`). Never prints helper filenames, stack traces, or exit codes (passes Kuwai `REHEARSAL.md` `insides` gate). If a last-good cache exists, keeps showing it dimmed below the notice. | Notice title: `Could not finish scanning ~/Projects`<br>Detail: `The scan timed out before sizing finished. Showing the last saved scan from 3 h ago.` (or `Try again, or open Sweep in a terminal for details.`)<br>Actions: `Try again` (secondary), `Open terminal` (quiet). | Static red notice. No placeholder skeletons left alongside error (passes `waits-forever` gate). |
| 15 | **Sweep not installed** | `sweep` binary not found in `PATH`, `~/.bun/bin`, or `~/.local/bin`. Clean centered empty state (`Ui.EmptyState`). | Title: `Sweep is not installed`<br>Body: `Install Sweep to inspect project build output and disk usage from the island.`<br>Code pill: `bun add -g @kitsunekode/sweep` + copy icon button (ticks immediately on click, no toast). | Still. Copy icon crossfades to check in `Theme.microMs` (`140 ms`). |
| 16 | **Engine missing** | `sweep` CLI runs but returns `error.code === "engine_missing"` (native Rust `sweep-engine` binary missing or incompatible). | Notice (`Theme.orange`): `Native scan engine unavailable`<br>Detail: `Scans can still run with the fallback scanner, or run doctor to repair the native engine.`<br>Actions: `Scan with fallback` (secondary, passes `--engine js`), `Run doctor` (quiet, opens Kitty with `sweep doctor`). | Static amber notice. |
| 17 | **Permission denied** | Two forms: (a) partial unreadable subdirs (`skippedDirs > 0`) keeps normal settled card + amber footnote `Skipped 14 unreadable folders · sizes are a lower bound`; (b) target root unreadable (`error.code === "permission_denied"`) shows red `Ui.Notice`. | Root unreadable title: `Cannot read ~/Projects`<br>Detail: `Your account does not have permission to read this folder. Pick another scan root in Settings.`<br>Action: `Open Settings` (opens `Settings → Island`). | Static notice. |
| 18 | **Read-only Space report view** | Toggled via `Projects \| Space` `Segmented` control (or `sweep ui ~`). Strictly read-only (`readOnly: true`). Hero shows volume used (`342.4 GiB of 476.9 GiB used`), dim line `134.5 GiB free on volume · read-only overview`. 6-row dot bar spans all 11 C+ categories (`Developer`, `Apps`, `Photos`, `System data`, `Caches`, `Videos`, `Documents`, `Downloads`, `Trash`, `Music`, `Other`). 3-column legend with colored icons + binary sizes. | Hovering `Photos` (info-only): `Photos 58.6 GiB · Personal files are info-only. Sweep never queues or removes them.` (no action button).<br>Hovering `Developer`: `Developer 57.4 GiB · Project build artifacts and toolchains.` + `Review in Sweep`.<br>Hovering `Caches`: `Caches 32.4 GiB · Verified regenerable tool caches.` + `Review caches`.<br>Hovering `Trash`: `Trash 12.6 GiB · Items already moved to Trash on this volume.` + `Review Trash`. | Same `80 ms` hover dim and zero-shift hero swap as Projects view. Switching `Projects <-> Space` crossfades content in `Theme.quickMs` (`140 ms`, `Theme.easeOut`) while keeping the `640 px` panel width fixed (no horizontal morph). |

---

## (c) Data and performance policy

### When scans run

- **At rest (island closed):** Never. Zero timers, zero child processes, zero
  GPU frames. `SweepService.qml` holds only three passive `FileView` watchers
  (`watchChanges: true`) on:
  - `$XDG_CACHE_HOME/sweep/widget-v1.json`
  - `$XDG_STATE_HOME/sweep/last-receipt.json`
  - `$XDG_RUNTIME_DIR/sweep/active-apply.json`
- **On panel open:**
  1. Read `$XDG_CACHE_HOME/sweep/widget-v1.json` synchronously (`blockLoading: true`,
     file is `< 16 KiB`) so the panel renders on frame 1 with zero loading flash.
  2. If no cache exists, start one on-demand `sweep widget --json-stream` scan.
  3. If cache exists and `age <= 30 min`, treat as fresh (no scan).
  4. If cache exists and `age > 30 min`:
     - On AC power: display the cached snapshot immediately with `Refreshing…`
       subtle status while one low-priority refresh runs.
     - On battery (`host.env.onBattery === true`): display the cached snapshot
       with the `Cached · <age>` chip and **do not auto-scan**; wait for the
       user to click `Refresh`.
- **Optional scheduled refresh (off by default):** If the user explicitly opts
  in (`Settings → Island → Sweep → Refresh in background`), Kuwai enables a
  systemd user timer (`sweep-widget-refresh.timer`, default every 6 h,
  `ConditionACPower=true`, `RandomizedDelaySec=15m`) that runs
  `sweep widget --refresh --resource-profile low-memory` at `Nice=19` and
  `IOSchedulingClass=idle` and atomically replaces `widget-v1.json`. The shell
  itself still runs zero polling timers.

### Caching (L4 stale-cache alignment)

- Cache path: `$XDG_CACHE_HOME/sweep/widget-v1.json` (mode `0600`, written via
  temp file + `fsync` + atomic `rename`).
- Keyed by canonical `targetDir` and `view` (`projects` and `space` cached
  independently in a small map inside the file, bounded to `< 64 KiB` total).
- Staleness thresholds:
  - `< 30 min`: fresh (no badge).
  - `30 min .. 60 min`: quiet refresh on open (AC only).
  - `>= 60 min`: explicit `Cached · <age>` chip (`1 h ago`, `2 d ago`).
- Cache entries are strictly display-only (`readOnly: true`) and can never be
  passed to `sweep apply`.

### Cost limits, process safety, and cancellation

- Every scan launched by the QML service executes:
  ```text
  setpriv --pdeathsig KILL -- nice -n 19 ionice -c3 sweep widget <root> --json-stream --resource-profile low-memory
  ```
  - `setpriv --pdeathsig KILL` guarantees no orphan `sweep` process survives a
    shell crash or restart (required by Kuwai's `kuwai-check` gate).
  - `--resource-profile low-memory` bounds logical traversal memory to
    `SCAN_RESOURCE_PROFILES["low-memory"]` (`5,000` candidates, `50,000` dirs,
    `16 MiB` combined budget in `packages/protocol/src/index.ts:48-56`); explicit
    `Rescan` clicks use `balanced`.
  - `flock` on `$XDG_RUNTIME_DIR/sweep/widget.lock` ensures multi-monitor
    `IslandBar` instances never spawn duplicate scans.
  - Hard timeout: `45 s` for automatic open refresh, `120 s` for explicit
    `Rescan`. On timeout, send `SIGTERM`, wait `2 s`, then `SIGKILL`, and show
    the timeout notice while keeping any last-good cached snapshot visible.
- **Cancellation:** Clicking `Stop` or closing the island panel cancels an
  in-flight widget scan immediately (`SIGTERM`) and drops the `Process` handle.
  Clearing operations live in the user's Kitty window (`systemd-run --user
  --slice=app.slice`), so closing the island never interrupts an active removal.

### Battery policy

- On battery (`UPower.onBattery`):
  - No automatic stale-cache refresh on panel open.
  - No background systemd timer (`ConditionACPower=true`).
  - `LiquidRim` pointer specular shader stays off (already enforced by
    `LiquidRim.qml:26-27`).
  - Scanning dot shimmer steps at half rate or freezes when `reduceMotion` is on.

---

## (d) Visual tokens mapped from C+ onto Kuwai's theme system

**Ownership rule:** Kuwai's `Theme.qml` wins for every surface, material,
border, radius, font, text ink, elevation, motion curve, and primary action
accent (`Theme.accent`). Sweep's Direction C+ palette wins for data-encoding
hues (the 4 rebuild-cost buckets and 11 whole-disk categories), keeping all
data accents distinct from `Theme.accent`, `Theme.orange`, and `Theme.red`.

### Surfaces, typography, and controls (Kuwai wins)

| Role | Kuwai Token (`shell/config/Theme.qml`) | Resolved value (Kuwai Night) | Notes |
| --- | --- | --- | --- |
| Notch body fill | `NotchShape.fill` -> `Theme.notchGlassMid` -> `Theme.notchGlassBottom` | `rgba(0,0,0,0.94)` -> `rgba(6,6,8,0.86)` -> `rgba(9,9,12,0.78)` | Identical to every other Kuwai island panel; high contrast raises alpha to `0.96-0.98`. |
| Inner card fill | `Theme.card` | `rgba(255,255,255,0.05)` | Replaces C+'s solid `#1b1c1f` so the card breathes over Hyprland blur. |
| Inner card edge & drop | `Theme.cardEdge`, `Theme.cardDrop` | `rgba(255,255,255,0.05)` (`0.22` high contrast), `rgba(0,0,0,0.50)` | 1 px hairline + 1 px crisp drop (`Ui.Card`). |
| Unlit dot track | `Theme.wash(2)` | `rgba(255,255,255,0.10)` | Matches Kuwai's `LinkedBar.qml:80`. |
| Hover pill / row wash | `Theme.rowHover`, `Theme.wash(3)` | `rgba(255,255,255,0.06)`, `rgba(255,255,255,0.14)` | Legend pill hover and `FluidHighlight` fill. |
| Panel width & max height | `Theme.panelM`, `Theme.panelMaxH` | `640 px`, `600 px` | Matches `CleanupPanel.qml` and `SystemPanel.qml`; switching sections causes zero horizontal re-morph. |
| Radii | `NotchShape` `14 -> 30 px`, `Theme.r3`, `Theme.r2`, `Theme.r1` | `30 / 16 / 12 / 8 px` | Inner controls derive via `Theme.innerRadius(outer, inset)`. |
| Primary / secondary / tertiary ink | `Theme.textPrimary`, `Theme.textSecondary`, `Theme.textTertiary` | `rgba(255,255,255, 0.96 / 0.72 / 0.56)` | Contrast-verified over translucent glass (`0.88 / 0.74` when `Settings.highContrast`). |
| Primary button & focus ring | `Theme.accent`, `Theme.onAccent` | `#66c7ff` (Kuwai Night) / `#0a84ff` (default), `#000000` / `#ffffff` | Follows the user's active Kuwai theme live (400 ms `ColorAnimation`). |
| Semantic status tones | `Theme.green`, `Theme.orange`, `Theme.red` | `#30d158`, `#ff9f0a`, `#ff453a` | Clean receipt, caution/warning/stale, error/critical. |
| Typography | `Label.qml` (`SF Pro` if installed, else `Inter`) | Hero `Theme.tTitle1` (`26 px`, `wBold`, `tabular: true`), body `14 px`, sub `13 px`, footnote `12 px`, caption `11 px` | Honors owner's C+ approval: headline numbers use proportional sans-serif with tabular figures, not monospace. All container heights use `Theme.sp(n)`. |

### Data-encoding accent set & icons (Sweep C+ hues on Kuwai's `Symbols Nerd Font`)

All 4 rebuild-cost hues and 11 whole-disk category hues are carried verbatim
from Direction C+ (all verified `>= 5.0:1` contrast against `#111114` /
`#1b1c1f` / Kuwai glass and separated on the OKLCH hue wheel from Kuwai's
accent, orange, and red):

| View | Key | Label | Hex (C+ Dark) | OKLCH Hue | Nerd Font Glyph (`Theme.fontGlyph`) |
| --- | --- | --- | --- | --- | --- |
| Projects (cost) | `cache` | Caches | `#55d7be` | `178°` | `\u{f021}` (`nf-fa-refresh`) |
| Projects (cost) | `install` | Installs | `#ad9efd` | `290°` | `\u{f487}` (`nf-oct-package`) |
| Projects (cost) | `build` | Builds | `#fb984a` | `56°` | `\u{f4bc}` (`nf-oct-cpu`) |
| Projects (cost) | `custom` | Opt-in | `#ea85d3` | `336°` | `\u{f06e}` (`nf-fa-eye`) |
| Space (11 cats) | `developer` | Developer | `#ad9efd` | `290°` | `\u{f121}` (`nf-fa-code`) |
| Space (11 cats) | `apps` | Apps | `#5fc9f4` | `228°` | `\u{f2d0}` (`nf-fa-window_maximize`) |
| Space (11 cats) | `photos` | Photos | `#fa7fb3` | `355°` | `\u{f03e}` (`nf-fa-image`) |
| Space (11 cats) | `system_data` | System data | `#a6a19a` | Warm stone | `\u{f0a0}` (`nf-fa-hdd_o`) |
| Space (11 cats) | `caches` | Caches | `#55d7be` | `178°` | `\u{f021}` (`nf-fa-refresh`) |
| Space (11 cats) | `videos` | Videos | `#cf8bea` | `316°` | `\u{f008}` (`nf-fa-film`) |
| Space (11 cats) | `documents` | Documents | `#56d3da` | `200°` | `\u{f15c}` (`nf-fa-file_text`) |
| Space (11 cats) | `downloads` | Downloads | `#c6d163` | `114°` | `\u{f019}` (`nf-fa-download`) |
| Space (11 cats) | `trash` | Trash | `#fe895a` | `42°` | `\u{f1f8}` (`nf-fa-trash`) |
| Space (11 cats) | `music` | Music | `#90d378` | `138°` | `\u{f001}` (`nf-fa-music`) |
| Space (11 cats) | `other` | Other | `#dbae7b` | `70°` | `\u{f07b}` (`nf-fa-folder`) |

Surface brand / UI action glyphs from Kuwai's `Symbols Nerd Font` set:
Sweep mark `\u{f00e2}`, Rescan `\u{f0450}`, Terminal `\u{f018d}`, Warning
`\u{f0026}`, Check `\u{f05e0}`, Copy `\u{f018f}`.

### Motion token mapping (Kuwai `Theme.qml`)

| Interaction | Token | Value | Reduced motion (`Theme.reduceMotion`) |
| --- | --- | --- | --- |
| Island expand / collapse (pointer) | `Theme.surfaceIn` / `Theme.surfaceOut` | `{stiffness: 300, damping: 27.7}` / `{stiffness: 560, damping: 47.3}` | Instant shape snap; `140 ms` opacity crossfade |
| Island expand / collapse (keyboard) | `Theme.surfaceKeyIn` / `Theme.surfaceKeyOut` | `{stiffness: 560, damping: 47.3}` / `{stiffness: 900, damping: 60}` | Instant shape snap; `140 ms` opacity crossfade |
| Legend & dot-bar hover dim | `Theme.hoverMs` | `80 ms` (`0 ms` on `←`/`→` keys) | `0 ms` instant swap |
| Button / row press scale | `Theme.pressMs`, `Theme.easeOut` | `140 ms`, `[0.23, 1, 0.32, 1]`, `scale 0.97` | Disabled (`scale 1`) |
| View swap (`Projects <-> Space`) | `Theme.quickMs`, `Theme.easeOut` | `140 ms` opacity crossfade | `80 ms` opacity crossfade |
| Active scan shimmer | `Theme.shimmerMs` | `1300 ms` linear sweep | Paused (static muted track) |
| Active rescan icon spin | `Theme.spinMs` | `750 ms` linear rotation | Paused |
| Clearing dot dissolve | `Theme.glideMs`, `Theme.easeOut` | `140 ms` on real `deletedCount` change | Instant dot drop |
| Receipt green halo arrival | `Theme.enterMs` + `Theme.breathOutMs` | `200 ms` in + `1100 ms` fade once | Static green border, no flash |

---

## (e) Build plan, tests, and safe isolated preview

### PR-sized build sequence across both repositories

| PR | Repo | Scope | Key deliverables & acceptance gate |
| --- | --- | --- | --- |
| **PR 1** | `sweep` | Protocol & core rebuild-cost model | Move `rebuildFor()` into `packages/core/src/rebuild.ts`. Add `WidgetSnapshot` types and `packages/protocol/schemas/widget-snapshot.schema.json`. Unit tests validating every state/error/action variant with Ajv. Passes `bun run check`. |
| **PR 2** | `sweep` | `sweep widget` CLI, L4 cache, & receipt files | Implement `sweep widget [path] --json`, `--json-stream`, `--cache-only`, `--refresh`, `--view projects\|space`. Write atomic `0600` `$XDG_CACHE_HOME/sweep/widget-v1.json`, `$XDG_STATE_HOME/sweep/last-receipt.json`, and `$XDG_RUNTIME_DIR/sweep/active-apply.json` (from apply lifecycle). Contract tests for missing engine, permission denied, stale cache, clean/partial receipts. Passes `bun run check` + `bun run verify`. |
| **PR 3** | `sweep` | Quickshell QML module & standalone preview | Add `integrations/quickshell/Sweep/` (`qmldir`, `SweepPlugin.qml`, `SweepSurface.qml`, `SweepDotBar.qml`, `SweepService.qml`, `sweepFormat.mjs`, `manifest.template.json`), `sweep integrate kuwai` installer command, and `integrations/quickshell/preview/` harness. Tests: `bun test integrations/quickshell/Sweep/sweepFormat.test.mjs`, `qmllint --bare integrations/quickshell/Sweep/*.qml`. |
| **PR 4** | `rice` | Generic Island Panel plugin host | Extend `bin/kuwai-ext` with `panels` manifest validation and ownership checks; update `docs/EXTENDING.md`; add `shell/services/Plugins.qml` and `KuwaiPluginHost` loader in `IslandBar.qml` / `CleanupPanel.qml` / `IslandSplit.qml` with `Loader.Error` fault isolation. Tests: `pytest tests/test_ext.py`, `bun test`, `bin/kuwai-tokens --check`, `bin/kuwai-comments --check`. |
| **PR 5** | `rice` | Switch Sweep to plugin & retire legacy files | Point Cleanup `Projects` tab and `IslandSplit` optional capsule at the Sweep plugin; delete `bin/kuwai-sweep`, `shell/services/Sweep.qml`, `shell/services/sweepModel.js`, `shell/modules/island/SweepPanel.qml`; migrate `sweepMinGB` label to `GiB`; add rehearsal scenes for all Sweep states in `tests/ui/scenes.json`. Gates: `bin/kuwai-rehearse --gate` (100%, 120%, 200% text scale), `bin/kuwai-check`, `verify-kuwai` screenshots on DP-3. |

### Test matrix

1. **JSON contract tests (`sweep`):**
   - Ajv validation of `WidgetSnapshot` against
     `packages/protocol/schemas/widget-snapshot.schema.json` across fixtures for
     settled, empty, scanning, stale cache, suggestion, receipt (clean, trash,
     partial/failed), error, engine missing, permission denied, and 11-category
     Space report.
   - Guardrail test verifying `loadPlan` and `sweep apply --plan` reject any
     `WidgetSnapshot` document and that `space` info-only categories never emit
     an actionable intent.
   - Unit tests for `sweepFormat.mjs` verifying binary IEC rounding (`1024^3` =
     `1.0 GiB`, never `1.07 GB`), age strings, and non-truncating insight tiers.
2. **QML lint (`sweep` & `rice`):**
   - `qmllint --bare integrations/quickshell/Sweep/*.qml` in CI and local
     checks.
   - Verify no property named `data`, no bare `Text` rendering external paths
     without `Text.PlainText`, and `setpriv --pdeathsig KILL` on every spawned
     process.
3. **Kuwai rehearsal & live verification (`rice`):**
   - Add scenes to `tests/ui/scenes.json` covering: `sweep/settled`,
     `sweep/scanning`, `sweep/stale`, `sweep/point`, `sweep/suggestion`,
     `sweep/clearing`, `sweep/receipt`, `sweep/partial`, `sweep/error`,
     `sweep/not-installed`, `sweep/engine-missing`, `sweep/permission-denied`,
     `sweep/space`, and `sweep/worst` (very long repo/worktree names, 0 items).
   - Run `bin/kuwai-rehearse --gate` at 100%, 120%, and 200% text scale and
     inspect the contact sheet for zero `cut-off`, `on-top`, `spills`,
     `unreadable`, `insides`, or `waits-forever` faults.
   - Follow `.claude/skills/verify-kuwai/SKILL.md`: drive previews via
     `qs ipc -p ~/Projects/rice/shell call test preview cleanup DP-3`, capture
     with `grim`, confirm 0% idle CPU via `bin/kuwai-check`, and clean up with
     `q test clear` and `q island close`.

### Safe isolated preview without touching the running shell

To preview `integrations/quickshell/Sweep/` live on Hyprland without touching
`kuwai-shell.service`, `~/.config/kuwai`, or `~/.local/share/kuwai`:

```sh
preview_dir=$(mktemp -d /var/tmp/sweep-qs-preview.XXXXXX)
cp -r integrations/quickshell/preview/* "$preview_dir/"
ln -s "$PWD/integrations/quickshell/Sweep" "$preview_dir/Sweep"
```

Launch Quickshell against the temporary directory inside a normal
`FloatingWindow` (never a `WlrLayershell` with namespace `kuwai-islandbar`, so
it cannot collide with the running island or steal top-edge exclusive space):

```sh
SWEEP_PREVIEW_FIXTURE=settled \
TMPDIR=/var/tmp \
qs -p "$preview_dir"
```

- Toggle states live inside the preview window with number keys or pass
  `SWEEP_PREVIEW_FIXTURE=scanning|stale|receipt|space|error|...` to stage any
  contract fixture directly.
- Pass `KUWAI_REDUCE_MOTION=1` or `SWEEP_PREVIEW_TEXT_SCALE=1.2` to verify
  reduced-motion and 120% text scaling before promoting anything into `rice`.
- Close the preview window (`Ctrl+C`) and remove `$preview_dir` when done; the
  owner's desktop shell is never reloaded or disturbed.
