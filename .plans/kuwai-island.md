Status: planned
Scope: integrations, protocol, cli, core, engine, docs
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

Today, `/home/kitsunekode/Projects/rice` ships a first-generation Sweep
integration across four files:

- `bin/kuwai-sweep`: 373-line Python wrapper that runs `sweep status --json`
  (or falls back to `sweep scan --json`), re-implements `summarize()`, caches
  to `~/.local/state/kuwai/sweep-status.json` with a 6 h TTL, and owns terminal
  launch commands.
- `shell/services/Sweep.qml`: polls `bin/kuwai-sweep` on a 45 s startup timer
  and a 300 s repeat timer, watches `sweep-status.json`, tracks `sweep-viewed`,
  and registers `IpcHandler { target: "sweep" }`.
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

| Skill                          | Where applied in this design                                              | Concrete rule carried over                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kuwai-ui`                     | Entire QML surface, token usage, idle cost                                | Use `Theme.qml` tokens and `Label`/`Spring`/`Ui.*` primitives; 0% CPU at rest; orphan-free child lifecycle (`setpriv --pdeathsig KILL` + engine parent-death teardown); never name a property `data`; no bare `Text` for external strings. |
| `apple-design`                 | Island notch morph, spring interruptibility, translucency, reduced motion | Velocity-preserving springs (`surfaceIn`/`surfaceOut`); enter and exit along the top edge (`NotchShape`, never floating cards under the notch); rubber-banding past pull thresholds; `reduceMotion` drops travel/scale and keeps fades.    |
| `emil-design-eng`              | Animation frequency gate, curves, press feedback, blur-masked swaps       | No animation on 100+/day keyboard actions; `cubic-bezier(0.23, 1, 0.32, 1)` ease-out; `scale(0.97)` on press (`140 ms`, plate only); never `scale(0)`; subtle blur (`<= 3 px`) only on content swaps.                                      |
| `animate`                      | Every individual state transition                                         | Pick the cheapest mechanism; every moving element names its purpose (`Feedback`, `State indication`, `Spatial consistency`, `Preventing a jarring change`).                                                                                |
| `find-animation-opportunities` | Motion restraint audit                                                    | Reject ambient idle loops, settled-bar shimmer, and keyboard arrow lag; keep motion strictly to active scan, active clearing, and rare receipt arrival.                                                                                    |
| `improve-animations`           | Retiring Kuwai's old SweepPanel wipe/poll behavior                        | Replace `SweepPanel`'s ad-hoc bar reveal and background timer with event-driven transitions tied to real scan and apply events.                                                                                                            |
| `animation-vocabulary`         | Precise motion names in the state table                                   | Use exact terms: Morph, Crossfade, Continuity transition, Origin-aware animation, Press feedback, Rubber-banding, Tabular numbers.                                                                                                         |
| `choreograph`                  | Island open/close and view swap sequencing                                | One entrance per container (the notch shape leads on `pv`, content fades/rises once together; no per-row stagger in high-frequency lists).                                                                                                 |
| `animation-performance`        | Frame budget and QML layer discipline                                     | Animate transform/opacity only; never leave `ShaderEffectSource` `live: true` over animating content; disable `LiquidRim` pointer specular pass on battery.                                                                                |
| `transitions-polish`           | Open/close asymmetry and hover timing                                     | Close faster than open (`surfaceOut` / `exitMs 140 ms` vs `surfaceIn` / `enterMs 200 ms`); hover highlight responds in `80 ms` (`Theme.hoverMs`).                                                                                          |
| `fluid-functionalism`          | Spring tiers, concentric radii, fluid row highlight                       | `Theme.springFast` / `springModerate` / `springSlow`; `FluidHighlight` for project rows; concentric `Theme.innerRadius(outer, inset)`.                                                                                                     |
| `tactile-design`               | Hierarchy, button roles, copy discipline, empty/error layouts             | One bold hero figure and one primary action per view; destructive actions never primary; `Ui.Notice` has at most one action; copy button ticks only after clipboard write resolves; plain words, no em dashes.                             |
| `interaction-design`           | Loading skeletons, progress feedback, accessible focus                    | Layout-preserving shimmer only while actively loading; clear focus rings; never block input during transitions; full keyboard support on interactive controls.                                                                             |
| `gestures`                     | Capsule pull-down to open and swipe-up to dismiss                         | 1:1 track phase during drag, damped wrong-way travel (`Theme.swipeDamp`), velocity-seeded spring release via `Fling`.                                                                                                                      |
| `pick-ui-library`              | Confirming native stack choices                                           | Reuse `qs.components` and `qs.components.ui` (`Button`, `Card`, `Notice`, `Chip`, `Segmented`, `FluidHighlight`, `Spring`, `ScrollFade`, `ScrollHint`) and document why `SweepDotBar` extends `LinkedBar`.                                 |
| `verify-kuwai`                 | Testing and preview plan                                                  | Never move the live pointer, type synthetic keys, or touch `~/.local/share/kuwai`; verify with `qmllint`, `kuwai-rehearse --gate`, `kuwai-check`, and isolated `qs -p <tmpdir>`.                                                           |

---

## (a) Integration architecture without duplication

### Structural decision: an in-process QML plugin is not a sandbox

An earlier draft proposed a generic in-process QML plugin host (`Loader`) with
an `allowedCommands` manifest field and a `host.ui` JS object. Review against
Kuwai's live shell exposed three hard realities:

1. **In-process QML is trusted local code, never a sandbox.** Any QML loaded by
   Quickshell `Loader` runs inside the shell process with full Qt/Quickshell
   capabilities (including spawning `Process` directly). A manifest field like
   `allowedCommands: ["sweep"]` cannot restrict a QML file, and a bare command
   name violates Kuwai's absolute-path + ownership rule (`docs/EXTENDING.md:24`,
   `bin/kuwai-ext:78`).
2. **Fault isolation from `Loader` is partial.** `Loader.Error` catches compile
   and load errors only (and `IslandBar.qml:1310` currently closes the panel on
   error rather than showing a notice). Runtime exceptions, teardown bugs, or
   runaway timers in loaded QML can still stall or crash the shell.
3. **JS `host.ui` references do not work declaratively in QML.** You cannot
   write `host.ui.Button { ... }` in QML without `Loader` or `createObject`
   wrappers around every control. A real plugin ABI requires a versioned QML
   import module (`import Kuwai.Plugin 1.0`) plus matching preview stubs.

Given those realities, there are two viable architectures for integrating
`sweep` into Kuwai without duplicating domain logic. Both use the exact same
`sweep widget --json` / `--json-stream` contract, cache files, and receipt
files.

#### Option A (Recommended for v1): All domain logic in `sweep` behind `sweep widget --json`, thin Kuwai-owned QML panel

- **Owned by `sweep`:** 100% of domain logic, rebuild-cost classification
  (`packages/core/src/rebuild.ts`), idle/worktree aggregation, binary IEC
  formatting helpers and structured labels, suggestion ranking, L4 cache,
  `active-apply.json`, `last-receipt.json`, error classification, and CLI
  handoff flags (`--view`, `--focus`).
- **Owned by Kuwai (`rice`):** A thin, rendering-only QML panel
  (`shell/modules/island/SweepPanel.qml`, ~150 lines) plus `SweepDotBar.qml`
  and a thin passive `shell/services/Sweep.qml` watcher (zero polling timers,
  no `Process` spawning except a fixed absolute-path argv to the validated
  `sweep` binary).
- **Security and reliability:** Zero external QML loading. The `sweep` binary
  path is resolved from a fixed allowlist (`~/.local/bin/sweep`,
  `~/.bun/bin/sweep`, `/home/linuxbrew/.linuxbrew/bin/sweep`,
  `/usr/local/bin/sweep`, `/usr/bin/sweep`). Because package-manager shims such
  as `~/.bun/bin/sweep` and Homebrew (`/home/linuxbrew/.linuxbrew/bin/sweep`,
  `/usr/local/bin/sweep`) are symlinks, Kuwai resolves each candidate with
  `realpath` before validating ownership and permissions (`st_uid in (0,
  getuid())`, `!(mode & 0o022)`, regular executable, plus non-group/world-writable
  parent directories along the resolved path) and executes the resolved absolute
  path directly with no shell.
- **Kuwai tooling fit:** Natively imports `qs.config` (`Theme`) and
  `qs.components.ui`, passes `bin/kuwai-tokens --check`,
  `bin/kuwai-comments --check`, `bin/kuwai-rehearse --gate`, and
  `bin/kuwai-check` with zero ABI bridge.
- **Standalone binary (`install.sh`) fit:** Works immediately when the user
  installs `sweep` via `install.sh`, Homebrew, npm, or AUR. No QML files need
  to be extracted or kept in sync on disk.
- **Kuwai PR sizing:** **1 small PR (~250-350 lines added/modified, ~900 lines
  deleted)** because `bin/kuwai-sweep` (373 lines), `shell/services/sweepModel.js`,
  old `Sweep.qml` polling timers, and old `SweepPanel.qml` are deleted. Net
  change in `rice` is roughly **-600 to -650 lines**.
- **Generic plugin host:** Explicitly deferred until a second real external
  island panel exists to justify designing and maintaining a versioned QML ABI.

#### Option B: Generic Kuwai plugin host now (`import Kuwai.Plugin 1.0`)

- **Owned by `sweep`:** Everything in Option A plus
  `integrations/quickshell/Sweep/` (`qmldir`, `SweepPlugin.qml`,
  `SweepSurface.qml`, `SweepDotBar.qml`, `SweepService.qml`, `sweepFormat.mjs`,
  `manifest.template.json`), `integrations/quickshell/preview/` (with stubbed
  `Kuwai.Plugin 1.0`), and `sweep integrate kuwai` (which must also extract
  embedded QML assets from the standalone `install.sh` binary into
  `~/.local/share/sweep/quickshell/Sweep/` and refresh them on upgrade).
- **Owned by Kuwai (`rice`):**
  1. `import Kuwai.Plugin 1.0` versioned QML module wrapping Kuwai's stable UI
     primitives (`Button`, `Card`, `Notice`, `Chip`, `Segmented`, `Label`,
     `FluidHighlight`, `ScrollFade`, `ScrollHint`, `Theme` tokens) so external
     QML never imports internal `qs.*` paths directly.
  2. Recursive manifest and module validation in `bin/kuwai-ext panels`:
     - `manifest.json` must be strictly `st_uid == getuid()`, mode `& 0o022 == 0`,
       regular file (no symlinks).
     - `moduleDir` and every `qmldir`, `.qml`, and `.mjs` file inside it are
       validated recursively: `st_uid in (0, getuid())` (so both root-owned
       `/usr/share/sweep/quickshell/Sweep` and user-owned
       `~/.local/share/sweep/quickshell/Sweep` work), `!(mode & 0o022)`,
       `realpath` strictly contained inside `realpath(moduleDir)`, and zero
       symlinks escaping `moduleDir`.
     - Any `allowedCommands` entry must be an absolute executable path passing
       the same ownership and non-writable check (no bare `"sweep"`, no `PATH`
       lookup, no shell).
     - Manifest glyph uses a valid JSON escape (`"\udb80\udce2"`) or literal
       UTF-8 glyph (never invalid 5-digit `"\uf00e2"`).
     - Host resolves XDG paths from a fixed token map (`XDG_CACHE_HOME`,
       `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`) or drops `watchPaths` from the
       manifest (QML `FileView` does not expand raw `$XDG_*` strings).
  3. Runtime guardrails (acknowledging that loaded QML is trusted local code,
     not a sandbox):
     - `KUWAI_NO_PLUGINS=1` environment kill switch disables all external QML
       plugins at startup.
     - Crash-loop auto-disable: host writes a pending load marker before
       instantiating plugin QML and clears it after a clean frame; 3 crashes or
       load errors within 5 minutes auto-disable the plugin and surface a single
       `Ui.Notice`.
     - Strict lazy load: plugin QML loads ONLY when the user opens the panel.
       Rest-state capsules are driven purely by host-owned `FileView` reads of
       JSON state files so zero plugin code runs at shell startup.
     - `IslandBar.qml:1310` updated so `Loader.Error` renders a single
       `Ui.Notice` instead of closing the panel silently.
- **Kuwai PR sizing:** **2 larger PRs (~800-1,200 lines added across
  `bin/kuwai-ext`, `Kuwai.Plugin 1.0`, `shell/services/Plugins.qml`,
  `IslandBar.qml`, `CleanupPanel.qml`, `IslandSplit.qml`, tests, plus legacy
  retirement)**.

#### Comparison and clear recommendation

| Criterion                               | Existing capsule contract (`kuwai capsule`) | Option A: Thin Kuwai panel + `sweep widget --json` (Recommended) | Option B: Generic `Kuwai.Plugin 1.0` host                                           |
| --------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Rich dot-matrix card & Space view       | Not possible (40-char text only)            | Full native QML panel in `NotchShape`                            | Full native QML panel in `NotchShape`                                               |
| Single source of truth for domain logic | Weak (script still summarizes & polls)      | Strong (100% domain logic in `sweep`)                            | Strong (domain logic + QML in `sweep`)                                              |
| Zero polling at rest                    | No (needs timer)                            | Yes (passive `FileView` watchers only)                           | Yes (passive `FileView` watchers only)                                              |
| External QML execution risk             | None                                        | None (all QML reviewed in `rice`)                                | Trusted local code (not a sandbox; needs recursive validation + crash-loop breaker) |
| Standalone `install.sh` binary delivery | Works                                       | Works immediately (no QML extraction)                            | Requires embedding & extracting QML via `sweep integrate kuwai`                     |
| Kuwai (`rice`) PR size                  | 0                                           | **1 small PR (~250-350 LOC added, ~900 deleted; net -600+ LOC)** | **2 large PRs (~800-1,200 LOC added, plus ABI maintenance)**                        |

**Recommendation for the owner: pick Option A for v1.** Today `sweep` is the
only external panel consumer. Option A eliminates 100% of domain duplication
and background polling while _shrinking_ `rice` by ~600+ lines in one small PR,
keeps Kuwai's token/comment/rehearsal gates native, avoids shipping an
un-sandboxed in-process QML ABI before a second consumer needs it, and works
automatically for `install.sh` users. Because the `sweep widget --json`
protocol and cache/receipt files are identical under both options, Option B can
be added later with zero breaking changes to `sweep`.

---

### Versioned JSON contracts (`sweep widget`)

All contracts below live in `packages/protocol/src/widget.ts` with JSON Schemas
in `packages/protocol/schemas/` and Ajv contract tests. Additive evolution stays
within `widgetSchemaVersion: 1`; breaking changes bump to `2`, and Kuwai checks
`snapshot.widgetSchemaVersion === 1` before rendering (showing an explicit
`"Update Sweep or Kuwai to match"` notice on mismatch).

#### 1. Snapshot contract (`sweep widget [path] --json`)

Schema file: `packages/protocol/schemas/widget-snapshot.schema.json`.

```json
{
  "widgetSchemaVersion": 1,
  "protocolVersion": "1",
  "readOnly": true,
  "view": "projects",
  "supportedViews": ["projects"],
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
    "usedBytes": 478781456384,
    "freeBytes": 33285996544
  },
  "projectsSummary": {
    "reclaimableBytes": 61633196850,
    "safeBytes": 61203280690,
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
      "bytes": 3758096384,
      "byCost": [
        {
          "cost": "cache",
          "label": "Caches",
          "bytes": 230686720,
          "count": 4,
          "hint": "Comes back on its own"
        },
        {
          "cost": "install",
          "label": "Installs",
          "bytes": 2254857830,
          "count": 5,
          "hint": "Reinstalls from lockfile"
        },
        {
          "cost": "build",
          "label": "Builds",
          "bytes": 1272551834,
          "count": 5,
          "hint": "Rebuilds on next compile"
        }
      ]
    },
    "byCost": [
      {
        "cost": "cache",
        "label": "Caches",
        "bytes": 2254857830,
        "count": 41,
        "hint": "Comes back on its own"
      },
      {
        "cost": "install",
        "label": "Installs",
        "bytes": 41446431129,
        "count": 96,
        "hint": "Reinstalls from lockfile"
      },
      {
        "cost": "build",
        "label": "Builds",
        "bytes": 17501991731,
        "count": 48,
        "hint": "Rebuilds on next compile"
      },
      { "cost": "custom", "label": "Opt-in", "bytes": 429916160, "count": 6, "hint": "Check first" }
    ],
    "topProjects": [
      {
        "name": "old-renderer",
        "repo": "sweep",
        "path": "/home/kitsunekode/Projects/sweep/.worktrees/old-renderer",
        "bytes": 1288490188,
        "idleDays": 42,
        "worktreeState": "merged"
      }
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

Sample math verification:

- `disk`: `478,781,456,384` (`445.9 GiB`) + `33,285,996,544` (`31.0 GiB`) =
  `512,067,452,928` (`476.9 GiB`).
- `byCost`: `2,254,857,830` (`2.1 GiB`) + `41,446,431,129` (`38.6 GiB`) +
  `17,501,991,731` (`16.3 GiB`) + `429,916,160` (`410 MiB`) = `61,633,196,850`
  (`57.4 GiB`) = `reclaimableBytes` = `safeBytes + cautionBytes`.
- `worktrees.byCost`: `230,686,720` (`220 MiB`) + `2,254,857,830` (`2.1 GiB`) +
  `1,272,551,834` (`1.2 GiB`) = `3,758,096,384` (`3.5 GiB`) = `worktrees.bytes`.

#### 2. NDJSON streaming contract (`sweep widget [path] --json-stream`)

Schema file: `packages/protocol/schemas/widget-event.schema.json`. Each stdout
line is one JSON object discriminated by `type`. Progress frames are coalesced
in `sweep` to `<= 12 Hz` (`>= 80 ms` between `widget_progress` frames):

```json
{"type":"widget_started","widgetSchemaVersion":1,"view":"projects","targetDir":"/home/kitsunekode/Projects","startedAt":"2026-11-27T20:15:00.000Z"}
{"type":"widget_progress","widgetSchemaVersion":1,"view":"projects","scannedDirs":1420,"found":118,"sizedCount":84,"estimatedBytes":15290085376,"currentDir":"packages/ui/node_modules","byCost":[{"cost":"cache","bytes":671088640},{"cost":"install","bytes":10522669875},{"cost":"build","bytes":4080218931}]}
{"type":"widget_snapshot","widgetSchemaVersion":1,"snapshot":{ "...full WidgetSnapshot..." }}
```

On failure, the stream terminates with a single `widget_error` line (and a
non-zero exit code) carrying the closed `WidgetError` object below:

```json
{
  "type": "widget_error",
  "widgetSchemaVersion": 1,
  "error": {
    "code": "permission_denied",
    "message": "Your account does not have read permission on this folder.",
    "retryable": false
  }
}
```

#### 3. Multi-entry L4 cache envelope (`$XDG_CACHE_HOME/sweep/widget-v1.json`)

Projects L4 caching uses a bounded multi-entry envelope (`0600`, temp file +
`fsync` + atomic `rename`, max 8 entries, `< 64 KiB` total). Reading the cache
looks up `entries[canonicalTargetDir]`, never assuming the file root is a bare
`WidgetSnapshot`:

```json
{
  "cacheVersion": 1,
  "entries": {
    "/home/kitsunekode/Projects": {
      "widgetSchemaVersion": 1,
      "readOnly": true,
      "view": "projects",
      "source": "cache",
      "...": "WidgetSnapshot fields"
    }
  }
}
```

**Space L4 cache reconciliation with [space-report.md](space-report.md):**
Space snapshots are **never** stored inside `widget-v1.json` with local paths.
In v1b, `sweep widget --view space --cache-only` reads
`<configDir>/space-cache.json` (`SpaceCacheSnapshot`, Section 4.3 of
[space-report.md](space-report.md)), which is strictly **aggregate-only and
path-free** (keyed by HMAC-SHA256 with a local `0600` salt; zero `targetDir`,
zero mount labels, zero filenames, zero project basenames). Consistent with
[space-report.md](space-report.md), all Space review actions stay disabled while
displaying a cached `SpaceCacheSnapshot` until a fresh complete scan settles.

#### 4. Active apply observation (`$XDG_RUNTIME_DIR/sweep/active-apply.json`)

Written atomically (`0600`) by `sweep ui` and `sweep apply` only while removal
is actively running (fallback directory: `$XDG_CACHE_HOME/sweep/` if
`$XDG_RUNTIME_DIR` is unset), and unlinked on clean exit.

```json
{
  "applyVersion": 1,
  "pid": 48210,
  "startedAt": "2026-11-27T20:16:10.000Z",
  "updatedAt": "2026-11-27T20:16:14.200Z",
  "targetDir": "/home/kitsunekode/Projects",
  "mode": "delete",
  "stage": "applying",
  "selectedCount": 12,
  "deletedCount": 3,
  "failedCount": 0,
  "estimatedBytesFreed": 1932735283,
  "activeCost": "build",
  "activePath": "packages/web/.next"
}
```

**Liveness and dead-PID cleanup (mirrors `Island.qml:109-131`):** If `sweep` is
terminated with `SIGKILL` mid-apply, `active-apply.json` can remain on disk.
While `active-apply.json` is present, Kuwai checks two conditions (re-checked
on a 4 s timer that runs _only_ while `active-apply.json` exists):

1. `/proc/<pid>/cmdline` exists and identifies a live `sweep` process.
2. `Date.now() - Date.parse(updatedAt) < 30000` (sweep refreshes `updatedAt` at
   least every 5 s during a long single-item removal).

If either check fails, Kuwai treats the file as orphaned, leaves State 11
immediately, and renders the normal settled/cached view.

#### 5. Post-apply receipt (`$XDG_STATE_HOME/sweep/last-receipt.json`)

Written atomically (`0600`) once when `sweep ui` or `sweep apply` finishes an
apply run (clean, partial, or stopped).

```json
{
  "receiptVersion": 1,
  "id": "01JDX9R6H8Q7N4K2V1M8W5B3C0",
  "completedAt": "2026-11-27T20:16:28.000Z",
  "targetDir": "/home/kitsunekode/Projects",
  "mode": "delete",
  "deletedCount": 5,
  "failedCount": 0,
  "unattemptedCount": 0,
  "stopped": false,
  "totalBytesFreed": 3758096384,
  "freeBytesAfter": 37044092928,
  "failureSummary": null
}
```

Field and lifecycle rules:

- `mode`: `"delete"` or `"trash"`. When `mode === "trash"` on the same volume,
  `totalBytesFreed` is `0` and the UI shows `"5 items moved to Trash · 0 B freed on volume until purged"` rather than claiming volume space shrank.
- `failureSummary` (present when `failedCount > 0`): `{ "busy": 1, "permissionDenied": 1, "other": 0 }`.
- **Dismissal and expiry:** State 12 (clean receipt) or State 13 (partial/failed
  receipt) returns to State 4 (settled) when any of the following occurs:
  1. The user clicks `Done` (Kuwai stores `dismissedReceiptId = receipt.id` in
     `$XDG_STATE_HOME/kuwai/sweep-state.json`).
  2. The user clicks `Rescan` or launches `sweep ui` from the receipt.
  3. `24 h` has elapsed since `completedAt`.

#### 6. Space view sub-contract (`space` field, v1b)

Populated only when `--view space` is requested after
[space-report.md](space-report.md) lands. Mirrors `SpaceReport` /
`SpaceCacheSnapshot` directly:

```json
{
  "volume": {
    "totalBytes": 512067452928,
    "usedBytes": 367649177600,
    "availableBytes": 144418275328,
    "bytesBasis": "statvfs",
    "accountingDomainComparable": true
  },
  "coverage": {
    "complete": true,
    "incompleteReasons": [],
    "scopeExclusions": [],
    "accountingCaveats": []
  },
  "categories": [
    {
      "id": "developer",
      "label": "Developer",
      "allocatedBytes": 61632780697,
      "apparentBytes": 61632780697,
      "bytesKnown": true,
      "actionability": "review",
      "actionIntent": "review_space_developer",
      "actionLabel": "Review in Sweep",
      "detail": "Project build artifacts and toolchains. Opens Sweep with an empty queue."
    },
    {
      "id": "photos",
      "label": "Photos",
      "allocatedBytes": 62921270886,
      "apparentBytes": 62921270886,
      "bytesKnown": true,
      "actionability": "info_only",
      "detail": "Personal files are info-only. Sweep never queues or removes them."
    },
    {
      "id": "system_data",
      "label": "System data",
      "bytesKnown": false,
      "unknownReason": "incomparable_domain",
      "actionability": "info_only",
      "detail": "Unclassified volume residual is unknown on CoW filesystems (Btrfs/APFS)."
    }
  ]
}
```

Space invariants:

- `categories` always contains the exact 11 mutually exclusive IDs from
  [space-report.md](space-report.md): `developer`, `apps`, `photos`,
  `system_data`, `caches`, `videos`, `documents`, `downloads`, `trash`, `music`,
  `other`.
- Only `developer`, `caches`, and `trash` may carry `actionability: "review"`
  and an `actionIntent` (`review_space_developer`, `review_space_caches`,
  `review_space_trash`), and only when `coverage.complete === true`,
  `source === "live"`, and `non_local_filesystem` is absent. All other 8
  categories are locked to `actionability: "info_only"` forever.
- When `bytesKnown === false` (for example `system_data` on a CoW Btrfs/APFS
  volume where `accountingDomainComparable === false`, or an unread folder, or
  `hardlink_dedup_cap`), `allocatedBytes` and `apparentBytes` are omitted,
  `unknownReason` is required, the category renders as `"Unknown"` in the legend
  (not `0 B`), and its dots are omitted from the bar rather than fabricated.

#### 7. Structured error sub-contract (`error` field)

```json
{
  "code": "engine_missing",
  "message": "Native scan engine unavailable. Scans can still run with the fallback scanner.",
  "retryable": true,
  "fallbackAvailable": true
}
```

Closed `code` enum:

- `"not_installed"` (synthesized by Kuwai when `sweep` binary is absent)
- `"engine_missing"` (native Rust `sweep-engine` binary missing or incompatible)
- `"permission_denied"` (target root cannot be read)
- `"target_missing"` (configured target root does not exist)
- `"target_refused"` (configured target root is refused by Sweep guardrails, e.g. `~`, `/`, `/etc`, or `.git`)
- `"config_invalid"` (`.sweeprc` or Sweep config failed parsing or validation)
- `"timeout"` (scan exceeded wall-clock budget)
- `"scan_failed"` (generic non-zero exit or malformed stream)
- `"schema_mismatch"` (synthesized by Kuwai when `widgetSchemaVersion !== 1`)

`message` is always a plain user-facing sentence and never contains helper
filenames, stack traces, raw OS paths, or exit codes (passing Kuwai's
`REHEARSAL.md` `insides` gate).

#### 8. Protocol safety invariants

- `readOnly: true` is always set; `sweep apply --plan` and `loadPlan()` reject
  any `widgetSchemaVersion` document unconditionally.
- `action` carries a closed discriminated `intent` (`review_projects`,
  `review_space_developer`, `review_space_caches`, `review_space_trash`,
  `inspect_receipt`), never an arbitrary command string. Kuwai builds the argv
  array (`[resolvedSweepPath, "ui", ...]`) from a fixed whitelist and launches
  it via `Apps.run` and `bin/kuwai-term` (supporting `$KUWAI_TERMINAL`: Kitty,
  Ghostty, Foot, Alacritty, WezTerm, etc.) inside `systemd-run --user
  --slice=app.slice`.

---

### Panel chrome, `CleanupPanel` tabs, and legacy retirement in Kuwai

#### Panel chrome fidelity (`IslandBar.qml`, `CleanupPanel.qml`, `Notice.qml`)

1. **`backStrip` has no right-side action slot (`IslandBar.qml:1210-1294`).**
   `backStrip` renders only the left title/`headerMeta` (`Cleanup · Sweep`) or
   Back pill and the centered 4-icon section switcher (`Agents`, `Usage`,
   `System`, `Cleanup`). The quiet `Rescan` and `Open terminal` icon buttons
   therefore live inside `SweepPanel`, not in `backStrip`.
2. **One `Segmented` bar inside `CleanupPanel.qml` above Sweep's own slim sub-row (never stacked tabs or crowded shared rows).**
   `CleanupPanel.qml:132-139` renders a single top `Segmented` control
   (`Skills | Idle projects | Caches | Leftovers`) and mounts `SweepPanel`
   directly below it (`Loader { id: projects; y: viewSwitch.y + viewSwitch.height }`
   at `CleanupPanel.qml:150-158`). Sweep does **not** render a second nested
   `Projects | Space` segmented control, and it does **not** share
   `viewSwitch`'s horizontal row (which already holds up to 5 tabs with
   `Leftovers` and would collide at `120%` and `200%` text scale under
   `bin/kuwai-rehearse --gate`):
   - **v1a:** `CleanupPanel`'s single top `Segmented` control is
     `Skills | Projects | Caches | Leftovers` (renaming `Idle projects` to
     `Projects`).
   - **v1b** (once `supportedViews` advertises `"space"`): `Space` is added as
     a peer option in that **same** single `Segmented` control:
     `Skills | Projects | Space | Caches | Leftovers`.
   - **Sweep's slim status/action row:** Mounted at the top of `SweepPanel`
     directly below `viewSwitch`, holding Sweep's state chip on the left and
     the quiet `Rescan` and `Open terminal` icon buttons on the right. If that
     slim sub-row itself overflows at `200%` text scale, the right-side action
     buttons wrap onto a second line using the same `below` width check pattern
     as `daysSwitch.below` (`CleanupPanel.qml:142`).
3. **`Ui.Notice` single-action rule (`shell/components/ui/Notice.qml:15-42`,
   `docs/DESIGN.md:178`).** `Ui.Notice` supports at most one `action` button.
   States 14 (`error`) and 16 (`engine-missing`) put their primary recovery
   button (`Try again` / `Scan with fallback`) inside `Ui.Notice` and place any
   secondary link (`Open terminal` / `Run doctor`) in the footer row below the
   notice.

#### Legacy retirement and migration safeguards in Kuwai (`rice`)

When replacing Kuwai's first-generation Sweep files (`bin/kuwai-sweep`,
`shell/services/sweepModel.js`, old `Sweep.qml` polling timers, old
`SweepPanel.qml`):

1. **Preserve `Settings.sweepMinGB` key.** `shell/config/Settings.qml:94` and
   `settings-schema.json:891` persist `sweepMinGB`. Keep the persisted JSON key
   name unchanged so existing user `settings.json` files do not break; update
   the UI display label in Settings to `GiB` (computing `sweepMinGB * 1024^3`).
2. **Preserve `Island.open("sweep")`, `IpcHandler { target: "sweep" }`, and
   `sweep-viewed`.** Keep `Island.open("sweep")` / `Island.toggle("sweep")`
   routing to `cleanup` with `cleanupView = "projects"`, keep
   `IpcHandler { target: "sweep" }` (`open()` and `refresh()`), and keep
   `~/.local/state/kuwai/sweep-viewed` suppression logic so the capsule steps
   back after the user has looked and only reappears after `+5 GiB` growth.
3. **Keep the capsule mark inside `SysMarks` / `sysPill`.** `IslandBar.qml:193-199`
   masks `split.pills[0..6]` while `IslandSplit.qml:240` already declares 8
   pills. Hosting Sweep's rest mark inside `SysMarks` / `sysPill` (as Kuwai
   already does) requires zero input-mask changes. (If Option B ever adds a
   dedicated plugin pill, `IslandBar.qml:193-199` must be extended to mask it.)
4. **Safe fallback for unmigrated or uninstalled users.** If the `sweep` binary
   is missing (or under Option B, if no plugin manifest exists yet), the
   `Projects` tab renders State 15 (`Sweep is not installed`) rather than a
   blank or broken tab.

---

## (b) Complete state specification

### Trust invariant across every state

1. **The island never deletes on one click.** There is no "Delete", "Clear now",
   or "Empty Trash" button anywhere in the Sweep island surface.
2. **Every removal goes through `sweep ui`.** Clicking `Review in Sweep` (or a
   category review button) launches `sweep ui` in the user's configured
   terminal (`bin/kuwai-term`, `$KUWAI_TERMINAL`, defaulting to Kitty if unset)
   at the right view (`--view projects`, `--focus worktrees|idle`, or in v1b
   `--view space`) with an **empty queue**, where Sweep's full review list,
   risk reasons, blocked-item guards, trash toggle, and explicit `y`
   confirmation run unchanged (see
   [.docs/ux-principles.md](../.docs/ux-principles.md)).
3. **Why terminal handoff instead of an inline QML confirm sheet:** Duplicating
   Sweep's apply confirmation inside QML would either hide per-item risk reasons
   and blocked subtrees (weakening consent) or re-implement inode/device
   revalidation and dangerous-item confirmation in a second language (creating
   safety drift). Opening `sweep ui` in the terminal takes one keypress,
   preserves every guardrail, and returns a verified receipt to the island when
   finished.
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
  pointer hover; `0 ms` instant step on `<-`/`->` keyboard focus.
- Press feedback on buttons/rows: `RaisedButton` scales the plate to `0.97`
  while the text stays still (`Theme.pressMs 140 ms`, `Theme.easeOut`); rows
  scale to `0.985`.
- Active scan/clearing only: shimmer sweep `Theme.shimmerMs` (`1300 ms`) or
  `Ui.Button { busy: true }` (`Theme.spinMs 750 ms`). Stops immediately when
  settled or under `Theme.reduceMotion`.
- Settled state: zero timers, zero animations, zero frame redraws.

### State-by-state specification (18 visual states: 17 visible + hidden rest)

| #   | State                                           | Surface & Layout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Exact Copy (plain voice, binary units)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Motion & Interactivity                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Rest (hidden, default)**                      | No Sweep mark shown. Notch shows normal Kuwai rest row (`workspaces · clock · status`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 0% CPU, zero polling, zero timers.                                                                                                                                                                                                                                              |
| 2   | **Rest (optional capsule)**                     | Shown only when `Settings.sweepMark` is on, a cached scan exists with idle/worktree bytes `>= Settings.sweepMinGB` (labeled `GiB` in UI, default `10 GiB`), and bytes grew by `>= 5 GiB` since `sweep-viewed`. Hosted in right-side `SysMarks` / `sysPill` (`28 px` tall, `rgba(0,0,0,0.94)`, `1 px rgba(255,255,255,0.07)`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Glyph `\u{f00e2}` + `10.3 GiB` (tabular).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Buds once via `sv` spring (`surfaceIn`). Completely still once out. Swipe up dismisses until threshold changes; click or pull down opens expanded card.                                                                                                                         |
| 3   | **Hover (glance preview)**                      | Hovering the capsule raises pill fill (`rgba(255,255,255,0.09)`). After `Settings.hoverDelay` (`220 ms`), `Island.preview("sweep")` folds `IslandSplit` (`split.atRest = false`) and morphs `NotchShape` (`480 px`, `ear: 14`, `WlrKeyboardFocus.None`) directly out of the top edge. **Strictly cache-only**: never triggers a scan even on AC power.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Hero: `57.4 GiB` `reclaimable in ~/Projects`<br>Sub: `31.0 GiB free on volume · +4.2 GiB guarded`<br>Chip: `Preview`<br>Footer: `10.3 GiB is in 26 idle projects and 5 finished worktrees.` + `Open` button.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `80 ms` hover wash (`Theme.hoverMs`). Morphs out of the top edge on `surfaceIn`; folds `300 ms` (`Theme.hoverLeaveMs`) after pointer leaves unless clicked to pin.                                                                                                              |
| 4   | **Expanded storage card (settled)**             | `Theme.panelM` (`640 px`) inside top-attached `NotchShape` (`30 px` bottom radius, `14 px` ears, `LiquidRim`). `backStrip`: `Cleanup · Sweep` left + 4 section icons centered (no right-side controls). Top row: single `CleanupPanel` `Segmented` bar (`Skills \| Projects \| Space \| Caches`, with `Space` hidden until v1b). Directly below `viewSwitch` inside `SweepPanel`: slim status/action row with `112 projects` chip on the left and quiet `Rescan` & `Open terminal` icon buttons on the right (wrapping via the `daysSwitch.below` width rule if needed at `200%` text scale). Body: hero `57.4 GiB` (`26 px` bold sans, tabular) + `reclaimable in ~/Projects`, dim line `31.0 GiB free on volume · +4.2 GiB guarded`, 6-row `SweepDotBar` by rebuild cost, 4-item legend with colored Nerd Font icons, footer insight + single primary `Review in Sweep` button + quiet trust caption. | Hero: `57.4 GiB` `reclaimable in ~/Projects`<br>Sub: `31.0 GiB free on volume · +4.2 GiB guarded`<br>Legend: `Caches 2.1 GiB`, `Installs 38.6 GiB`, `Builds 16.3 GiB`, `Opt-in 410 MiB`<br>Footer: `10.3 GiB is in 26 idle projects and 5 finished worktrees.`<br>Button: `Review in Sweep`<br>Caption: `Nothing is deleted here. Review opens Sweep with an empty queue.`                                                                                                                                                                                                                                                                                                                                                                      | Opens on `surfaceIn` (or `surfaceKeyIn` via shortcut). Dot bar and hero are completely still once settled.                                                                                                                                                                      |
| 5   | **Scanning (user-triggered)**                   | Entered only when the user opens the panel on AC with no cache, or explicitly clicks `Rescan` / `Scan now` (on AC or battery). Hero shows `~14.2 GiB` (leading `~` marks incomplete sizing). Subtitle shows live folder count and middle-elided path. Dot bar fills left-to-right from real `widget_progress` buckets with leading shimmer. `Rescan` icon spins (`busy: true`); `Stop` quiet button cancels cleanly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Hero: `~14.2 GiB` `scanning ~/Projects`<br>Sub: `1,420 folders · packages/ui/node_modules`<br>Footer: `Measuring reclaimable build output. Nothing is removed during a scan.`<br>Buttons: `Stop` (quiet), `Review in Sweep` (disabled).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Live updates coalesced at `<= 12 Hz` (`80 ms`); shimmer `Theme.shimmerMs` (`1300 ms`) paused under `reduceMotion`. Cancels child process group via `SIGTERM` on `Stop` or panel close.                                                                                          |
| 6   | **Settled (nothing to free)**                   | Reclaimable is `0 B`. Dot bar shows empty unlit track (`Theme.wash(2)`). No suggestion card, no primary button.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Hero: `0 B` `reclaimable in ~/Projects`<br>Sub: `34.5 GiB free on volume · +4.2 GiB guarded`<br>Footer: `Nothing to clear here right now.`<br>Button: `Rescan` (secondary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Still. Zero timers.                                                                                                                                                                                                                                                             |
| 7   | **Stale cached result (L4) / battery no-cache** | Immediate first paint from `$XDG_CACHE_HOME/sweep/widget-v1.json` when older than `60 min` (or on battery). Renders full dot bar and legend at full clarity plus an amber-tinted `Chip` (`Cached · 3 h ago · on battery`) and a manual `Refresh` button. If on battery with **no cache yet**, renders a calm empty card with `"On battery · click Scan to measure"` and a manual `Scan now` secondary button.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Cached chip: `Cached · 3 h ago` (or `Cached · 3 h ago · on battery`)<br>Footer: `10.3 GiB was idle at last scan. Refresh to measure again, or review live in Sweep.`<br>Buttons: `Review in Sweep` (primary, runs live scan in terminal), `Refresh` (secondary).<br>No-cache on battery: `No saved scan yet` / `On battery. Click Scan now to measure ~/Projects.` + `Scan now` (secondary).                                                                                                                                                                                                                                                                                                                                                    | Instant paint (no skeleton flash). Never auto-scans on battery, even with no cache.                                                                                                                                                                                             |
| 8   | **Point / hover on legend or dot bar**          | Pointer over a legend item or dot column (or `<-`/`->` keyboard focus or `Enter`/`Space` on a legend button) dims all other dot columns to `opacity: 0.24`, highlights the active legend pill (`rgba(255,255,255,0.12)`), and swaps hero + subtitle in place with zero height shift (Projects view only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Hero: `16.3 GiB` (in `#fb984a` `costBuild`) `Builds`<br>Sub: `48 folders · Rebuilds on next compile (target, .next, dist).`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `80 ms` opacity/color transition (`Theme.hoverMs`) on pointer; `0 ms` on keyboard arrows. Leaving restores whole-tree hero immediately.                                                                                                                                         |
| 9   | **Suggestion (actionable next step)**           | Focused view when finished worktrees or idle projects dominate. Card header shows `3.5 GiB in 5 finished worktrees` on the left and a quiet inline link `All projects >` on the top right (returning to State 4). Dot bar displays the 5 worktrees' own rebuild-cost breakdown (`Caches 220 MiB`, `Installs 2.1 GiB`, `Builds 1.2 GiB` = `3.5 GiB`, never falsely highlighting the full-tree `Installs` share), followed by the top 3 matching rows (`FluidHighlight`, `up`/`down` + `Enter`). Footer has **one** primary action (`Review 5 worktrees`).                                                                                                                                                                                                                                                                                                                                                | Hero: `3.5 GiB` `in 5 finished worktrees` + inline link `All projects >`<br>Sub: `Part of 57.4 GiB reclaimable · Merged branches can be reviewed first.`<br>Rows: `sweep > old-renderer · merged · 42 d · 1.2 GiB`, `kuwai > blur-spike · merged · 36 d · 980 MiB`, `docs > v2-draft · branch missing · 51 d · 740 MiB`<br>Button: `Review 5 worktrees` (single primary).                                                                                                                                                                                                                                                                                                                                                                       | `FluidHighlight` glides on `Theme.springFast` between rows on pointer hover; snaps as focus ring on keyboard.                                                                                                                                                                   |
| 10  | **Review handoff**                              | Shown briefly (`~180 ms`) after clicking `Review in Sweep` while Kuwai spawns the configured terminal (`bin/kuwai-term`, `$KUWAI_TERMINAL`) with `sweep ui <dir>` (`--view projects`, `--focus ...`, or v1b `--view space`, empty queue). Folds away as soon as Hyprland emits `openwindow` for the terminal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Button text swaps in place: `Opening Sweep...` (plate pressed `scale 0.97`, disabled against double-launch).<br>Caption: `Queue starts empty. Sweep asks before removing anything.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Continuity transition: island folds on `surfaceOut` as the terminal maps and takes focus via `Island.giveFocus`.                                                                                                                                                                |
| 11  | **Clearing in progress (passive)**              | Observed via inotify on `$XDG_RUNTIME_DIR/sweep/active-apply.json` (with `/proc/<pid>/cmdline` + `updatedAt < 30 s` liveness check) only while the user's confirmed `sweep ui` / `sweep apply` run is executing. When closed, the right-lane capsule shows broom + `Clearing 3/12`. When open, renders as a top-attached `NotchShape` panel (`ear: 14`, never a floating card under the notch) with a `25%` progress bar (`3 of 12`) and right-edge dots dissolving from `activeCost` on real `deletedCount` increments (remaining bar `55.6 GiB` = `57.4 - 1.8 GiB`).                                                                                                                                                                                                                                                                                                                                  | Hero: `Clearing 3 of 12` `~1.8 GiB freed so far`<br>Sub: `Removing packages/web/.next`<br>Chip: `Active in terminal`<br>Footer: `Running in your Sweep terminal session. Focus the terminal to stop early.`<br>Button: `Focus Sweep` (secondary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Dot dissolve animates strictly on real `deletedCount` increments (`Theme.glideMs 140 ms`, `Theme.easeOut`), never on a fake timer. Under `reduceMotion`, dots step cleanly with no dissolve trail.                                                                              |
| 12  | **Receipt (clean outcome)**                     | Shown when `$XDG_STATE_HOME/sweep/last-receipt.json` records `failedCount === 0 && !stopped` (and is neither dismissed nor older than 24 h). When closed, the capsule flashes a green halo once (`celebrate()`, never loops) showing `Freed 3.5 GiB`. When open, renders as a top-attached `NotchShape` panel (`ear: 14`) with green check + freed total, updated free disk space, and remaining `53.9 GiB` dot bar. Trash mode states `0 B freed on volume until purged`.                                                                                                                                                                                                                                                                                                                                                                                                                              | Delete mode hero: `Freed 3.5 GiB` (in `Theme.green`)<br>Sub: `5 items removed · 34.5 GiB free now · 53.9 GiB still reclaimable`<br>Trash mode sub: `5 items moved to Trash · 0 B freed on volume until purged`<br>Footer: `Next: 26 idle projects hold 6.8 GiB.` (or `Nothing else needs clearing right now.`)<br>Buttons: `Done` (quiet, persists `dismissedReceiptId`), `Review idle projects` (primary).                                                                                                                                                                                                                                                                                                                                     | Rare delight budget: one-time green halo fade (`Theme.enterMs` -> `Theme.breathOutMs`), hero count settles once (`<= 320 ms`, disabled under `reduceMotion`).                                                                                                                   |
| 13  | **Partial / failed outcome**                    | Shown when `last-receipt.json` has `failedCount > 0` or `stopped: true`. Uses `Ui.Notice` in amber (`Theme.orange`) with one action (`Inspect in Sweep`). Never calls partial work clean. Dot bar below reflects the updated remaining `54.3 GiB` (`57.4 - 3.1 GiB`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Notice title: `Removed 3.1 GiB, 2 items failed` (or `Stopped early · 3 removed, 2 not attempted`)<br>Detail: `2 items stayed queued because files were busy or lacked permission. 34.1 GiB free now.`<br>Notice action (single): `Inspect in Sweep`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Static amber notice. No shake or looping pulse.                                                                                                                                                                                                                                 |
| 14  | **Error (scan failed / timeout)**               | Shown when `sweep widget` exits non-zero or times out. Uses `Ui.Notice` in red (`Theme.red`) with **one** action (`Try again`); secondary `Open terminal` quiet link sits below the notice. Never prints helper filenames, stack traces, or exit codes (passes Kuwai `REHEARSAL.md` `insides` gate). If a last-good cache exists, keeps showing it dimmed below the notice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Notice title: `Could not finish scanning ~/Projects`<br>Detail: `The scan timed out before sizing finished. Showing the last saved scan from 3 h ago.`<br>Notice action (single): `Try again`<br>Footer link: `Open terminal`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Static red notice. No placeholder skeletons left alongside error (passes `waits-forever` gate).                                                                                                                                                                                 |
| 15  | **Sweep not installed**                         | `sweep` binary not found in allowlisted paths. Clean centered empty state (`Ui.EmptyState`) recommending the self-contained checksum-verified install script (`README.md:56`, `install.sh:3`). Command pill wraps cleanly after `curl -fsSL` onto 2 lines (keeping `...install.sh \| sh` together so `sh` is never orphaned alone, with horizontal scroll fallback in narrow/scaled layouts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Title: `Sweep is not installed`<br>Body: `Install Sweep to inspect project build output and reclaim disk space from the island.`<br>Code pill: `curl -fsSL https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.sh \| sh` + copy icon button (ticks green **only** after clipboard write resolves; shows `"Copy failed"` if unavailable/rejected, keeping text selectable).                                                                                                                                                                                                                                                                                                                                                         | Still. Copy icon crossfades to check in `Theme.microMs` (`140 ms`) on resolved write.                                                                                                                                                                                           |
| 16  | **Engine missing**                              | `sweep` CLI returns `error.code === "engine_missing"`. Uses `Ui.Notice` in amber (`Theme.orange`) with **one** action (`Scan with fallback`); secondary `Run doctor` quiet button sits in the footer row below the notice (launches `sweep doctor` in the user's terminal).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Notice title: `Native scan engine unavailable`<br>Detail: `Scans can still run with the fallback scanner, or run sweep doctor in your terminal to repair the native engine.`<br>Notice action (single): `Scan with fallback` (passes `--engine js`)<br>Footer: `Fallback scanner uses identical guardrails and binary sizing.` + `Run doctor` (quiet).                                                                                                                                                                                                                                                                                                                                                                                          | Static amber notice.                                                                                                                                                                                                                                                            |
| 17  | **Permission denied**                           | Two distinct forms: (a) **root unreadable** (`error.code === "permission_denied"`) shows red `Ui.Notice` (`Open Settings`) with no meta-documentation copy; (b) **partial unreadable subdirs** (`skippedDirs > 0`) stays in State 4 settled card and appends one amber caption `Skipped 14 unreadable folders · sizes are a lower bound`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Root unreadable title: `Cannot read ~/Projects`<br>Detail: `Your account does not have read permission on this folder. Pick another scan root in Settings.`<br>Notice action (single): `Open Settings` (opens `Settings -> Island`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Static notice.                                                                                                                                                                                                                                                                  |
| 18  | **Read-only Space report view (v1b)**           | Gated on [space-report.md](space-report.md) landing; selected via `Space` in `CleanupPanel`'s single `Segmented` bar (`Skills \| Projects \| Space \| Caches`). Strictly read-only (`readOnly: true`). **Volume total stays fixed as the single bold hero headline across all categories** (`342.4 GiB of 476.9 GiB used`), never replaced by a personal folder like `Photos`. Focusing any category (pointer hover or keyboard `Enter`/`Space`/`<-`/`->`) dims other dots to `0.24` and shows the focused category on the dim/subtitle line. 6-row dot bar spans all 11 C+ categories (`Developer`, `Apps`, `Photos`, `System data`, `Caches`, `Videos`, `Documents`, `Downloads`, `Trash`, `Music`, `Other`; `system_data` shows `"Unknown"` when `bytesKnown === false` on CoW volumes). 3-column legend with colored icons + binary sizes.                                                          | Fixed hero: `342.4 GiB` `of 476.9 GiB used`<br>Default dim line: `134.5 GiB free on volume · point at any category`<br>Focused `Photos` (info-only) dim line: `Photos · 58.6 GiB · Personal files are info-only. Sweep never queues or removes them.` + **no action button** in footer.<br>Focused `Developer` dim line: `Developer · 57.4 GiB · Project build artifacts and toolchains.` + `Review in Sweep` (primary).<br>Focused `Caches` dim line: `Caches · 32.4 GiB · Verified regenerable tool caches.` + `Review caches` (primary).<br>Focused `Trash` dim line: `Trash · 12.6 GiB · Items already moved to Trash on this volume.` + `Review Trash` (primary).<br>No category focused footer button: `Open Space in Sweep` (secondary). | `80 ms` hover dim (`Theme.hoverMs`) on pointer; `0 ms` on keyboard. Volume hero stays anchored with zero shift while only the dim line updates. Switching `Projects <-> Space` crossfades content in `Theme.quickMs` (`140 ms`, `Theme.easeOut`) at fixed `640 px` panel width. |

---

## (c) Data and performance policy

### When scans run

- **At rest (island closed):** Never. Zero timers, zero child processes, zero
  GPU frames. `Sweep.qml` holds only passive `FileView` watchers
  (`watchChanges: true`) on:
  - `$XDG_CACHE_HOME/sweep/widget-v1.json` (Projects L4 cache)
  - `<configDir>/space-cache.json` (v1b Space L4 cache, aggregate-only)
  - `$XDG_STATE_HOME/sweep/last-receipt.json`
  - `$XDG_RUNTIME_DIR/sweep/active-apply.json`
- **On capsule hover preview (`Island.preview("sweep")`):** **Strictly
  cache-only.** Reads cached data only and **never** spawns a scan process,
  even on AC power.
- **On panel open:**
  1. Read the L4 cache for the active view synchronously (`blockLoading: true`,
     file is `< 64 KiB`) so the panel renders on frame 1 with zero loading
     flash.
  2. **If on battery (`UPower.onBattery === true`):** **Never auto-scan**, even
     when no cache exists.
     - If cache exists: display it immediately with `Cached · <age> · on battery`
       chip and a manual `Refresh` button.
     - If no cache exists: display State 7's calm `"No saved scan yet · On battery. Click Scan now to measure ~/Projects."`
       card with a manual `Scan now` button.
  3. **If on AC power:**
     - If no cache exists: start one on-demand low-memory scan for the active
       view.
     - If cache exists and `age <= 30 min`: treat as fresh (no scan).
     - If cache exists and `age > 30 min`: display the cached snapshot
       immediately with `Refreshing...` while one low-memory scan runs.
- **On explicit user click (`Rescan`, `Refresh`, `Scan now`):** Runs a single
  scan for the active view (on AC or battery) using `--resource-profile balanced`.
- **Optional scheduled refresh (off by default):** If the user explicitly opts
  in (`Settings -> Island -> Sweep -> Refresh in background`), Kuwai enables a
  systemd user timer (`sweep-widget-refresh.timer`, default every 6 h,
  `ConditionACPower=true`, `RandomizedDelaySec=15m`) that runs
  `sweep widget --view projects --refresh --resource-profile low-memory` at
  `Nice=19` and `IOSchedulingClass=idle` and atomically replaces
  `widget-v1.json`. The shell itself still runs zero polling timers.

### Caching (L4 stale-cache alignment)

- **Projects cache:** `$XDG_CACHE_HOME/sweep/widget-v1.json` (mode `0600`,
  atomic write-temp-fsync-rename, multi-entry `entries` map keyed by canonical
  `targetDir`, max 8 entries / `< 64 KiB`).
- **Space cache (v1b):** `<configDir>/space-cache.json` (`SpaceCacheSnapshot`
  from [space-report.md](space-report.md) Section 4.3, strictly aggregate-only
  and path-free, `0600`, `<= 256 KiB`). Space never writes local paths into
  `widget-v1.json`, and cached Space views disable all review actions until a
  fresh complete scan settles.
- Staleness thresholds:
  - `< 30 min`: fresh (no badge).
  - `30 min .. 60 min`: quiet refresh on open (AC only).
  - `>= 60 min`: explicit `Cached · <age>` chip (`1 h ago`, `2 d ago`).
- Cache entries are strictly display-only (`readOnly: true`) and can never be
  passed to `sweep apply`.

### Cost limits, process safety, engine child lifecycle, and cancellation

Every scan launched by Kuwai executes the validated absolute path to `sweep`
with the currently selected `--view`:

```text
setpriv --pdeathsig KILL -- nice -n 19 ionice -c3 /abs/path/to/sweep widget <root> --view <projects|space> --json-stream --resource-profile low-memory
```

**Orphan-free `sweep-engine` lifecycle (critical for `bin/kuwai-check`):**
Linux clears `PR_SET_PDEATHSIG` across `fork()`. Therefore `setpriv --pdeathsig
KILL` guarantees only that `sweep` itself dies when Quickshell dies; it does
**not** cover the Rust `sweep-engine` child process spawned by `sweep widget`
(today `crates/sweep-engine-cli/src/main.rs:376,793` reads stdin once at start
and does not watch stdin EOF during the walk). To prevent orphaned
`sweep-engine` processes under both clean cancel and `SIGKILL` of the shell:

1. **Native parent-death teardown inside `sweep-engine` (Linux):** On Linux,
   `crates/sweep-engine-cli` calls `prctl(PR_SET_PDEATHSIG, SIGKILL)` at
   startup followed immediately by a `getppid() != expected_ppid` race check
   (exiting immediately if the parent already died between `fork()` and
   `prctl()`). In addition, `sweep` passes a dedicated parent-death control
   pipe (or Linux `pidfd_open(ppid)` watcher thread in `sweep-engine`) that
   flips the cancellation `AtomicBool` and terminates the engine cleanly on
   parent EOF/exit.
2. **Shared process group and direct-signal forwarding in `sweep`:** `sweep`
   keeps `sweep-engine` in `sweep`'s own process group (it does **not** call
   `setpgid` to detach the engine into a separate group). When `sweep` receives
   `SIGTERM`/`SIGINT` directly (for example from interactive cancellation), it
   forwards `SIGTERM` to the `sweep-engine` child PID and escalates to
   `SIGKILL` after `2 s`.
3. **Host-side process-group / scope teardown in Kuwai:** Kuwai launches the
   scan command in a new session/process group (or via `systemd-run --user
   --scope --quiet --collect`). Because `sweep-engine` remains in `sweep`'s
   process group (and inside the transient scope cgroup when using
   `systemd-run --user --scope`), a host-side timeout or panel-close signal to
   `-pgid` (or cgroup teardown) reaches both `sweep` and `sweep-engine`
   directly, guaranteeing zero orphans on `kuwai-check`.

Additional bounds:

- `--resource-profile low-memory` bounds logical traversal memory to
  `SCAN_RESOURCE_PROFILES["low-memory"]` (`5,000` candidates, `50,000` dirs,
  `16 MiB` combined budget in `packages/protocol/src/index.ts:48-56`); explicit
  `Rescan` / `Refresh` / `Scan now` clicks use `balanced`.
- **Per-view locks with runtime-dir fallback:** `flock` on
  `widget-projects.lock` and `widget-space.lock` inside `$XDG_RUNTIME_DIR/sweep/`
  (falling back to `$XDG_CACHE_HOME/sweep/` when `$XDG_RUNTIME_DIR` is unset),
  so multi-monitor `IslandBar` instances never spawn duplicate scans and
  switching to Space does not contend with a Projects scan.
- Hard timeout: `45 s` for automatic AC open refresh, `120 s` for explicit
  `Rescan`. On timeout, send `SIGTERM` to the process group, wait `2 s`, then
  `SIGKILL`, and show State 14 while keeping any last-good cached snapshot
  visible.
- **Cancellation:** Clicking `Stop` or closing the island panel cancels an
  in-flight widget scan immediately (`SIGTERM` to process group) and drops the
  `Process` handle. Clearing operations live in the user's terminal window
  (`systemd-run --user --slice=app.slice`), so closing the island never
  interrupts an active removal.

### Battery policy

On battery (`UPower.onBattery === true`):

- **Zero automatic scans on panel open**, including first open with no cache
  (shows State 7 manual `Scan now` / `Refresh` button).
- **Zero scans on capsule hover** (hover is always cache-only, on AC and
  battery).
- No background systemd timer (`ConditionACPower=true`).
- `LiquidRim` pointer specular shader stays off (already enforced by
  `LiquidRim.qml:26-27`).
- Explicit user-triggered `Scan now` / `Refresh` clicks are honored; scanning
  dot shimmer steps at half rate or pauses when `reduceMotion` is on.

---

## (d) Visual tokens mapped from C+ onto Kuwai's theme system

**Ownership rule:** Kuwai's `Theme.qml` wins for every surface, material,
border, radius, font, text ink, elevation, motion curve, and primary action
accent (`Theme.accent`). Sweep's Direction C+ palette wins for data-encoding
hues (the 4 rebuild-cost buckets and 11 whole-disk categories).

### Surfaces, typography, and controls (Kuwai wins)

| Role                               | Kuwai Token (`shell/config/Theme.qml`)                                 | Resolved value (Kuwai Night)                                                                                           | Notes                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Notch body fill                    | `NotchShape.fill` -> `Theme.notchGlassMid` -> `Theme.notchGlassBottom` | `rgba(0,0,0,0.94)` -> `rgba(6,6,8,0.86)` -> `rgba(9,9,12,0.78)`                                                        | Identical to every other Kuwai island panel; high contrast raises alpha to `0.96-0.98`.                                    |
| Inner card fill                    | `Theme.card`                                                           | `rgba(255,255,255,0.05)`                                                                                               | Replaces C+'s solid `#1b1c1f` so the card breathes over Hyprland blur.                                                     |
| Inner card edge & drop             | `Theme.cardEdge`, `Theme.cardDrop`                                     | `rgba(255,255,255,0.05)` (`0.22` high contrast), `rgba(0,0,0,0.50)`                                                    | 1 px hairline + 1 px crisp drop (`Ui.Card`).                                                                               |
| Unlit dot track                    | `Theme.wash(2)`                                                        | `rgba(255,255,255,0.10)`                                                                                               | Matches Kuwai's `LinkedBar.qml:80`.                                                                                        |
| Hover pill / row wash              | `Theme.rowHover`, `Theme.wash(3)`                                      | `rgba(255,255,255,0.06)`, `rgba(255,255,255,0.14)`                                                                     | Legend pill hover and `FluidHighlight` fill.                                                                               |
| Panel width & max height           | `Theme.panelM`, `Theme.panelMaxH`                                      | `640 px`, `600 px`                                                                                                     | Matches `CleanupPanel.qml` and `SystemPanel.qml`; switching sections causes zero horizontal re-morph.                      |
| Radii                              | `NotchShape` `14 -> 30 px`, `Theme.r3`, `Theme.r2`, `Theme.r1`         | `30 / 16 / 12 / 8 px`                                                                                                  | Inner controls derive via `Theme.innerRadius(outer, inset)`.                                                               |
| Primary / secondary / tertiary ink | `Theme.textPrimary`, `Theme.textSecondary`, `Theme.textTertiary`       | `rgba(255,255,255, 0.96 / 0.72 / 0.56)`                                                                                | Contrast-verified over translucent glass (`0.88 / 0.74` when `Settings.highContrast`).                                     |
| Primary button & focus ring        | `Theme.accent`, `Theme.onAccent`                                       | `#66c7ff` (Kuwai Night) / `#0a84ff` (default), `#000000` / `#ffffff`                                                   | Follows the user's active Kuwai theme/wallpaper live (`Theme.qml:181-192`).                                                |
| Semantic status tones              | `Theme.green`, `Theme.orange`, `Theme.red`                             | `#30d158`, `#ff9f0a`, `#ff453a`                                                                                        | Clean receipt, caution/warning/stale, error/critical.                                                                      |
| Typography                         | `Label.qml` (`SF Pro` if installed, else `Inter`)                      | Hero `Theme.tTitle1` (`26 px`, `wBold`, `tabular: true`), body `14 px`, sub `13 px`, footnote `12 px`, caption `11 px` | Headline numbers use proportional sans-serif with tabular figures, not monospace. All container heights use `Theme.sp(n)`. |

### Data-encoding accent set & icons (Sweep C+ hues on Kuwai's `Symbols Nerd Font`)

All 4 rebuild-cost hues and 11 whole-disk category hues are carried verbatim
from Direction C+ (verified `>= 5.0:1` contrast against `#111114` / `#1b1c1f` /
Kuwai glass).

**Color proximity note with Kuwai themes:** `Theme.accent` is dynamic in Kuwai
(`Theme.qml:181-192`), following any HyDE theme or wallpaper palette, so no
fixed categorical palette can be unconditionally disjoint from `Theme.accent`
across every wallpaper. Specifically, in Kuwai Night
(`themes/kuwai-night/palette.toml:4`), `Theme.accent` is `#66c7ff` (OKLCH
~236 deg), only ~8 deg from C+ `diskApps` (`#5fc9f4`, 228 deg), and
`costBuild` (`#fb984a`, 56 deg) sits ~9 deg from `Theme.orange` (`#ff9f0a`,
~65 deg). This overlap is acceptable because roles never mix on the same
element: `diskApps` is strictly read-only inside the Space dot bar and legend
(never a button, focus ring, or active tab), `Theme.accent` is reserved for
interactive primary controls and keyboard focus rings, and `Theme.orange` is
reserved for `Ui.Notice` and `Ui.Chip` status surfaces while `costBuild` only
appears in the dot matrix and legend paired with its CPU icon. Keeping the
canonical C+ hex values preserves instant visual recognition between `sweep ui`,
web docs, and the island.

| View            | Key           | Label       | Hex (C+ Dark) | OKLCH Hue  | Nerd Font Glyph (`Theme.fontGlyph`)  |
| --------------- | ------------- | ----------- | ------------- | ---------- | ------------------------------------ |
| Projects (cost) | `cache`       | Caches      | `#55d7be`     | `178 deg`  | `\u{f021}` (`nf-fa-refresh`)         |
| Projects (cost) | `install`     | Installs    | `#ad9efd`     | `290 deg`  | `\u{f487}` (`nf-oct-package`)        |
| Projects (cost) | `build`       | Builds      | `#fb984a`     | `56 deg`   | `\u{f4bc}` (`nf-oct-cpu`)            |
| Projects (cost) | `custom`      | Opt-in      | `#ea85d3`     | `336 deg`  | `\u{f06e}` (`nf-fa-eye`)             |
| Space (11 cats) | `developer`   | Developer   | `#ad9efd`     | `290 deg`  | `\u{f121}` (`nf-fa-code`)            |
| Space (11 cats) | `apps`        | Apps        | `#5fc9f4`     | `228 deg`  | `\u{f2d0}` (`nf-fa-window_maximize`) |
| Space (11 cats) | `photos`      | Photos      | `#fa7fb3`     | `355 deg`  | `\u{f03e}` (`nf-fa-image`)           |
| Space (11 cats) | `system_data` | System data | `#a6a19a`     | Warm stone | `\u{f0a0}` (`nf-fa-hdd_o`)           |
| Space (11 cats) | `caches`      | Caches      | `#55d7be`     | `178 deg`  | `\u{f021}` (`nf-fa-refresh`)         |
| Space (11 cats) | `videos`      | Videos      | `#cf8bea`     | `316 deg`  | `\u{f008}` (`nf-fa-film`)            |
| Space (11 cats) | `documents`   | Documents   | `#56d3da`     | `200 deg`  | `\u{f15c}` (`nf-fa-file_text`)       |
| Space (11 cats) | `downloads`   | Downloads   | `#c6d163`     | `114 deg`  | `\u{f019}` (`nf-fa-download`)        |
| Space (11 cats) | `trash`       | Trash       | `#fe895a`     | `42 deg`   | `\u{f1f8}` (`nf-fa-trash`)           |
| Space (11 cats) | `music`       | Music       | `#90d378`     | `138 deg`  | `\u{f001}` (`nf-fa-music`)           |
| Space (11 cats) | `other`       | Other       | `#dbae7b`     | `70 deg`   | `\u{f07b}` (`nf-fa-folder`)          |

Surface brand / UI action glyphs from Kuwai's `Symbols Nerd Font` set:
Sweep mark `\u{f00e2}`, Rescan `\u{f0450}`, Terminal `\u{f018d}`, Warning
`\u{f0026}`, Check `\u{f05e0}`, Copy `\u{f018f}`.

### Why `SweepDotBar.qml` extends `LinkedBar.qml`

Kuwai already ships `shell/components/LinkedBar.qml` (6-row circular dot field
with hover dim). `SweepDotBar.qml` reuses its exact geometry (`rows: 6`, `dot:
5`, `gap: 2`, `Theme.wash(2)` empty track) and diverges intentionally in six
ways:

1. **1-column ground seams** between buckets so adjacent hues read as distinct
   groups (matching `sweep ui` `stackPixels` and Direction C+).
2. **Colored Nerd Font legend icons** instead of plain 7 px circles so
   categories remain distinguishable under color-vision deficiency and
   `NO_COLOR` parity.
3. **Real-event right-edge clearing dissolve** on `activeCost` when observing
   State 11 (`active-apply.json`), plus leading scan shimmer in State 5.
4. **Keyboard focus (`<-`/`->`, `Enter`/`Space`)** on legend items with `0 ms`
   instant focus steps (`LinkedBar.qml` is pointer-only).
5. **Slightly deeper unfocused dim (`0.24` vs `LinkedBar`'s `0.28`)** so
   smaller buckets stand out cleanly across 11 Space categories.
6. **Decoupled headline behavior** so Projects view can swap its hero on hover
   while Space view keeps the volume total fixed as the hero and updates only
   the dim subtitle line.

### Motion token mapping (Kuwai `Theme.qml`)

| Interaction                         | Token                                        | Value                                                                 | Reduced motion (`Theme.reduceMotion`)          |
| ----------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| Island expand / collapse (pointer)  | `Theme.surfaceIn` / `Theme.surfaceOut`       | `{stiffness: 300, damping: 27.7}` / `{stiffness: 560, damping: 47.3}` | Instant shape snap; `140 ms` opacity crossfade |
| Island expand / collapse (keyboard) | `Theme.surfaceKeyIn` / `Theme.surfaceKeyOut` | `{stiffness: 560, damping: 47.3}` / `{stiffness: 900, damping: 60}`   | Instant shape snap; `140 ms` opacity crossfade |
| Legend & dot-bar hover dim          | `Theme.hoverMs`                              | `80 ms` (`0 ms` on `<-`/`->` keys)                                    | `0 ms` instant swap                            |
| Button / row press scale            | `Theme.pressMs`, `Theme.easeOut`             | `140 ms`, `[0.23, 1, 0.32, 1]`, `scale 0.97` (plate only)             | Disabled (`scale 1`)                           |
| View swap (`Projects <-> Space`)    | `Theme.quickMs`, `Theme.easeOut`             | `140 ms` opacity crossfade                                            | `80 ms` opacity crossfade                      |
| Active scan shimmer                 | `Theme.shimmerMs`                            | `1300 ms` linear sweep                                                | Paused (static muted track)                    |
| Active rescan icon spin             | `Theme.spinMs`                               | `750 ms` linear rotation                                              | Paused                                         |
| Clearing dot dissolve               | `Theme.glideMs`, `Theme.easeOut`             | `140 ms` on real `deletedCount` change                                | Instant dot drop                               |
| Receipt green halo arrival          | `Theme.enterMs` + `Theme.breathOutMs`        | `200 ms` in + `1100 ms` fade once                                     | Static green border, no flash                  |

---

## (e) Build plan (v1a / v1b split), tests, and safe isolated preview

Because `sweep space` and `sweep ui --view space` are still planned in
[space-report.md](space-report.md) (current `apps/cli/src/cli.ts:241` and
`packages/protocol/src/index.ts:174` accept only `--view projects|full`, and
`packages/ui/src/app.tsx:171` accepts only `"projects" | "folders"`), the build
plan splits cleanly into **v1a (shippable immediately)** and **v1b (gated on
[space-report.md](space-report.md) landing)**.

### Phase v1a: Projects view, L4 cache, receipts, and Kuwai integration (ship now)

| PR       | Repo    | Scope                                                                                          | Key deliverables & acceptance gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PR 1** | `sweep` | Protocol & core rebuild-cost model                                                             | Move `rebuildFor()` into `packages/core/src/rebuild.ts` and normalize `RebuildCost` from `"unknown"` (`packages/ui/src/project-details.ts:12`, already labeled `"custom"` at line 216) to `"custom"` across core and protocol. Add `WidgetSnapshot`, `WidgetEvent` (NDJSON), `WidgetCacheEnvelope`, `ActiveApply`, `WidgetReceipt`, `WidgetError` types and JSON Schemas in `packages/protocol/schemas/`. Ajv contract tests covering every state and guardrail rejection (`loadPlan`/`sweep apply` reject `widgetSchemaVersion`). Passes `bun run check`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **PR 2** | `sweep` | `sweep widget` CLI, `--focus`, engine teardown, cache & receipts                               | Implement `sweep widget [path] --view projects --json\|--json-stream --cache-only --refresh --resource-profile low-memory\|balanced` (`supportedViews: ["projects"]`, unknown `--view` exits with code 2 via Commander `.choices()`). Add `--focus worktrees\|idle` to `sweep ui` (unknown `--focus` exits with code 2). Add Linux `PR_SET_PDEATHSIG(SIGKILL)` + `getppid()` race check and parent-death control-pipe/pidfd watcher in `crates/sweep-engine-cli`, keeping `sweep-engine` in `sweep`'s process group (no separate `setpgid`) and forwarding `SIGTERM`/`SIGKILL` to the engine child on direct cancellation in `packages/core`. Write atomic `0600` `$XDG_CACHE_HOME/sweep/widget-v1.json`, `$XDG_RUNTIME_DIR/sweep/active-apply.json` (fallback `$XDG_CACHE_HOME/sweep/`), and `$XDG_STATE_HOME/sweep/last-receipt.json` (with `mode: "delete"\|"trash"` and `id`). Contract tests for missing engine, permission denied, stale cache, clean/trash/partial receipts, and orphan teardown. Passes `bun run check`, `bun run rust:check`, and `bun run verify`.                                                                                                                                                                                           |
| **PR 3** | `rice`  | Thin Kuwai panel (Option A) & retire legacy duplication (~250-350 LOC added, ~900 LOC deleted) | Replace `SweepPanel.qml` with a thin (~150 LOC) rendering-only panel + `SweepDotBar.qml` + passive `Sweep.qml` watcher (zero polling timers; cache-only hover; no auto-scan on battery even with no cache; dead-PID + `updatedAt < 30 s` check on `active-apply.json`; receipt dismissal via `dismissedReceiptId`; fixed absolute-path argv with `realpath` validation of symlinked `sweep` binaries including `~/.bun/bin/sweep` and `/home/linuxbrew/.linuxbrew/bin/sweep`; single `Ui.Notice` actions). Rename `CleanupPanel` `Idle projects` tab to `Projects` (no nested `Segmented` bar) and mount Sweep's state chip + `Rescan`/`Open terminal` buttons on their own slim sub-row below `viewSwitch` (with `daysSwitch.below`-style wrap at `120%`/`200%` text scale). Keep `Settings.sweepMinGB` persisted key (UI label `GiB`), `Island.open("sweep")`, `IpcHandler { target: "sweep" }`, `sweep-viewed`, and `SysMarks` capsule. Show State 15 (`install.sh`) when `sweep` is absent. Delete `bin/kuwai-sweep` and `shell/services/sweepModel.js`. Add rehearsal scenes in `tests/ui/scenes.json`. Gates: `pytest`, `bun test`, `bin/kuwai-tokens --check`, `bin/kuwai-comments --check`, `bin/kuwai-rehearse --gate` (100%, 120%, 200%), `bin/kuwai-check`. |

_(If the owner chooses **Option B** instead of Option A for PR 3, replace PR 3
with two PRs: PR 3a in `sweep` for `integrations/quickshell/Sweep/` + embedded
QML extraction in `sweep integrate kuwai` + preview harness, and PR 3b + 3c in
`rice` (~800-1,200 LOC) for `bin/kuwai-ext panels` recursive validation,
`import Kuwai.Plugin 1.0`, `Plugins.qml` with `KUWAI_NO_PLUGINS=1` and
crash-loop auto-disable, `Loader.Error` notice handling, and legacy retirement.)_

### Phase v1b: Whole-disk Space tab (gated on [space-report.md](space-report.md))

**Prerequisite:** [space-report.md](space-report.md) lands `sweep space`,
aggregate-only path-free `<configDir>/space-cache.json`, and
`sweep ui --view space` (extending `CliOptions.view` in
`packages/protocol/src/index.ts` to `"projects" | "full" | "space"` and
`initialView` in `packages/ui/src/app.tsx` to `"projects" | "folders" | "space"`,
rejecting unknown `--view` values with exit code 2).

| PR       | Repo    | Scope                                | Key deliverables & acceptance gate                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PR 4** | `sweep` | `sweep widget --view space`          | Add `"space"` to `sweep widget --view` choices and `supportedViews: ["projects", "space"]`. Populate `WidgetSnapshot.space` with the 11 categories, `bytesKnown`, `accountingDomainComparable`, and CoW unknown `system_data`. When `--cache-only` is passed for `--view space`, read `<configDir>/space-cache.json` (`SpaceCacheSnapshot`, strictly aggregate-only and path-free) with all review actions disabled. Passes `bun run check` + `bun run verify`. |
| **PR 5** | `rice`  | Enable `Space` tab in `CleanupPanel` | Expose `Space` as a peer tab in `CleanupPanel.qml`'s existing single `Segmented` control (`Skills \| Projects \| Space \| Caches \| Leftovers`) whenever `supportedViews` includes `"space"`. Render State 18 with fixed volume headline, dim-line focused category detail, CoW unknown `system_data` display, and strict info-only footer behavior. Add `sweep/space` rehearsal scene. Passes `bin/kuwai-rehearse --gate` and `bin/kuwai-check`.               |

### Test matrix

1. **JSON contract & engine tests (`sweep`):**
   - Ajv validation of `WidgetSnapshot`, `WidgetEvent`, `WidgetCacheEnvelope`,
     `ActiveApply`, and `WidgetReceipt` across fixtures for settled, empty,
     scanning, stale cache, battery no-cache, suggestion, receipt (delete,
     trash, partial/failed), error, engine missing, permission denied, and v1b
     11-category Space report (including `bytesKnown: false` on CoW volumes).
   - Guardrail test verifying `loadPlan` and `sweep apply --plan` reject any
     `WidgetSnapshot` document and that Space info-only categories never emit
     an actionable intent.
   - CLI argument validation tests verifying unknown `--view` and `--focus`
     values fail fast with exit code 2.
   - Process-lifecycle test killing `sweep widget` with `SIGKILL` mid-scan and
     asserting `sweep-engine` exits within 500 ms with zero orphans.
2. **QML lint & logic tests (`rice`):**
   - `qmllint` on `SweepPanel.qml`, `SweepDotBar.qml`, and `Sweep.qml`.
   - Unit tests (`bun test`) for receipt dismissal, dead-PID / stale `updatedAt`
     liveness rejection, battery no-auto-scan gating, cache-only hover, and
     binary IEC formatting (`1024^3` = `1.0 GiB`, never `1.07 GB`).
   - Verify no property named `data`, no bare `Text` rendering external paths
     without `Text.PlainText`, and `bin/kuwai-tokens --check` +
     `bin/kuwai-comments --check` pass.
3. **Kuwai rehearsal & live verification (`rice`):**
   - Add scenes to `tests/ui/scenes.json` covering: `sweep/settled`,
     `sweep/scanning`, `sweep/stale`, `sweep/battery-empty`, `sweep/point`,
     `sweep/suggestion`, `sweep/clearing`, `sweep/receipt`, `sweep/partial`,
     `sweep/error`, `sweep/not-installed`, `sweep/engine-missing`,
     `sweep/permission-denied`, `sweep/space` (v1b), and `sweep/worst` (very
     long repo/worktree names, 0 items).
   - Run `bin/kuwai-rehearse --gate` at 100%, 120%, and 200% text scale and
     inspect the contact sheet for zero `cut-off`, `on-top`, `spills`,
     `unreadable`, `insides`, or `waits-forever` faults.
   - Follow `.claude/skills/verify-kuwai/SKILL.md`: drive previews via
     `qs ipc -p ~/Projects/rice/shell call test preview cleanup DP-3`, capture
     with `grim`, confirm 0% idle CPU and zero orphan processes via
     `bin/kuwai-check`, and clean up with `q test clear` and `q island close`.

### Safe isolated preview without touching the running shell

To preview QML changes live on Hyprland without touching `kuwai-shell.service`,
`~/.config/kuwai`, or `~/.local/share/kuwai`, work inside a git worktree of
`rice` (or a temporary preview directory under `/var/tmp`) and launch
Quickshell inside a normal `FloatingWindow` (never a `WlrLayershell` with
namespace `kuwai-islandbar`, so it cannot collide with the running island or
steal top-edge exclusive space):

```sh
preview_dir=$(mktemp -d /var/tmp/sweep-qs-preview.XXXXXX)
# copy preview harness + fixtures into $preview_dir
SWEEP_PREVIEW_FIXTURE=settled \
TMPDIR=/var/tmp \
qs -p "$preview_dir"
```

- Pass `SWEEP_PREVIEW_FIXTURE=scanning|stale|battery-empty|receipt|space|error`
  to stage any contract fixture directly.
- Pass `KUWAI_REDUCE_MOTION=1` or `SWEEP_PREVIEW_TEXT_SCALE=1.2` to verify
  reduced-motion and 120% text scaling before promoting into `rice`.
- Close the preview window (`Ctrl+C`) and remove `$preview_dir` when done; the
  owner's desktop shell is never reloaded or disturbed.

---

## Review resolution

Summary of every finding from PR #147's design review (and automated review
comments) and where each was resolved:

| ID               | Finding                                                                                                                                                                                                                                                                                                                                                                             | Status   | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BLOCKER-1**    | Space view promoted `Photos` into the bold hero headline; spec vs mock footer mismatch                                                                                                                                                                                                                                                                                              | Resolved | Section (b) State 18, `prototypes/kuwai-island/index.html`, and `shots/18-space-report.png`: volume total (`342.4 GiB of 476.9 GiB used`) stays fixed as the bold hero across all Space categories; focused category renders on the dim line; info-only focus shows no footer action button.                                                                                                                                                                                                         |
| **BLOCKER-2**    | Plugin host security model overstated sandboxing, had root/user ownership contradiction, lacked recursive symlink checks, crash-loop breaker, valid JSON glyph escape, and XDG path rules                                                                                                                                                                                           | Resolved | Section (a): states plainly that in-process QML is not a sandbox; writes out Option A (thin Kuwai-owned panel, recommended) and Option B (`Kuwai.Plugin 1.0`, recursive ownership/symlink validation supporting root and user dirs, absolute paths only, `KUWAI_NO_PLUGINS=1`, crash-loop auto-disable, lazy load, `"\udb80\udce2"`, XDG expansion).                                                                                                                                                 |
| **BLOCKER-3**    | `setpriv --pdeathsig KILL` did not cover `sweep-engine` child; QML scan omitted `--view`                                                                                                                                                                                                                                                                                            | Resolved | Section (c) & Section (e) PR 2: QML command passes `--view <projects\|space>`; specifies `PR_SET_PDEATHSIG(SIGKILL)` + `getppid()` check and parent-death pipe/pidfd watcher inside `crates/sweep-engine-cli` plus process-group signal forwarding in `sweep` and scope/PGID teardown in Kuwai.                                                                                                                                                                                                      |
| **BLOCKER-4**    | Contradictory battery scan rule; hover scan ambiguity; missing NDJSON, receipt, error, Space, `active-apply`, and cache envelope schemas; inconsistent sample disk math                                                                                                                                                                                                             | Resolved | Sections (a), (b), (c): unified policy (never auto-scan on battery even with no cache; hover strictly cache-only); complete schemas for `--json-stream`, `widget-v1.json` envelope, `active-apply.json` (with `pid`, `updatedAt`, `/proc/<pid>/cmdline` liveness), `last-receipt.json` (with `mode` and dismissal/24 h expiry), `space` (`bytesKnown`, CoW unknown `system_data`), and `error.code` enum; fixed sample disk math (`445.9 + 31.0 = 476.9 GiB`) and `byCost` sum (`61,633,196,850 B`). |
| **BLOCKER-5**    | `--view space` / `--focus worktrees` do not exist yet; L4 cache conflicted with `space-report.md`                                                                                                                                                                                                                                                                                   | Resolved | Section (a), (c), (e): split build plan into v1a (Projects, shippable now, adds `--focus worktrees\|idle`) and v1b (Space, gated on [space-report.md](space-report.md) adding `sweep ui --view space` and TUI `SpaceView`); Space L4 cache reads aggregate-only path-free `<configDir>/space-cache.json` directly.                                                                                                                                                                                   |
| **SHOULD-FIX-1** | State 15 should recommend `install.sh`, confirm copy only on resolved write, and address standalone-binary QML delivery                                                                                                                                                                                                                                                             | Resolved | Section (a), (b) State 15, `index.html`, `shots/15-not-installed.png`: switched to `curl -fsSL https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.sh \| sh`; copy icon ticks only after `writeText` resolves with failure feedback on error; Option A eliminates QML extraction (and Option B specifies `sweep integrate kuwai` extraction).                                                                                                                                           |
| **SHOULD-FIX-2** | State 9 had two competing actions and falsely highlighted `Installs` on the dot bar                                                                                                                                                                                                                                                                                                 | Resolved | Section (b) State 9, `index.html`, `shots/09-suggestion.png`: single primary button (`Review 5 worktrees`), quiet inline `All projects >` link in card header, dot bar renders the 5 worktrees' own `3.5 GiB` cost breakdown (`worktrees.byCost`).                                                                                                                                                                                                                                                   |
| **SHOULD-FIX-3** | States 3, 11, and 12 rendered detached floating cards below the rest notch                                                                                                                                                                                                                                                                                                          | Resolved | Section (b) States 3/11/12, `index.html`, `shots/03`, `11`, `12`: all three render as top-attached `NotchShape` panels with `earsSvg(14)`; States 11 and 12 show the closed-notch capsule separately in a cleanly labeled inset strip below the panel.                                                                                                                                                                                                                                               |
| **SHOULD-FIX-4** | Panel chrome conflicted with `IslandBar` `backStrip`, `CleanupPanel` `Segmented` tabs, and `Ui.Notice` single-action rule                                                                                                                                                                                                                                                           | Resolved | Section (a), (b), `index.html`, `shots/04..18`: moved `Rescan`/`Open terminal` icon buttons out of `backStrip` into the panel toolbar; unified on `CleanupPanel`'s single `Segmented` bar (`Skills \| Projects \| Space \| Caches`); reduced States 14 and 16 `Ui.Notice` to one action each with secondary links in the footer row.                                                                                                                                                                 |
| **SHOULD-FIX-5** | Inaccurate unconditional color-separation claim vs Kuwai Night `#66c7ff` and dynamic `Theme.accent`                                                                                                                                                                                                                                                                                 | Resolved | Section (d): removed unconditional claim; documented Kuwai's dynamic `Theme.accent`, Kuwai Night `#66c7ff` vs `diskApps` `#5fc9f4` (8 deg), and `Theme.orange` vs `costBuild` (9 deg), plus role separation rationale.                                                                                                                                                                                                                                                                               |
| **SHOULD-FIX-6** | Legacy retirement missed `sweepMinGB`, `sweep-viewed`, `sweep` IPC target, `IslandBar` mask, and unmigrated users                                                                                                                                                                                                                                                                   | Resolved | Section (a) & Section (e) PR 3: preserves `Settings.sweepMinGB` key (UI label `GiB`), `Island.open("sweep")`, `IpcHandler { target: "sweep" }`, `sweep-viewed`, `SysMarks`/`sysPill` masking, and State 15 fallback when `sweep` is absent.                                                                                                                                                                                                                                                          |
| **SHOULD-FIX-7** | `host.ui.Button` QML ABI mechanics do not work declaratively; re-evaluate host size for v1                                                                                                                                                                                                                                                                                          | Resolved | Section (a): documented why `host.ui` fails declaratively in QML, specified Option A (recommended, ~250-350 LOC added / ~900 deleted) vs Option B (`import Kuwai.Plugin 1.0`, ~800-1,200 LOC).                                                                                                                                                                                                                                                                                                       |
| **SHOULD-FIX-8** | Kitty graphics delete commands (`d=I`, per-ID teardown), OpenTUI version claims, capability checks, and `auto`-theme background baking                                                                                                                                                                                                                                              | Resolved | `.plans/kitty-graphics.md`: switched eviction to `a=d,d=I,i=<id>` and teardown to per-owned-ID `a=d,d=I,i=<id>` (no `d=A`); verified `NativeImagePool`, `kittyImageTransport`, `capabilities.multiplexer`, and `capabilities.remote` are already exported in pinned `@opentui/core@0.6.8` (with env fallbacks); added `auto`-theme `theme.surface` baking rule in Rank 1.                                                                                                                            |
| **NIT-1..7**     | Hardcoded `"Kitty"` copy; state count typo (`17` vs `18`); `RebuildCost` `"unknown"` vs `"custom"`; per-view locks & `$XDG_RUNTIME_DIR` fallback; State 17 meta-copy; mock math (State 11 `25%` / `55.6 GiB`, State 13 `54.3 GiB`), keyboard legend focus, `Theme.qml`/`RaisedButton.qml` tokens, `LinkedBar` vs `SweepDotBar`; clickable `[space-report.md](space-report.md)` link | Resolved | All seven nits applied across `.plans/kuwai-island.md`, `prototypes/kuwai-island/index.html`, and regenerated screenshots.                                                                                                                                                                                                                                                                                                                                                                           |
| **RECHECK-1**    | Space category `caches` missed `ICONS.cache` (rendered folder fallback) and `mouseleave` snapped back to `Photos`, making unfocused Space footer (`Open Space in Sweep`) unreachable                                                                                                                                                                                                | Resolved | `prototypes/kuwai-island/index.html` & `shots/18-space-report.png`: added `ICONS.caches` mapping to the refresh glyph; distinguished initial default focus (`undefined`) from explicit unfocus (`null`) so `mouseleave` (and `Escape`) returns to the unfocused Space state (volume headline + `Open Space in Sweep` footer).                                                                                                                                                                        |
| **RECHECK-2**    | `CleanupPanel.qml` mounts `SweepPanel` below `viewSwitch`, and sharing `viewSwitch`'s horizontal row collides with 5 tabs or at `120%`/`200%` text scale                                                                                                                                                                                                                            | Resolved | Section (a), (b) State 4, (e) PR 3, `prototypes/kuwai-island/index.html`, and regenerated shots: `viewSwitch` keeps its own full-width top row; Sweep's state chip and `Rescan`/`Open terminal` icon buttons live on their own slim sub-row inside `SweepPanel` directly below `viewSwitch`, wrapping via the `daysSwitch.below` width rule (`CleanupPanel.qml:142`) at `200%` scale.                                                                                                                |
| **RECHECK-3**    | Separate `setpgid` on `sweep-engine` contradicted host-side `-pgid` process-group cancellation                                                                                                                                                                                                                                                                                      | Resolved | Section (c) & Section (e) PR 2: removed separate `setpgid` on `sweep-engine` so it stays in `sweep`'s process group (and transient `systemd-run --user --scope` cgroup), ensuring Kuwai's `-pgid` signal reaches both `sweep` and `sweep-engine` directly alongside `PR_SET_PDEATHSIG` and direct-signal forwarding.                                                                                                                                                                                 |
| **RECHECK-4**    | Option A allowlist omitted `/home/linuxbrew/.linuxbrew/bin/sweep` and `realpath` validation for symlinked installs (`~/.bun/bin/sweep`, Homebrew)                                                                                                                                                                                                                                   | Resolved | Section (a) Option A & Section (e) PR 3: added `/home/linuxbrew/.linuxbrew/bin/sweep` to the fixed allowlist and documented `realpath` resolution plus ownership/mode validation of the resolved executable and parent directories.                                                                                                                                                                                                                                                                  |
| **RECHECK-5**    | State 15 install command pill wrapped onto 3 lines with `sh` orphaned alone on line 3                                                                                                                                                                                                                                                                                               | Resolved | Section (b) State 15, `prototypes/kuwai-island/index.html`, and `shots/15-not-installed.png`: wrapped cleanly after `curl -fsSL` keeping `...install.sh \| sh` together on 2 crisp lines (with horizontal scroll fallback if narrower) so `sh` is never orphaned alone.                                                                                                                                                                                                                              |
