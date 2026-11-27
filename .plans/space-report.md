Status: planned
Scope: product, protocol, engine, core, cli, ui, docs
Created: 2026-11-27
Updated: 2026-11-27
Commit: uncommitted

# Space report (`sweep space`): "Where your space goes"

Design specification for a read-only whole-home and whole-volume storage
breakdown (`sweep space` and a Space view inside `sweep ui`) that makes `sweep`
immediately useful beyond project directories while preserving Sweep's
trust-first safety contract.

Inspired by the storage-card grammar in Clove 3.4
([clove.kshv.me](https://clove.kshv.me/) — local notes in the owner's checkout
at `.reference/clove-storage-2026-11-18.md`), adapted to Sweep's cross-platform
CLI/TUI/web architecture, olive-chartreuse visual system, and explicit
review-before-removal invariants. Satisfies ledger item **L3** (`sweep report`),
respects **S3** (per-item protection before reading `~`), and integrates **L4**
(cached instant start with visible staleness) from
[.plans/remaining-work.md](remaining-work.md).

---

## 1. Product shape and trust rules

### 1.1 Category taxonomy (11 mutually exclusive buckets)

Every allocated byte inside a walked root is assigned to **exactly one** of
eleven categories (zero double counting across categories):

| #   | Protocol ID   | Label       | What belongs here                                                                                       | Actionability                                                  |
| --- | ------------- | ----------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | `apps`        | Apps        | Installed app bundles, Flatpak/Snap runtimes, Program Files, AppData/Application Support (non-cache)    | **Info only**                                                  |
| 2   | `developer`   | Developer   | Sweep's project artifacts (`node_modules`, `target`, `.next`, …) + SDKs, simulators, toolchains, Docker | **Developer review** (+ owner-tool hints)                      |
| 3   | `photos`      | Photos      | Pictures folder, Photos Libraries, image formats (`.jpg`, `.heic`, `.png`, `.raw`, `.dng`, …)           | **Info only**                                                  |
| 4   | `videos`      | Videos      | Movies/Videos folder, screen recordings, video formats (`.mp4`, `.mov`, `.mkv`, `.webm`, …)             | **Info only**                                                  |
| 5   | `music`       | Music       | Music folder, audio libraries, audio formats (`.mp3`, `.flac`, `.wav`, `.m4a`, `.opus`, …)              | **Info only**                                                  |
| 6   | `documents`   | Documents   | Documents & Desktop folders, office/PDF/book/text formats (`.pdf`, `.docx`, `.xlsx`, `.epub`, …)        | **Info only**                                                  |
| 7   | `downloads`   | Downloads   | User Downloads directory (installers, archives, saved files; sub-insights break down by type)           | **Info only**                                                  |
| 8   | `system_data` | System data | Volume-level residual (`volume.used - classified`) covering OS, other users, snapshots, unreadable dirs | **Info only**                                                  |
| 9   | `caches`      | Caches      | Regenerable OS/app/package-manager caches (`~/.cache`, `~/Library/Caches`, `%LOCALAPPDATA%` caches)     | **Allowlisted cache review** (only explicit allowlist entries) |
| 10  | `trash`       | Trash       | User Trash / Recycle Bin (`~/.Trash`, `~/.local/share/Trash`, Windows Recycle Bin)                      | **Separate Trash confirm**                                     |
| 11  | `other`       | Other       | Anything on disk inside the walked root not classified above (VM images, game saves, unknown blobs)     | **Info only**                                                  |

### 1.2 Non-negotiable trust rules

1. **Personal files are strictly information-only — forever.**
   `photos`, `videos`, `music`, `documents`, and `downloads` (plus `apps`,
   `system_data`, and `other`) can **never** be queued, placed into a
   `ScanPlan`, or removed by `sweep`. This is enforced at four independent
   layers:
   - **Protocol:** `SpaceReport` is a read-only document with no
     `selectedCandidateIds` and is rejected by `sweep apply --plan`.
   - **Core planner (JS) & Rust engine:** Both `guardrails.ts` and
     `crates/sweep-engine/src/guardrails.rs` keep `assertSafeCwd` unchanged for
     destructive commands (`scan`, `clean`, `plan`, `apply`). A separate
     read-only guard (`assertSafeReadOnlyRoot`) permits `~` and volume roots
     **only** for `sweep space`. Additionally, any path resolved under a
     personal-root policy guard (`isPersonalRootTarget`) can never be targeted
     by cache or trash actions.
   - **TUI:** Pressing `Space`, `a`, `s`, `x`, or `d` on an `info_only`
     category row does nothing and flashes a clear notice:
     `Personal files are info-only — sweep never queues or removes them.`
   - **Apply boundary:** `sweep-engine apply` and JS `applyPlan` only accept
     explicit `ScanPlan` (developer artifacts), `CacheCleanPlan` (entries
     verified against the compiled-in allowlist at apply time), or
     `TrashEmptyRequest` (verified against OS Trash root at apply time). A
     forged JSON plan cannot smuggle a personal path through any lane.

2. **Three and only three action classes exist:**
   - **Class A — Developer artifacts (existing planner & guardrails):**
     Selecting "Review Developer" opens `sweep`'s existing project review
     (`ProjectsView` / `sweep ui <project-root>`) scoped to the discovered
     project trees. All existing protections apply verbatim: `assertSafeCwd`,
     S1 context checks (`entry-type-mismatch`, `tool-home`, `no-project-marker`),
     VCS & project-file blocks, git-tracked file blocks, filesystem-identity
     pinning, `maxSizeGB`, empty initial queue, and confirmation dialog.
     Developer **toolchains** (e.g. `~/.rustup/toolchains`, `~/go/pkg/mod`,
     Docker images, Xcode Simulators) are **never** raw-deleted by `sweep`;
     they either map to an allowlisted cache entry (below) or surface a
     copy-only **owner-tool command** (e.g. `docker system prune`,
     `xcrun simctl delete unavailable`, `rustup toolchain list`).
   - **Class B — Known regenerable caches (hardcoded per-OS allowlist):**
     Only entries present in Sweep's compiled, versioned per-OS cache allowlist
     (Section 1.3) may be offered for cleanup. Every other directory inside
     `~/.cache`, `~/Library/Caches`, or `%LOCALAPPDATA%` stays **read-only /
     information-only**. Each allowlisted entry carries:
     - a plain-language reason,
     - an explicit rebuild badge: **`Comes back on its own`** (refills silently
       on next run; eligible for cache bulk-select) or **`Check first`** (slow
       to re-download, clears offline store, or requires stopping a tool; never
       bulk-selected, requires per-row opt-in),
     - an active-process check (if the owning app or package manager appears to
       be running, the row is marked `in use · close app first` and excluded
       from bulk selection),
     - removal either via Sweep's identity-pinned bounded remover (with
       `openat2` on Linux / non-following handle checks) or by invoking the
       owner tool's own clean command, never via `sudo`.
   - **Class C — Emptying the Trash (separate review & confirmation):**
     Trash is **never** bundled into a Developer or Cache selection queue.
     Reviewing Trash opens a dedicated confirmation modal displaying item count,
     allocated bytes, oldest/newest deletion date (when readable), and
     expected volume gain. The modal explicitly states that emptying Trash is
     **permanent (no undo)** and requires its own confirmation key (`y` after
     committed dialog render, matching UX Principle 5).

3. **S3 prerequisite alignment (`.plans/remaining-work.md`):**
   Before allowing read-only walks of `~` or `/`, we first close the OS-root
   guardrail gap identified in the 2026-11-27 audit (**F03**: prefix-blocking
   `/etc`, `/sys`, `/proc`, `/dev`, `/boot`, `/bin`, `/sbin`, `/lib*`,
   `C:\Windows` in `assertSafeCwd` and adding them to `SYSTEM_TOOL_DIRS` in
   both JS and Rust) so destructive `sweep` commands remain strictly confined
   to user project trees while `sweep space` reads `~` safely.

### 1.3 Explicit per-OS regenerable cache allowlist

Only directories in this compiled allowlist can enter Class B cache review.
System-wide package caches requiring root privileges (`pacman`, `apt`, `dnf`)
are **`owner_tool_readonly`**: Sweep measures them and displays the exact
`sudo` command for the user to run themselves, never executing `sudo`.

#### macOS allowlist

| ID                       | Canonical path template                         | Owner         | Status badge          | Reason                                                                                         | Mechanism                                                             |
| ------------------------ | ----------------------------------------------- | ------------- | --------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `macos-xcode-derived`    | `~/Library/Developer/Xcode/DerivedData`         | Xcode         | Comes back on its own | Intermediate build outputs and indexes; Xcode rebuilds on next build                           | Sweep bounded remove (skip if `Xcode`/`xcodebuild` running)           |
| `macos-xcode-previews`   | `~/Library/Developer/Xcode/UserData/Previews`   | Xcode         | Comes back on its own | SwiftUI canvas preview simulator clones                                                        | Owner tool (`xcrun simctl --set previews delete all`) or Sweep remove |
| `macos-xcode-sim-caches` | `~/Library/Developer/CoreSimulator/Caches`      | CoreSimulator | Comes back on its own | Simulator dyld and runtime image caches                                                        | Sweep bounded remove (skip if `Simulator` running)                    |
| `macos-homebrew-cache`   | `~/Library/Caches/Homebrew`                     | Homebrew      | Comes back on its own | Downloaded bottle tarballs already installed                                                   | Owner tool (`brew cleanup --prune=all`) or Sweep remove               |
| `macos-npm-cache`        | `~/.npm/_cacache`                               | npm           | Comes back on its own | Content-addressed tarball cache; re-downloads when needed                                      | Owner tool (`npm cache clean --force`) or Sweep remove                |
| `macos-bun-cache`        | `~/.bun/install/cache`                          | Bun           | Comes back on its own | Global package install cache; refills on next `bun install`                                    | Sweep bounded remove (skip if `bun` running)                          |
| `macos-pnpm-store`       | `~/Library/pnpm/store`                          | pnpm          | **Check first**       | Shared hardlinked package store; clearing forces full re-downloads and breaks offline installs | Owner tool (`pnpm store prune`) only                                  |
| `macos-yarn-cache`       | `~/Library/Caches/Yarn`                         | Yarn          | Comes back on its own | Cached Yarn package archives                                                                   | Sweep bounded remove                                                  |
| `macos-pip-cache`        | `~/Library/Caches/pip`                          | pip           | Comes back on its own | Cached Python wheels and HTTP responses                                                        | Sweep bounded remove                                                  |
| `macos-uv-cache`         | `~/Library/Caches/uv`                           | uv            | Comes back on its own | Cached Python wheels and environments                                                          | Owner tool (`uv cache clean`) or Sweep remove                         |
| `macos-cargo-cache`      | `~/.cargo/registry/cache`                       | Cargo         | Comes back on its own | Compressed `.crate` archives (keeps unpacked `src` until `check_first`)                        | Sweep bounded remove (skip if `cargo` running)                        |
| `macos-go-build-cache`   | `~/Library/Caches/go-build`                     | Go            | Comes back on its own | Compiled Go build artifacts; `go build` rebuilds automatically                                 | Owner tool (`go clean -cache`) or Sweep remove                        |
| `macos-gradle-caches`    | `~/.gradle/caches`                              | Gradle        | **Check first**       | Downloaded JARs and build transforms; slow to re-download offline                              | Sweep bounded remove (skip if `java`/`gradle` running)                |
| `macos-cocoapods-cache`  | `~/Library/Caches/CocoaPods`                    | CocoaPods     | Comes back on its own | Downloaded pod specs and archives                                                              | Sweep bounded remove                                                  |
| `macos-playwright-cache` | `~/Library/Caches/ms-playwright`                | Playwright    | **Check first**       | Downloaded headless browser binaries; requires `playwright install` to restore                 | Sweep bounded remove                                                  |
| `macos-chrome-cache`     | `~/Library/Caches/Google/Chrome`                | Chrome        | Comes back on its own | Web asset and shader cache (preserves profiles, logins, bookmarks)                             | Sweep bounded remove (skip if Chrome running)                         |
| `macos-safari-cache`     | `~/Library/Caches/com.apple.Safari`             | Safari        | Comes back on its own | Web cache (often TCC-restricted; skipped cleanly on EPERM)                                     | Sweep bounded remove (skip if Safari running)                         |
| `macos-firefox-cache`    | `~/Library/Caches/Firefox/Profiles/*/cache2`    | Firefox       | Comes back on its own | Browser HTTP disk cache (preserves profiles)                                                   | Sweep bounded remove (skip if Firefox running)                        |
| `macos-electron-code`    | `~/Library/Application Support/Code/CachedData` | VS Code       | Comes back on its own | V8 bytecode caches rebuilt on editor start                                                     | Sweep bounded remove (skip if Code running)                           |
| `macos-hf-cache`         | `~/.cache/huggingface/hub`                      | Hugging Face  | **Check first**       | Multi-GiB downloaded ML model weights; very slow to re-download                                | Sweep bounded remove                                                  |

#### Linux allowlist

| ID                       | Canonical path template                                   | Owner           | Status badge                | Reason                                                               | Mechanism                                           |
| ------------------------ | --------------------------------------------------------- | --------------- | --------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| `linux-bun-cache`        | `~/.bun/install/cache`                                    | Bun             | Comes back on its own       | Global Bun package install cache                                     | Sweep bounded remove (skip if `bun` running)        |
| `linux-npm-cache`        | `~/.npm/_cacache`                                         | npm             | Comes back on its own       | npm content-addressed download cache                                 | Sweep bounded remove                                |
| `linux-pnpm-store`       | `$XDG_DATA_HOME/pnpm/store` (`~/.local/share/pnpm/store`) | pnpm            | **Check first**             | Shared hardlinked store; run `pnpm store prune` instead of full wipe | Owner tool (`pnpm store prune`) only                |
| `linux-yarn-cache`       | `$XDG_CACHE_HOME/yarn` (`~/.cache/yarn`)                  | Yarn            | Comes back on its own       | Cached Yarn archives                                                 | Sweep bounded remove                                |
| `linux-pip-cache`        | `$XDG_CACHE_HOME/pip` (`~/.cache/pip`)                    | pip             | Comes back on its own       | Cached Python wheels and HTTP responses                              | Sweep bounded remove                                |
| `linux-uv-cache`         | `$XDG_CACHE_HOME/uv` (`~/.cache/uv`)                      | uv              | Comes back on its own       | Cached Python wheels and archives                                    | Owner tool (`uv cache clean`) or Sweep remove       |
| `linux-cargo-cache`      | `~/.cargo/registry/cache`                                 | Cargo           | Comes back on its own       | Downloaded `.crate` tarballs                                         | Sweep bounded remove (skip if `cargo` running)      |
| `linux-go-build-cache`   | `$XDG_CACHE_HOME/go-build` (`~/.cache/go-build`)          | Go              | Comes back on its own       | Compiled Go build cache                                              | Owner tool (`go clean -cache`) or Sweep remove      |
| `linux-gradle-caches`    | `~/.gradle/caches`                                        | Gradle          | **Check first**             | Downloaded JVM artifacts; slow to re-download                        | Sweep bounded remove                                |
| `linux-thumbnails`       | `$XDG_CACHE_HOME/thumbnails` (`~/.cache/thumbnails`)      | Desktop         | Comes back on its own       | File-manager image/video preview thumbnails                          | Sweep bounded remove                                |
| `linux-mesa-shader`      | `$XDG_CACHE_HOME/mesa_shader_cache*`                      | Mesa GPU        | Comes back on its own       | Compiled OpenGL/Vulkan shaders; rebuilt on next launch               | Sweep bounded remove                                |
| `linux-chrome-cache`     | `$XDG_CACHE_HOME/google-chrome` / `chromium`              | Chrome/Chromium | Comes back on its own       | Browser HTTP/GPU cache (profiles stay in `~/.config`)                | Sweep bounded remove (skip if running)              |
| `linux-firefox-cache`    | `$XDG_CACHE_HOME/mozilla/firefox/*/cache2`                | Firefox         | Comes back on its own       | Browser HTTP cache (profiles stay in `~/.mozilla`)                   | Sweep bounded remove (skip if running)              |
| `linux-playwright-cache` | `$XDG_CACHE_HOME/ms-playwright`                           | Playwright      | **Check first**             | Headless browser binaries; needs `playwright install`                | Sweep bounded remove                                |
| `linux-yay-paru-cache`   | `$XDG_CACHE_HOME/yay` & `$XDG_CACHE_HOME/paru/clone`      | AUR helpers     | **Check first**             | Cloned AUR build trees and built `.pkg.tar.zst` files                | Owner tool (`yay -Sc` / `paru -Sc`) or Sweep remove |
| `linux-hf-cache`         | `$XDG_CACHE_HOME/huggingface/hub`                         | Hugging Face    | **Check first**             | Multi-GiB ML model weights; slow to re-download                      | Sweep bounded remove                                |
| `linux-pacman-cache`     | `/var/cache/pacman/pkg`                                   | pacman          | **Check first** (owner cmd) | System package cache (root-owned; Sweep never runs `sudo`)           | Report only: `sudo paccache -r`                     |
| `linux-apt-cache`        | `/var/cache/apt/archives`                                 | apt             | **Check first** (owner cmd) | System `.deb` package cache (root-owned)                             | Report only: `sudo apt clean`                       |
| `linux-dnf-cache`        | `/var/cache/dnf` / `/var/cache/libdnf5`                   | dnf             | **Check first** (owner cmd) | System RPM metadata & package cache (root-owned)                     | Report only: `sudo dnf clean all`                   |

#### Windows allowlist

| ID                     | Canonical path template                            | Owner        | Status badge          | Reason                                                           | Mechanism                                            |
| ---------------------- | -------------------------------------------------- | ------------ | --------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `win-user-temp`        | `%LOCALAPPDATA%\Temp`                              | Windows      | Comes back on its own | Per-user temporary files (locked open files are skipped cleanly) | Sweep bounded remove (skip locked / in-use entries)  |
| `win-npm-cache`        | `%LOCALAPPDATA%\npm-cache`                         | npm          | Comes back on its own | npm download cache                                               | Sweep bounded remove                                 |
| `win-bun-cache`        | `%USERPROFILE%\.bun\install\cache`                 | Bun          | Comes back on its own | Global Bun package cache                                         | Sweep bounded remove (skip if `bun.exe` running)     |
| `win-pnpm-store`       | `%LOCALAPPDATA%\pnpm\store`                        | pnpm         | **Check first**       | Shared hardlinked package store                                  | Owner tool (`pnpm store prune`) only                 |
| `win-yarn-cache`       | `%LOCALAPPDATA%\Yarn\Cache`                        | Yarn         | Comes back on its own | Cached Yarn archives                                             | Sweep bounded remove                                 |
| `win-pip-cache`        | `%LOCALAPPDATA%\pip\Cache`                         | pip          | Comes back on its own | Cached Python wheels                                             | Sweep bounded remove                                 |
| `win-uv-cache`         | `%LOCALAPPDATA%\uv\cache`                          | uv           | Comes back on its own | Cached Python wheels and tool archives                           | Owner tool (`uv cache clean`) or Sweep remove        |
| `win-cargo-cache`      | `%USERPROFILE%\.cargo\registry\cache`              | Cargo        | Comes back on its own | Downloaded `.crate` tarballs                                     | Sweep bounded remove                                 |
| `win-go-build-cache`   | `%LOCALAPPDATA%\go-build`                          | Go           | Comes back on its own | Compiled Go build cache                                          | Owner tool (`go clean -cache`) or Sweep remove       |
| `win-nuget-http`       | `%LOCALAPPDATA%\NuGet\v3-cache`                    | NuGet        | Comes back on its own | NuGet HTTP metadata cache                                        | Sweep bounded remove                                 |
| `win-gradle-caches`    | `%USERPROFILE%\.gradle\caches`                     | Gradle       | **Check first**       | Downloaded JVM artifacts; slow to re-download                    | Sweep bounded remove                                 |
| `win-playwright-cache` | `%LOCALAPPDATA%\ms-playwright`                     | Playwright   | **Check first**       | Headless browser binaries; needs `playwright install`            | Sweep bounded remove                                 |
| `win-chrome-cache`     | `%LOCALAPPDATA%\Google\Chrome\User Data\*\Cache`   | Chrome       | Comes back on its own | Browser HTTP cache (profiles/logins untouched)                   | Sweep bounded remove (skip if `chrome.exe` running)  |
| `win-edge-cache`       | `%LOCALAPPDATA%\Microsoft\Edge\User Data\*\Cache`  | Edge         | Comes back on its own | Browser HTTP cache (profiles/logins untouched)                   | Sweep bounded remove (skip if `msedge.exe` running)  |
| `win-firefox-cache`    | `%LOCALAPPDATA%\Mozilla\Firefox\Profiles\*\cache2` | Firefox      | Comes back on its own | Browser HTTP cache                                               | Sweep bounded remove (skip if `firefox.exe` running) |
| `win-dx-shader`        | `%LOCALAPPDATA%\D3DSCache`                         | DirectX      | Comes back on its own | Compiled GPU shader cache; rebuilt on next launch                | Sweep bounded remove                                 |
| `win-hf-cache`         | `%USERPROFILE%\.cache\huggingface\hub`             | Hugging Face | **Check first**       | Multi-GiB ML model weights                                       | Sweep bounded remove                                 |

### 1.4 Proposed edits to `.docs/product-direction.md`

Replace lines 5–8, 25–31, and 38–45 of
[.docs/product-direction.md](../.docs/product-direction.md) with:

```markdown
The primary audience is developers and vibecoders managing project trees,
extended to any desktop user answering "where did my disk space go?" through a
read-only category overview. The default human experience should expose useful
cleanup choices without requiring shortcut knowledge: where space sits, largest
reclaimable artifacts, explicit selection, review, confirmation, and a receipt.
Time saved and repeat use matter more than promotional counters.
```

Under `## Primary use cases`:

```markdown
- Safe scripted cleanup for developers, CI, and agents.
- Read-only home and volume space reporting (`sweep space`) that shows where
  disk space goes across Apps, Developer, personal media, Caches, Trash, and
  System data without ever turning personal files into deletion targets.
- Human review and selective cleanup when a full-screen UI is worth it.
- Monorepo and project-tree artifact cleanup that feels trustworthy instead of
  blunt.
```

Under `## UI direction`:

```markdown
- Future UI stays cleanup-first.
- Search, filtering, grouping, risk review, and selection ergonomics matter.
- The UI may include a read-only "Where your space goes" overview (`sweep ui
  --view space`) that shows category totals and routes users into safe review
  (developer artifacts, allowlisted regenerable caches, or Trash), but must
  never turn into a generic file manager or arbitrary-file deleter. Personal
  file categories remain strictly information-only.
- Search should be fast over structured candidate fields and selection should
  feel immediate.
```

### 1.5 Proposed `.docs/decision-log.md` entry

Append to [.docs/decision-log.md](../.docs/decision-log.md) when Phase 0 lands:

```markdown
## Read-only space report (`sweep space`, 2026-11-27)

The owner approved expanding `sweep` with a read-only "Where your space goes"
report across 11 categories (`Apps`, `Developer`, `Photos`, `Videos`, `Music`,
`Documents`, `Downloads`, `System data`, `Caches`, `Trash`, `Other`), reachable
via `sweep space [path]` and `sweep ui --view space`:

- **Read-only home/volume access is decoupled from destructive guardrails.**
  `assertSafeCwd` continues to refuse `~`, `/`, drive roots, and OS system
  subtrees for `scan`, `clean`, `plan`, and `apply`. `sweep space` uses a
  separate `assertSafeReadOnlyRoot` policy that permits `~` and volume roots
  strictly for read-only aggregation and never produces an executable `ScanPlan`.
- **Personal files are permanently information-only.** Photos, Videos, Music,
  Documents, Downloads, Apps, System data, and Other cannot be queued, planned,
  or removed in either engine or the TUI.
- **Only three action classes are permitted**, each with its own confirmation
  boundary: (1) Developer project artifacts via the existing `sweep` planner
  and guardrails; (2) an explicit, versioned, per-OS allowlist of regenerable
  caches, each tagged "Comes back on its own" or "Check first" with running-app
  exclusions; and (3) emptying the OS Trash behind a separate permanent-delete
  confirmation dialog. Root-owned system caches (e.g. pacman, apt, dnf) are
  report-only with copyable owner commands; `sweep` never invokes `sudo`.
- **Allocated bytes lead.** Space reports count allocated disk blocks
  (`st_blocks * 512` on Unix; `GetCompressedFileSizeW` / allocation size on
  Windows) alongside apparent bytes so sparse files, tiny-file block overhead,
  and cloud-evicted placeholders reconcile honestly with volume free space.
  `System data` is computed only at volume/home scope as
  `max(0, volume.used - classified)` with explicit caveats for APFS/Btrfs
  clones, snapshots, and unreadable directories.
- **Zero telemetry and private-by-default caching.** Nothing leaves the
  machine. Cached instant-start snapshots (L4) live in a private `0600` file
  with aggregate category numbers only (no personal file paths) and display
  explicit staleness until rescanned. `--redact` produces shareable output
  without usernames or private paths.
```

---

## 2. CLI surface, protocol schemas, exit codes, and Rust engine reuse

### 2.1 CLI surface (`apps/cli`)

#### New command: `sweep space [path]`

Read-only category breakdown. Never mutates the filesystem.

```text
sweep space [path] [options]

Arguments:
  [path]                          Directory or mount to report (default: ~)

Options:
  --scope <home|volume|path>      Reporting scope (default: home when [path]
                                  omitted or equals ~; volume for / or drive
                                  root; path for any other directory)
  --metric <allocated|apparent>   Primary displayed byte metric (default:
                                  allocated; JSON always includes both)
  --json                          Emit final SpaceReport JSON document
  --json-stream                   Emit NDJSON SpaceEvent lifecycle stream
  --redact                        Anonymize usernames, mount labels, and paths
                                  for safe sharing (bug reports / screenshots)
  --no-cache                      Ignore cached snapshot; wait for fresh walk
  --engine <auto|rust|js>         Scan engine (default: auto)
  --resource-profile <profile>    balanced (default) or low-memory
  --no-color                      Disable ANSI colors
  -q, --quiet                     Summary line only (human mode)
  --verbose                       Include subgroup tables and coverage stats
```

**Intentional omissions:** `sweep space` accepts **zero** destructive flags
(`--yes`, `--dry-run`, `--trash`, `--force-large`, `--allow-dangerous`). Passing
any destructive flag fails with `invalid_arguments` (exit 2) and points to the
read-only contract.

**Human CLI output** prints the compact storage card (big used/total figure,
dim free-space line, Braille segmented bar, 3-column category legend, one
top-recommendation sentence with the exact next command such as
`Run: sweep ui --view space` or `sweep ui ~/Projects`).

#### TUI integration (`sweep ui`)

- **`sweep ui --view space [path]`** extends `--view <projects|full|space>` in
  `apps/cli/src/cli.ts`. When `--view space` is selected (or when `[path]` is
  omitted and the user invokes `sweep ui --view space`), the target defaults to
  `~` via `assertSafeReadOnlyRoot`.
- **In-session navigation from existing views:**
  - Press **`w`** ("Where space goes") in Projects or Full view, or choose
    `Space overview` from the **`Ctrl+K` / `F2`** Actions palette. (`s` remains
    bound to "Queue safe items" with zero conflict.)
  - Per UX Principle 2 (**Esc walks back — it never quits**), `Esc` inside
    `SpaceView` unwinds: open modal (Cache review / Trash confirm) → focused
    category drill-down → back to `ProjectsView` (when entered from
    `ProjectsView`). When launched directly via `sweep ui --view space ~`,
    `Esc` at the top layer flashes `nothing to unwind - q or ctrl-c quits`.
- **Interactive handoff from `SpaceView`:**
  - Choosing `[Review Developer]` transitions into `ProjectsView` scoped to the
    discovered project roots (starting with an **empty queue**, matching UX
    Principle 3).
  - Choosing `[Review Caches]` opens the Allowlisted Cache Review overlay
    (entries start unselected; `s` queues `"Comes back on its own"` entries
    only, skipping `"Check first"` and running-app caches; `c` opens confirm).
  - Choosing `[Review Trash]` opens the dedicated Trash confirmation overlay
    (separate from every other queue).

### 2.2 Additive, versioned protocol and JSON Schema additions

All additions live in `packages/protocol/` and `crates/sweep-types/` under
`protocolVersion: "1"` (additive, non-breaking per `remaining-work.md` Rule 6).
`sweep schema` exports two new optional keys alongside the existing four:

```json
{
  "protocolVersion": "1",
  "schemas": {
    "scanPlan": { "...": "unchanged" },
    "scanEvent": { "...": "unchanged" },
    "applyReport": { "...": "unchanged" },
    "shared": { "...": "unchanged" },
    "spaceReport": { "$ref": "space-report.schema.json" },
    "spaceEvent": { "$ref": "space-event.schema.json" }
  }
}
```

#### New schema: `packages/protocol/schemas/space-report.schema.json`

Key contract fields (all integer byte/count fields bounded by
`0 <= n <= 9007199254740991`, `additionalProperties: false` everywhere):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://kitsunekode.dev/sweep/schemas/space-report.schema.json",
  "title": "SpaceReport",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "protocolVersion",
    "reportVersion",
    "readOnly",
    "scope",
    "targetDir",
    "redacted",
    "createdAt",
    "elapsedMs",
    "engine",
    "metric",
    "cached",
    "coverage",
    "categories",
    "actions"
  ],
  "properties": {
    "protocolVersion": { "const": "1" },
    "reportVersion": { "const": "1" },
    "readOnly": { "const": true },
    "scope": { "enum": ["home", "volume", "path"] },
    "targetDir": { "type": "string", "minLength": 1, "maxLength": 4096 },
    "redacted": { "type": "boolean" },
    "createdAt": { "type": "string", "format": "date-time" },
    "elapsedMs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
    "engine": { "enum": ["rust", "js"] },
    "metric": { "enum": ["allocated", "apparent"] },
    "cached": { "type": "boolean" },
    "cacheAgeMs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
    "volume": {
      "type": "object",
      "additionalProperties": false,
      "required": ["mountPoint", "totalBytes", "usedBytes", "availableBytes", "bytesBasis"],
      "properties": {
        "mountPoint": { "type": "string" },
        "fsType": { "type": "string" },
        "totalBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "usedBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "availableBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "purgeableBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "snapshotCount": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "bytesBasis": { "enum": ["statvfs", "GetDiskFreeSpaceEx", "unavailable"] }
      }
    },
    "coverage": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "scannedDirs",
        "scannedFiles",
        "skippedDirs",
        "skippedFiles",
        "permissionDeniedDirs",
        "crossDeviceSkippedDirs",
        "hardlinkDedupedInodes",
        "hardlinkDedupCapHit",
        "complete",
        "partialReasons"
      ],
      "properties": {
        "scannedDirs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "scannedFiles": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "skippedDirs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "skippedFiles": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "permissionDeniedDirs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "crossDeviceSkippedDirs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "hardlinkDedupedInodes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "hardlinkDedupCapHit": { "type": "boolean" },
        "complete": { "type": "boolean" },
        "partialReasons": {
          "type": "array",
          "maxItems": 16,
          "items": {
            "enum": [
              "permission_denied",
              "hardlink_dedup_cap",
              "queue_cap",
              "clone_or_compression_overlap",
              "unreadable_entries",
              "cloud_placeholders_excluded"
            ]
          }
        }
      }
    },
    "categories": {
      "type": "array",
      "minItems": 11,
      "maxItems": 11,
      "items": { "$ref": "#/$defs/spaceCategory" }
    },
    "actions": {
      "type": "array",
      "maxItems": 8,
      "items": { "$ref": "#/$defs/spaceAction" }
    }
  },
  "$defs": {
    "categoryId": {
      "enum": [
        "apps",
        "developer",
        "photos",
        "videos",
        "music",
        "documents",
        "downloads",
        "system_data",
        "caches",
        "trash",
        "other"
      ]
    },
    "spaceSubgroup": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "label", "allocatedBytes", "apparentBytes", "fileCount", "actionability"],
      "properties": {
        "id": { "type": "string", "maxLength": 128 },
        "label": { "type": "string", "maxLength": 256 },
        "path": { "type": "string", "maxLength": 4096 },
        "allocatedBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "apparentBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "fileCount": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "actionability": {
          "enum": [
            "info_only",
            "developer_cleanup",
            "allowlisted_cache",
            "trash_empty",
            "owner_tool"
          ]
        },
        "allowlistId": { "type": "string", "maxLength": 128 },
        "rebuildStatus": {
          "enum": ["comes_back", "reinstall", "rebuild", "check_first", "info_only"]
        },
        "reason": { "type": "string", "maxLength": 512 },
        "ownerCommand": { "type": "string", "maxLength": 512 },
        "inUse": { "type": "boolean" }
      }
    },
    "spaceCategory": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "label",
        "allocatedBytes",
        "apparentBytes",
        "fileCount",
        "bytesKnown",
        "actionability",
        "insight",
        "subgroups"
      ],
      "properties": {
        "id": { "$ref": "#/$defs/categoryId" },
        "label": { "type": "string", "maxLength": 64 },
        "allocatedBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "apparentBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "fileCount": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "bytesKnown": { "type": "boolean" },
        "actionability": {
          "enum": [
            "info_only",
            "developer_cleanup",
            "allowlisted_cache",
            "trash_empty",
            "owner_tool"
          ]
        },
        "insight": { "type": "string", "maxLength": 512 },
        "subgroups": {
          "type": "array",
          "maxItems": 16,
          "items": { "$ref": "#/$defs/spaceSubgroup" }
        }
      }
    },
    "spaceAction": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "kind",
        "category",
        "estimatedBytes",
        "statusLabel",
        "sentence",
        "buttonLabel",
        "requiresConfirmation"
      ],
      "properties": {
        "id": { "type": "string", "maxLength": 128 },
        "kind": { "enum": ["developer_review", "cache_review", "trash_review", "owner_command"] },
        "category": { "enum": ["developer", "caches", "trash"] },
        "estimatedBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "statusLabel": { "enum": ["Comes back on its own", "Check first", "Already deleted"] },
        "sentence": { "type": "string", "maxLength": 512 },
        "buttonLabel": { "type": "string", "maxLength": 64 },
        "targetRoots": {
          "type": "array",
          "maxItems": 32,
          "items": { "type": "string", "maxLength": 4096 }
        },
        "allowlistIds": {
          "type": "array",
          "maxItems": 32,
          "items": { "type": "string", "maxLength": 128 }
        },
        "ownerCommand": { "type": "string", "maxLength": 512 },
        "requiresConfirmation": { "const": true }
      }
    }
  }
}
```

Notice two structural safety guarantees baked directly into the JSON Schema:

1. `"readOnly": { "const": true }` — cannot be confused with an executable
   `ScanPlan`.
2. `spaceAction.category` enum is strictly `["developer", "caches", "trash"]` —
   the schema itself makes it syntactically impossible to emit a cleanup action
   targeting `photos`, `videos`, `music`, `documents`, `downloads`, `apps`,
   `system_data`, or `other`.

#### New streaming schema: `packages/protocol/schemas/space-event.schema.json`

NDJSON events emitted by `sweep space --json-stream` and consumed by the TUI:

- `space_started`: `{ type, targetDir, scope, volume? }`
- `space_cached_snapshot`: `{ type, report }` (emitted immediately if a valid
  private cache exists, with `report.cached: true` and `report.cacheAgeMs` so
  the TUI paints an explicitly labeled stale view in <50 ms while scanning)
- `space_progress`: `{ type, scannedDirs, scannedFiles, skippedDirs, currentDir?, categories: [{ id, allocatedBytes, apparentBytes, fileCount }] }` (throttled to ~60–100 ms cadence so the dithered bar grows smoothly without pipe floods)
- `space_warning`: `{ type, code, message }`
- `space_completed`: `{ type, report }` (the complete validated `SpaceReport`)

### 2.3 Exit codes

Reuses `EXIT` in [apps/cli/src/errors.ts](../apps/cli/src/errors.ts) verbatim:

| Exit code | Name                | Meaning for `sweep space`                                                                                                                                                                     |
| --------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | `EXIT.OK`           | Report completed (including normal partial coverage such as macOS TCC-restricted `~/Library/Safari`, clearly flagged via `coverage.complete: false` and `coverage.permissionDeniedDirs > 0`). |
| `1`       | `EXIT.ABORTED`      | Cancelled by `SIGINT` / `SIGTERM` or TUI quit before completion.                                                                                                                              |
| `2`       | `EXIT.GUARDRAIL`    | Invalid CLI arguments (including passing any destructive flag to `sweep space`), blocked virtual/pseudo-filesystem root (`/proc`, `/sys`, `/dev`), or fatal resource cap exceeded.            |
| `3`       | `EXIT.CONFIG_PARSE` | Malformed stdin JSON (engine CLI) or invalid config file.                                                                                                                                     |
| `4`       | `EXIT.FAILURE`      | Target root unreadable/missing, engine crash, malformed stream, or stdout pipe failure.                                                                                                       |

### 2.4 Reusing the Rust engine (`crates/sweep-fs`, `crates/sweep-engine`, `crates/sweep-engine-cli`)

- **New native subcommand:** `sweep-engine space <target-dir>` reading
  `SpaceStdinOptions` JSON on stdin (`scope`, `metric`, `jsonStream`,
  `redact`, `limits`, `osHints`).
- **Capability advertisement:** `sweep-engine --capabilities` adds
  `"spaceReport": true` (additive). The JS host checks this capability before
  invoking native `space`; older native binaries fall back to the JS
  `space-scanner.ts` with a clear stderr notice (read-only fallback is safe,
  unlike destructive apply).
- **Direct reuse of `crates/sweep-fs` primitives:**
  - Work-stealing LIFO directory pool (`crossbeam-deque::Worker::new_lifo`,
    `Injector`, `Stealer`) and CPU-aware worker sizing from
    `crates/sweep-fs/src/concurrency.rs`.
  - Cross-platform `file_identity()` from `crates/sweep-fs/src/identity.rs`
    (Unix `(dev, ino, nlink)`, Windows `GetFileInformationByHandle`).
  - Symlink/reparse-point refusal (`meta_is_reparse_point`, never following
    symlinks/junctions) and `MAX_DIR_ENTRIES` (4,000,000) runaway-dir guard.
  - Existing `PatternMatcher`, `artifact_rule_for`, and `classify.rs` to detect
    project roots and developer artifacts in the **same single pass** as space
    aggregation (no second full walk of `~/Projects`!).
  - Cooperative cancellation via `AtomicBool` wired to `SIGINT`/`SIGTERM`
    (Unix) and console control handler (Windows), reusing the existing signal
    infrastructure in `crates/sweep-engine-cli/src/main.rs`.
- **Single-pass zero-path-retention aggregation:** Unlike candidate discovery,
  `space_walk` allocates **zero** per-file path strings. Each worker maintains
  a thread-local `[CategoryTotals; 11]` array plus a tiny bounded top-K
  directory-subtree map (depth ≤ 3 below each category root, capped at 64
  heaviest entries per category) merged atomically every 100 ms for streaming
  progress and once on join.

---

## 3. Classification method per OS

### 3.1 Deterministic priority waterfall (zero double counting)

Each directory/file encountered during the single-pass walk is classified by
the **first matching rule** in this strict order:

1. **Skip rules (never traversed, never counted twice):**
   - Symlinks and Windows junctions/reparse points: price only the link inode
     itself (never recurse into its target).
   - Pseudo/virtual filesystems: `/proc`, `/sys`, `/dev`, `/run`, `/snap/*`
     squashfs loop mounts, `tmpfs`/`devtmpfs`/`cgroup2`/`overlay` mounts inside
     `/` unless explicitly targeted.
   - Cross-device mounts (`st_dev != root_dev`): skipped by default on
     `home`/`volume` scope and counted in `coverage.crossDeviceSkippedDirs`
     (with a special carve-out on Linux btrfs subvolumes under the same volume
     UUID and macOS APFS Data volume, documented below).
   - Cycle/alias dedupe: `(dev, ino)` directory dedup via sharded `VisitedDirs`
     (catches bind mounts and macOS firmlinks).
2. **`trash`:** Exact canonical Trash root(s) per OS. A deleted video or
   `node_modules` inside Trash counts as **Trash**, never `Videos` or
   `Developer`.
3. **`caches`:** Compiled per-OS cache allowlist roots + OS cache containers
   (`~/.cache`, `~/Library/Caches`, `%LOCALAPPDATA%\Temp`, browser cache dirs).
   Subgroups inside `caches` tag allowlisted entries as
   `actionability: "allowlisted_cache"` and everything else inside `~/.cache` /
   `~/Library/Caches` as `actionability: "info_only"`.
   _(Precedence note: developer package caches like `~/.bun/install/cache`,
   `~/.npm/_cacache`, `~/.cargo/registry/cache`, `~/Library/Caches/pip` live in
   `caches` when they are pure regenerable download caches, whereas project
   `node_modules`/`target`/`.next` and toolchains like `~/.rustup` /
   `~/Library/Developer/CoreSimulator` live in `developer` — keeping Caches
   cleanly "refills on its own" and Developer "builds, deps & toolchains".)_
4. **`developer`:**
   - Any directory matched by `sweep`'s existing catalog (`node_modules`,
     `target` with `Cargo.toml`/`CACHEDIR.TAG`, `.next`, `.turbo`, `.venv`, …)
     outside protected tool/system trees.
   - Recognized developer toolchain & SDK homes: `~/.cargo` (minus
     `registry/cache`), `~/.rustup`, `~/.nvm`, `~/.fnm`, `~/.volta`, `~/.pyenv`,
     `~/.rbenv`, `~/.sdkman`, `~/.asdf`, `~/.mise`, `~/go`, `~/.m2`,
     `~/.gradle` (minus `caches`), `~/.android`, `~/.docker`,
     `~/.local/share/containers`, `~/Library/Developer` (Xcode DerivedData /
     CoreSimulator / DeviceSupport / Archives — with DerivedData & Sim Caches
     tagged allowlisted!), `~/.vscode`, `~/.cursor`, `~/.local/share/JetBrains`.
   - Source files inside recognized Git repositories / project roots when
     walking `~/Projects` (optional: non-artifact source files in a Git repo
     count under `developer` as `info_only` subgroup `"Source & git history"`,
     so `Developer` reflects total developer footprint while only build
     artifacts are actionable!).
5. **`apps`:** Atomic application bundles and install trees (macOS `.app`,
   `.framework`, `.pkg`, `~/Library/Application Support` non-cache,
   `~/Library/Containers`; Linux Flatpak/Snap/AppImage; Windows `Program Files`,
   `%LOCALAPPDATA%\Programs`, `%LOCALAPPDATA%\Packages`). **Crucial invariant:**
   once a subtree enters an atomic app bundle (e.g. `Foo.app/`), internal
   `.png`, `.wav`, `.mp4`, or `.pdf` resources stay in `apps` and are **never**
   misclassified as personal Photos, Music, Videos, or Documents.
6. **Known personal folders (OS-resolved):**
   - `downloads`: everything inside the OS Downloads directory stays in
     `downloads` (matching what Finder/Nautilus/Explorer show for Downloads,
     with sub-insights breaking down installers `.dmg`/`.exe`/`.AppImage`,
     archives, videos, etc.).
   - `photos`: Photos Library packages (`*.photoslibrary` counted atomically as
     `photos`, never leaking internal SQLite/cache files into `other`/`caches`),
     plus the OS Pictures directory.
   - `videos`: OS Movies/Videos directory.
   - `music`: OS Music directory.
   - `documents`: OS Documents and Desktop directories (except when a user's
     XDG config sets `XDG_DESKTOP_DIR="$HOME/"` — guard explicitly against
     any XDG folder resolving to `$HOME` itself!).
7. **Extension & bounded MIME fallback (for files outside known folders):**
   Files in uncategorized directories (e.g. `~/archive/trip.mp4`,
   `~/notes/spec.pdf`) classify by ASCII lowercase extension table into
   `photos`, `videos`, `music`, or `documents`.
8. **`other`:** Everything remaining inside the walked root (VM disk images
   `.qcow2`/`.vmdk`/`.img`, ISO files, game data, unrecognized databases).
9. **`system_data`:** Computed post-walk at volume/home scope only (Section 3.7).

### 3.2 macOS specifics

- **Spotlight & Content Types (`mdls`/`mdfind` vs compiled UTI map):**
  - During the main parallel walk, `sweep-engine` uses a compiled UTI-aligned
    extension table (zero IPC or subprocess overhead; handles >99.5% of files).
  - **Never spawn `mdls` per file:** even 10,000 spawns would take >30 s.
  - Optional bounded Spotlight fast-path / enrichment (`--use-spotlight` or
    bounded query): `mdfind` can validate Spotlight-indexed media counts on
    extensionless files or summarize screen recordings
    (`kMDItemIsScreenCapture == 1` — powering insights like `"Screen recordings
    take 24.6 GiB"` without reading file payloads!). If Spotlight indexing is
    disabled (`mdutil` off) or times out (>500 ms), Sweep falls back silently
    to filename/mtime heuristics (`Screen Recording*.mov`, `Screenshot*.png`).
- **`~/Library` routing & TCC permissions:**
  - `~/Library/Caches` → `caches`
  - `~/Library/Developer` → `developer` (with `Xcode/DerivedData`,
    `CoreSimulator/Caches`, `Xcode/UserData/Previews` mapped to allowlisted
    cache actions)
  - `~/Library/Application Support`, `~/Library/Containers`,
    `~/Library/Group Containers` → `apps` (carving out explicitly allowlisted
    cache leaves like `Code/CachedData`)
  - `~/Library/CloudStorage` (iCloud Drive, OneDrive, Dropbox File Provider) →
    walk metadata only (`lstat` never hydrates dataless files); detect
    `SF_DATALESS` (`st_flags & 0x40000000`) and count `st_blocks * 512` (which
    is `0` for cloud-evicted files), recording `cloud_placeholders_excluded` in
    `coverage.partialReasons`.
  - TCC-protected paths (`~/Library/Mail`, `~/Library/Messages`,
    `~/Library/Safari`, `~/Pictures/Photos Library.photoslibrary` without Full
    Disk Access) return `EPERM` on `read_dir`: count them in
    `coverage.permissionDeniedDirs`, do **not** retry, and surface one calm
    note in System data (`"N macOS-protected folders skipped (no Full Disk Access)"`).
- **`/Applications`, `/System/Applications`, `~/Applications`:**
  On `--scope home`, `/Applications` is read-only probed (depth-bounded bundle
  sizing) if the user is on a standard single-volume macOS layout so the
  volume card accounts for `Apps` instead of dumping `/Applications` into
  `System data`. Every `.app` bundle is treated as an atomic `apps` unit.
- **APFS firmlinks, snapshots, and purgeable space:**
  - On macOS 10.15+, `/` is a sealed read-only System volume and
    `/System/Volumes/Data` is the writable Data volume joined by firmlinks
    (`/Users`, `/Applications`, `/Library`). When walking `--scope volume`,
    walk `/System/Volumes/Data` (or resolve root device IDs and skip
    `/System/Volumes/*` aliases via `VisitedDirs`) so `/Users` is never counted
    twice.
  - Volume capacity: query `statvfs` for guaranteed free space
    (`availableBytes`) AND macOS `getattrlist` / `NSURLVolumeAvailableCapacityForImportantUsageKey`
    (via small Objective-C/CoreFoundation shim or `diskutil apfs list` fallback
    only if needed, bounded at 300 ms) for `purgeableBytes`. Display
    `availableBytes` as the primary free figure and `purgeableBytes` as a
    separate dim suffix (`154.2 GiB free · +28.4 GiB purgeable`) — never fold
    purgeable space into guaranteed free space.
  - Local APFS snapshots (`com.apple.TimeMachine.*`) hold freed blocks until
    macOS thins them. They are explicitly named in the `System data` insight
    when present (`snapshotCount` via `fs_snapshot_list` if permitted, without
    requiring root).

### 3.3 Linux specifics

- **XDG User Directories (zero subprocess spawn):**
  Read `$XDG_CONFIG_HOME/user-dirs.dirs` (fallback `~/.config/user-dirs.dirs`)
  with a bounded 16 KiB `O_NOFOLLOW | O_NONBLOCK` read. Parse
  `XDG_PICTURES_DIR`, `XDG_VIDEOS_DIR`, `XDG_MUSIC_DIR`, `XDG_DOCUMENTS_DIR`,
  `XDG_DOWNLOAD_DIR`, `XDG_DESKTOP_DIR` (expanding `$HOME` and honoring
  localized names like `~/Bilder`, `~/Téléchargements`). Reject any entry that
  resolves to `$HOME` itself, outside `$HOME` via `..`, or to `/`. Fall back to
  `$HOME/{Pictures,Videos,Music,Documents,Downloads,Desktop}` when absent.
- **Flatpak, Snap, and AppImage (`apps`):**
  - `~/.local/share/flatpak`, `/var/lib/flatpak` (on volume scope),
    `~/.var/app/*/data` & `config` → `apps`; `~/.var/app/*/cache` → `caches`
    (`info_only` unless allowlisted).
  - `~/snap` → `apps`; `/var/lib/snapd/snaps/*.snap` → `apps` (volume scope);
    `/snap/*` squashfs loop mounts are **skipped** by mount-device check so
    compressed snap images are never double-counted as uncompressed files.
  - `*.AppImage` files → `apps`.
- **Caches (`~/.cache` and system package caches):**
  - `$XDG_CACHE_HOME` (default `~/.cache`) → `caches`, with allowlisted
    subdirs tagged `allowlisted_cache` and unknown subdirs tagged `info_only`.
  - System package caches (`/var/cache/pacman/pkg`, `/var/cache/apt/archives`,
    `/var/cache/dnf`, `/var/cache/libdnf5`, `/var/cache/zypp`): when readable
    by the current user (typical on Arch/Debian/Fedora!), probe their sizes on
    `home` or `volume` scope and report them as `actionability: "owner_tool"`
    with the copyable `sudo` command (`sudo paccache -r`, `sudo apt clean`,
    `sudo dnf clean all`). Never execute `sudo`.
- **Trash (FreeDesktop Trash Specification 1.0):**
  - Primary user Trash: `$XDG_DATA_HOME/Trash` (default `~/.local/share/Trash`),
    counting both `files/` and `info/*.trashinfo` (plus `expunged/` if present).
  - External mount Trash: `<mount>/.Trash-$UID` when on the targeted volume.
  - Reading `.trashinfo` files (bounded to 4 KiB each, sampled up to 1,000 for
    date range) provides oldest/newest `DeletionDate` for the Trash review
    modal.
- **Btrfs / ZFS subvolumes:**
  On Linux, btrfs subvolumes get distinct synthetic `st_dev` numbers even
  though they share the same physical filesystem. Parse `/proc/self/mountinfo`
  once (reusing `mount-boundary.ts` / Rust equivalent, capped at 1 MiB) to
  distinguish true foreign mounts (NFS, tmpfs, FUSE, USB drives — skip) from
  same-source btrfs subvolumes mounted under `$HOME`.

### 3.4 Windows specifics

- **Known Folders (Win32 API, no hardcoded English names):**
  Query `SHGetKnownFolderPath` via `windows-sys` (already a workspace
  dependency of `sweep-fs`) for:
  - `FOLDERID_Pictures` → `photos`
  - `FOLDERID_Videos` → `videos`
  - `FOLDERID_Music` → `music`
  - `FOLDERID_Documents`, `FOLDERID_Desktop` → `documents`
  - `FOLDERID_Downloads` → `downloads`
  - `FOLDERID_LocalAppData`, `FOLDERID_RoamingAppData` → route allowlisted
    cache subdirs to `caches`, dev toolchains to `developer`, remaining app
    folders (`Programs`, `Packages`, app data) to `apps`.
  - `FOLDERID_ProgramFiles`, `FOLDERID_ProgramFilesX86`, `FOLDERID_ProgramData`
    → `apps` (on volume scope, or probed read-only on `C:` home scope).
    Note: `SHGetKnownFolderPath` automatically respects localized Windows installs
    and redirected folders (e.g. `D:\Pictures` or OneDrive-backed Documents).
    If a Known Folder lives on a different volume than the scan root, record its
    bytes separately without breaking same-volume `System data` math!
- **Recycle Bin:**
  - Read-only measurement via `SHQueryRecycleBinW(rootPath, &info)` — returns
    exact `i64Size` and `i64NumItems` in <5 ms without needing admin
    privileges or traversing `$Recycle.Bin` ACLs.
  - Emptying (Phase 6, separate confirmation) uses `SHEmptyRecycleBinW` with
    `SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND` **only after**
    Sweep's own committed confirmation dialog.
- **NTFS cloud placeholders, compression, sparse files, and junctions:**
  - Junctions and symlinks (`FILE_ATTRIBUTE_REPARSE_POINT`) are never
    traversed (existing `meta_is_reparse_point` in `sweep-fs`).
  - OneDrive Files On-Demand placeholders
    (`FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` `0x00400000` or
    `FILE_ATTRIBUTE_RECALL_ON_OPEN` `0x00040000` or `FILE_ATTRIBUTE_OFFLINE`
    `0x00001000`): **never open file contents** (would trigger cloud download!).
    Read allocated size via `GetCompressedFileSizeW` /
    `GetFileInformationByHandleEx(FileStandardInfo)` (`AllocationSize` = 0
    for cloud-only files).
  - Volume free/used space via `GetDiskFreeSpaceExW`.

### 3.5 Extension table and bounded MIME fallback

| Category    | Representative lowercase ASCII extensions (compiled `phf` / static match)                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `photos`    | `jpg`, `jpeg`, `png`, `gif`, `webp`, `heic`, `heif`, `avif`, `bmp`, `tif`, `tiff`, `raw`, `cr2`, `cr3`, `nef`, `arw`, `orf`, `rw2`, `dng`, `psd`, `psb`, `xcf`, `svg`, `ico`, `jxl`    |
| `videos`    | `mp4`, `m4v`, `mov`, `mkv`, `avi`, `webm`, `wmv`, `flv`, `mpg`, `mpeg`, `ts`, `mts`, `m2ts`, `vob`, `ogv`, `3gp`, `mxf`, `r3d`, `braw`, `prores`                                       |
| `music`     | `mp3`, `flac`, `wav`, `aif`, `aiff`, `aac`, `m4a`, `ogg`, `opus`, `wma`, `alac`, `ape`, `wv`, `dsf`, `dff`, `mid`, `midi`                                                              |
| `documents` | `pdf`, `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, `odt`, `ods`, `odp`, `rtf`, `txt`, `md`, `markdown`, `csv`, `tsv`, `epub`, `mobi`, `azw3`, `pages`, `numbers`, `key`, `tex`, `org` |

**MIME magic-byte fallback (strictly bounded):**

- Triggered **only** for extensionless regular files with `allocatedBytes >= 1 MiB`
  outside known folders, and **never** for cloud placeholders / dataless files /
  FIFOs / devices.
- Opens with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, reads at most **512 bytes**,
  and matches fixed magic signatures (JPEG `FF D8 FF`, PNG `89 50 4E 47`,
  MP4/MOV `ftyp`, Matroska `1A 45 DF A3`, PDF `%PDF-`, FLAC `fLaC`, MP3
  `ID3`/`FF FB`, Ogg `OggS`, RIFF WAV/AVI, ZIP/Office `PK\x03\x04`).
- Hard scan cap: **at most 1,000 MIME probes per scan** (prevents random-read
  storms on millions of extensionless cache blobs; anything beyond the cap
  classifies directly as `other`).

### 3.6 Byte accounting: allocated vs apparent, hardlinks, clones, sparse files

| Phenomenon                                          | How `sweep space` handles it                                                                                                                                                                                                                                                                                                                       | Displayed & JSON semantics                                                                                                                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Allocated vs apparent**                           | **Allocated bytes lead** (`meta.blocks() * 512` on Unix; `AllocationSize` / `GetCompressedFileSizeW` on Windows). Apparent bytes (`meta.len()`) are always accumulated in parallel.                                                                                                                                                                | Primary bar & headline use `allocatedBytes` (reconciles with `statvfs` used space). JSON carries both `allocatedBytes` and `apparentBytes`; `--metric apparent` switches CLI display.                 |
| **Sparse files**                                    | Allocated blocks report only physically written extents (e.g. a 10 GiB sparse VM image with 0 allocated blocks reports `0 B` allocated, `10.0 GiB` apparent).                                                                                                                                                                                      | Prevents phantom "10 GiB used" alarms. Subgroup detail shows `0 B on disk (10.0 GiB logical)` when `apparent > allocated * 2` and `apparent >= 64 MiB`.                                               |
| **Small-file block overhead**                       | `st_blocks * 512` captures 4 KiB cluster rounding (e.g. 1M × 128 B files = ~4.0 GiB on ext4, not 128 MiB).                                                                                                                                                                                                                                         | Matches true volume consumption so `System data` is not inflated by 3.9 GiB of phantom "unaccounted" space!                                                                                           |
| **Hardlinks (`nlink > 1`)**                         | Global bounded `(dev, ino)` dedup set across the space walk. First category in priority order owns the inode; subsequent links add `0` bytes and increment `coverage.hardlinkDedupedInodes`. If `maxDedupIdentities` is hit, remaining links are counted (upper bound) and `hardlinkDedupCapHit = true`, `bytesKnown = false` — scan never aborts. | Eliminates pnpm/Bun store and Time Machine hardlink double-counting without blowing RAM.                                                                                                              |
| **CoW clones / reflinks (APFS, Btrfs, XFS, ReFS)**  | Cloned files have distinct inodes and each reports full `st_blocks`. User-space extent dedupe requires root or expensive `FIEMAP` ioctls per file, so Sweep does **not** claim exact CoW dedupe.                                                                                                                                                   | If `sum(classifiedAllocatedBytes) > volume.usedBytes`, `system_data` clamps at `0`, `partialReasons` includes `clone_or_compression_overlap`, and the UI adds a `~` qualifier with a one-line caveat. |
| **Filesystem compression (APFS, Btrfs, ZFS, NTFS)** | `st_blocks * 512` / `GetCompressedFileSizeW` natively reports compressed on-disk bytes!                                                                                                                                                                                                                                                            | Reconciles accurately with volume `usedBytes`.                                                                                                                                                        |

### 3.7 Computing "System data" honestly

`System data` is notoriously opaque in OS storage dialogs. Sweep makes the
formula completely transparent and refuses to fabricate it when the denominator
doesn't match:

- **On `scope === "volume"` or `scope === "home"` (same `st_dev` as volume):**
  ```text
  classified_same_dev = sum(cat.allocatedBytes for cat != "system_data" on volume_dev)
  raw_residual        = volume.usedBytes - classified_same_dev
  system_data.allocatedBytes = max(0, raw_residual)
  ```
  - On `scope === "home"`, Sweep also performs a cheap, bounded, read-only top-
    level probe of standard OS-shared app/cache locations on the same volume
    (macOS `/Applications`; Linux `/var/lib/flatpak`, `/var/lib/snapd/snaps`,
    `/var/cache/{pacman,apt,dnf}`; Windows `Program Files`, `ProgramData`) so
    installed apps aren't misattributed to `System data`. Everything else
    outside `~` (OS binaries, `/System`, `/usr`, `/var/log`, other user
    accounts, APFS snapshots, filesystem journal/inode tables, and any
    `permissionDeniedDirs`) lands honestly in `system_data`.
  - Its one-line insight names what is actually inside the residual, e.g.:
    - `"OS files, other accounts, and filesystem metadata (volume used minus classified)."`
    - When `permissionDeniedDirs > 0`: `"Includes N protected folders Sweep could not read."`
    - When `snapshotCount > 0` (macOS): `"Includes N local APFS snapshots that hold freed blocks."`
    - When `raw_residual < 0`: `"0 B · Cloned or compressed files overlap on disk; totals are upper bounds."`
- **On `scope === "path"` (a subtree like `~/Projects` or `/mnt/data/media`):**
  `system_data` is reported as `allocatedBytes: 0, apparentBytes: 0, fileCount: 0, bytesKnown: true`,
  insight `"Not computed for a single folder — run 'sweep space' on ~ or a volume."`,
  and **omitted from the bar and legend**. Never subtract a single subfolder
  from whole-disk `usedBytes`.

---

## 4. Performance budget and empirical measurements

### 4.1 Empirical measurements on the current Rust engine

Built `target/release/sweep-engine` (1.4 MiB stripped LTO binary) in this
worktree at commit `a5a1c41` (`cargo build --release -p sweep-engine-cli`,
21.97 s build) and measured read-only walks over synthetic home-shaped corpora
generated under `mktemp -d` on **tmpfs** (`/tmp`, 634k free inodes) and **NVMe
ext4** (`/var/tmp`, `/dev/nvme1n1p6`). The owner's real home directory was
never touched. All temporary corpora were removed immediately after measurement.

- **Hardware:** 13th Gen Intel Core i5-13450HX (16 logical CPUs), 23 GiB RAM,
  Linux ext4 on NVMe (`/dev/nvme1n1p6`) and `tmpfs` (`/tmp`).
- **Corpora:**
  - **tmpfs (`250k`):** 250,000 small 128 B files across 2,500 dirs (10 top-level
    category buckets) + 10 × 10 MiB allocated files + 5 × 1 GiB sparse files +
    1,000 hardlinks to one 64 KiB blob + `Projects/demo-app/node_modules` &
    `Projects/demo-crate/target` = **251,216 files, 2,516 dirs**.
  - **NVMe ext4 (`1M`):** 1,000,000 small 128 B files across 10,000 dirs (10
    category buckets) + 20 × 10 MiB allocated files (200 MiB) + 10 × 1 GiB
    sparse files (10 GiB apparent, 0 allocated) + 1,000 hardlinks (64 KiB
    deduped) + `demo-app/node_modules` & `demo-crate/target` = **1,001,231
    files, 10,016 dirs**.
  - **Directory-budget boundary (`55k dirs` on tmpfs):** 100 × 550 = 55,101
    directories to probe `low-memory` vs `balanced` queue/directory limits.
- **Modes measured:**
  - _Discovery walk_ (`default` patterns): `sweep-fs::walk_matched_entries_with_budget`
    (`read_dir` + `d_type`, sizing only matched artifacts).
  - _Full per-file metadata walk_ (10 top-level category patterns so
    `sweep-fs::size_directories` `lstat`s every file in parallel across the
    8-thread Rayon pool with hardlink dedupe — the exact syscall cost of
    `sweep space`).

| Scenario                  | Corpus & FS                       | Profile / Mode                 |   Run 1 wall | Median wall (3 runs) |   Min–Max wall |             Throughput (median) |     Peak RSS |  User / Sys CPU |                    Exit |
| ------------------------- | --------------------------------- | ------------------------------ | -----------: | -------------------: | -------------: | ------------------------------: | -----------: | --------------: | ----------------------: |
| `tmpfs_250k_discovery`    | 251k files, 2.5k dirs (tmpfs)     | `balanced`, default patterns   |      35.3 ms |          **27.0 ms** |   22.9–35.3 ms |                      93k dirs/s |     3.48 MiB | 0.02 s / 0.09 s |                       0 |
| `tmpfs_250k_full_meta`    | 251k files, 2.5k dirs (tmpfs)     | `balanced`, stat every file    |      63.2 ms |          **59.0 ms** |   43.2–63.2 ms |               **4.26M files/s** |     3.55 MiB | 0.04 s / 0.24 s |                       0 |
| `tmpfs_250k_stream`       | 251k files, 2.5k dirs (tmpfs)     | `balanced`, `--json-stream`    |      46.2 ms |          **46.2 ms** |   44.9–61.3 ms |           1st event **1.41 ms** |     3.76 MiB | 0.04 s / 0.24 s |                       0 |
| `tmpfs_250k_lowmem`       | 251k files, 2.5k dirs (tmpfs)     | `low-memory`, stat every file  |      89.4 ms |          **53.9 ms** |   44.9–89.4 ms |                   4.66M files/s |     3.60 MiB | 0.03 s / 0.22 s |                       0 |
| `disk_1M_discovery`       | 1.00M files, 10k dirs (NVMe ext4) | `balanced`, default patterns   |     139.3 ms |         **149.3 ms** | 139.3–201.2 ms |                      67k dirs/s |     4.71 MiB | 0.16 s / 0.31 s |                       0 |
| `disk_1M_full_meta`       | 1.00M files, 10k dirs (NVMe ext4) | `balanced`, stat every file    | **995.7 ms** |         **220.7 ms** | 178.0–995.7 ms | **4.54M files/s** (1.01M run 1) | **4.03 MiB** | 0.20 s / 1.21 s |                       0 |
| `disk_1M_stream`          | 1.00M files, 10k dirs (NVMe ext4) | `balanced`, `--json-stream`    |     184.8 ms |         **184.8 ms** | 183.6–205.9 ms |           1st event **1.96 ms** |     4.21 MiB | 0.16 s / 1.14 s |                       0 |
| `disk_1M_lowmem`          | 1.00M files, 10k dirs (NVMe ext4) | `low-memory`, stat every file  |     212.9 ms |         **212.9 ms** | 176.6–225.3 ms |                   4.70M files/s | **4.21 MiB** | 0.19 s / 1.24 s |                       0 |
| `tmpfs_55k_dirs_lowmem`   | 55,101 dirs (tmpfs)               | `low-memory` (2,048 queue cap) |       8.4 ms |           **8.4 ms** |              — |                      fails fast |     3.61 MiB | 0.00 s / 0.00 s | **2** (`maxQueuedDirs`) |
| `tmpfs_55k_dirs_balanced` | 55,101 dirs (tmpfs)               | `balanced` (32,768 queue cap)  |      72.9 ms |          **83.8 ms** |  72.9–110.0 ms |                     657k dirs/s |     5.73 MiB | 0.09 s / 0.23 s |                       0 |

#### Three concrete engineering findings from these measurements

1. **Speed and RSS headroom are extraordinary.** Statting **1,001,231 files** on
   NVMe ext4 took **995.7 ms** immediately after creation (metadata cold-ish)
   and **220.7 ms** warm, at **4.03 MiB peak RSS** — with first streaming event
   arriving in **1.96 ms**. Extrapolating conservatively to a 5M-file home
   directory on SSD gives ~1.1 s warm / ~5–12 s cold (depending on SSD random
   inode IOPS) while staying well under 16 MiB Rust RSS.
2. **The existing `ScanLimits` cumulative directory cap (`maxDirectories = 250,000`)
   and `low-memory` queue cap (`maxQueuedDirs = 2,048`) will trip on real
   home directories.** The `55k_dirs` probe hit `maxQueuedDirs` in 8.4 ms under
   `low-memory` (exit 2). Real developer home directories frequently exceed
   300,000 directories across `~/.cache`, `node_modules`, `.cargo`, and
   `~/Library`. Therefore `sweep space` **must use live queue bounds** (LIFO
   depth-first traversal releases each directory frame immediately after
   reading it, so peak live queue is O(depth × branching), never cumulative
   total directories!) and **non-fatal dedup degradation** (if `maxDedupIdentities`
   is reached, mark `hardlinkDedupCapHit: true` instead of aborting exit 2).
3. **Byte reconciliation empirically proves why allocated bytes must lead.**
   On the 1M-file ext4 corpus, `sweep-engine`'s apparent mode reported
   `11,079,435,304 B` (**10.32 GiB**): `128 MB` for 1M × 128 B files +
   `209.7 MB` for 20 × 10 MiB videos + `10.74 GB` for 10 × 1 GiB sparse images +
   `65,536 B` for 1,000 hardlinks (deduped correctly to 1!) + `4.24 MB` for
   developer artifacts. On disk, those 10 sparse images occupy **0 B** while
   the 1M × 128 B files occupy **~4.0 GiB** of 4 KiB blocks. Reporting apparent
   bytes in a whole-disk breakdown would be off by **>6 GiB** on this single
   synthetic fixture alone.

### 4.2 Target performance & memory budgets

| Metric                                     | `balanced` target                | `low-memory` target               | Enforcement                                               |
| ------------------------------------------ | -------------------------------- | --------------------------------- | --------------------------------------------------------- |
| Cached instant paint (L4 hit)              | **< 50 ms**                      | **< 50 ms**                       | Private `space-cache.json` read before spawn              |
| Time to first live event (`space_started`) | **< 20 ms**                      | **< 20 ms**                       | Emit immediately after root `statvfs`                     |
| Live progress heartbeat                    | Every **80 ms** or **16k files** | Every **120 ms** or **16k files** | Coalesced atomic snapshot, zero pipe flood                |
| 1M-file NVMe walk (warm / cold)            | **< 500 ms / < 2.5 s**           | **< 1.0 s / < 4.0 s**             | 8 workers (`balanced`) / 2–4 workers (`low-memory`)       |
| 5M-file home walk (warm / cold SSD)        | **< 5 s / < 20 s**               | **< 10 s / < 30 s**               | Single-pass LIFO walk, zero per-file path alloc           |
| Peak Rust engine RSS                       | **< 32 MiB**                     | **< 16 MiB**                      | Live queue + bounded dedup + fixed 11-bucket accumulators |
| Cancellation settle (`SIGINT` / `Esc`)     | **< 100 ms**                     | **< 100 ms**                      | `AtomicBool` checked every dir & every 256 dirents        |

#### Dedicated `SpaceLimits` (separate from discovery `ScanLimits`)

| Resource                                               |                 `balanced` |       `low-memory` | On cap reached                                                                   |
| ------------------------------------------------------ | -------------------------: | -----------------: | -------------------------------------------------------------------------------- |
| Live queued directories (`maxQueuedDirs`)              |                     65,536 |              4,096 | Skip further queueing of deepest siblings, mark `queue_cap` (`complete: false`)  |
| Live queued path bytes (`maxQueuedPathBytes`)          |                     16 MiB |              4 MiB | Same non-fatal `queue_cap` degradation                                           |
| Hardlink + dir dedup identities (`maxDedupIdentities`) |          500,000 (~12 MiB) |  65,536 (~1.6 MiB) | Count remaining multi-link files as upper bound; set `hardlinkDedupCapHit: true` |
| Max dirents per single directory (`MAX_DIR_ENTRIES`)   |                  4,000,000 |          4,000,000 | Stop reading runaway FUSE/NFS dir; mark dir skipped                              |
| Top-K heavy subgroups per category                     | 64 (trimmed to 16 on wire) | 32 (trimmed to 16) | Evict smallest subgroup                                                          |
| MIME magic probes per scan                             |                      1,000 |                250 | Remaining extensionless files go to `other`                                      |

### 4.3 Streaming, cancellation, and L4 cached instant start

- **Streaming partial results:** The Rust walker updates lock-free per-worker
  category counters and merges them into an atomic snapshot every 80 ms,
  emitting `space_progress` with live category totals and the active
  `currentDir`. The TUI animates the dithered bar growing left-to-right and
  counts up the headline total while the walk runs; the instant
  `space_completed` lands, motion stops completely (matching Clove's principle
  and `.docs/ux-principles.md`).
- **Cancellation:** `Ctrl-C` (CLI) or `Esc`/`q` (TUI) closes/signals the
  cancellation channel (`AtomicBool`). Workers bail at the next 256-entry
  boundary (typically <5 ms), flush no partial cache, and exit cleanly.
- **L4 Cached instant start (`<configDir>/space-cache.json`):**
  - Stored alongside `size-cache.json` in `sweepConfigDir()` (`0600` POSIX /
    user ACL Windows, `O_NOFOLLOW | O_NONBLOCK`, 4 MiB hard ceiling, atomic
    write-temp-fsync-rename, verifying parent dir ownership — fixing audit
    finding F09's `O_NONBLOCK` gap from day one!).
  - Keyed by `(canonicalTargetHash, device, inode, scope, platform)`.
  - Stores **only** the last completed `SpaceReport` with `cached: true` and
    **zero personal file paths** (Section 5).
  - On launch, `sweep ui --view space` (and `sweep space` unless `--no-cache`)
    loads the cache in <5 ms and renders it immediately with a prominent
    staleness indicator (`Cached 3h ago · scanning fresh…`). **Action buttons
    remain disabled or clearly marked stale until the live scan settles**
    (per L4: "never applicable until rescanned").

---

## 5. Privacy and shareable output

1. **Zero network, zero telemetry:** `sweep space` performs strictly local
   filesystem and OS API reads. No data, hashes, sizes, or diagnostics ever
   leave the machine.
2. **No personal paths in history or cache by default:**
   - `sweep space` never writes to `history.jsonl` (only confirmed destructive
     applies append cleanup receipts).
   - `space-cache.json` stores only category byte/file totals, volume stats,
     and safe top-level subgroup labels (`Developer` project basenames,
     allowlisted cache IDs, `"Trash"`). Individual filenames inside `Photos`,
     `Videos`, `Music`, `Documents`, `Downloads`, or `Other` are **never**
     persisted to disk.
3. **Shareable redacted output (`--redact`):**
   Extends [docs/users/privacy.md](../docs/users/privacy.md) directly:
   - Replaces `$HOME` and username segments with `<home>`, volume mountpoints
     with `<volume-1>`, and non-allowlisted subgroup paths with deterministic
     placeholders (`<project-1>`, `<folder-1>`).
   - Preserves allowlisted cache names (e.g. `Homebrew cache`, `npm cache`),
     category names, byte/file totals, coverage flags, OS/architecture, and
     elapsed time so users can paste `sweep space --json --redact` directly
     into GitHub issues or team discussions without leaking private folder
     names or usernames.
4. **Terminal escape safety:** Every `currentDir` progress string and subgroup
   label passes through `sanitizeTerminalText` (`packages/protocol`) and
   `terminal_safe` (`sweep-engine-cli`) before reaching any terminal.

---

## 6. UI specification (Terminal 80 / 100 / 120 columns & Website)

### 6.1 Visual identity and 11-category palette

Preserves Sweep's warm olive-black canvas (`#0b0d08` dark / `#f7f6f0` paper
light) and chartreuse signal (`#cdf450` dark / `#4a6a12` light) from
[packages/ui/src/theme.ts](../packages/ui/src/theme.ts) and
[apps/docs/src/theme.css](../apps/docs/src/theme.css). Every text token meets
WCAG AA 4.5:1 on canvas and focused rows; bar segments meet 3:1 non-text
contrast against `meterTrack`; `NO_COLOR` differentiates every category using
distinct Braille dot densities and explicit text labels.

| Category      | Dark hex  | Light hex | Role / hue family            | `NO_COLOR` bar glyph | Action badge     |
| ------------- | --------- | --------- | ---------------------------- | -------------------- | ---------------- |
| `developer`   | `#cdf450` | `#4a6a12` | Chartreuse (Sweep signal)    | `⣿` (full 8-dot)     | Reviewable       |
| `caches`      | `#6ee7b7` | `#0f766e` | Mint (comes back on its own) | `⣶` (6-dot)          | Allowlist review |
| `trash`       | `#f47f69` | `#b0372c` | Coral-red (already deleted)  | `⣤` (4-dot)          | Separate confirm |
| `apps`        | `#7eb6d9` | `#2f5f82` | Slate blue                   | `⣾` (7-dot)          | Info only        |
| `photos`      | `#e2b552` | `#8a5f08` | Warm amber                   | `⣴` (5-dot)          | Info only        |
| `videos`      | `#d896ff` | `#7c3aed` | Soft violet                  | `⣦` (5-dot)          | Info only        |
| `music`       | `#f29cb8` | `#be185d` | Rose                         | `⠒` (2-dot)          | Info only        |
| `documents`   | `#a2b4ca` | `#475569` | Cool steel                   | `⠤` (2-dot)          | Info only        |
| `downloads`   | `#f5a962` | `#c2410c` | Terracotta                   | `⠶` (4-dot)          | Info only        |
| `system_data` | `#6f7366` | `#666b59` | Muted olive-gray             | `⣀` (bottom 2-dot)   | Info only        |
| `other`       | `#4c5145` | `#9ca3af` | Deep olive-gray              | `⠂` (1-dot)          | Info only        |

### 6.2 Dithered dot-matrix segmented bar (`StackBar` v2)

Shared pure segmentation engine in `packages/ui/src/dot-matrix.ts` +
`packages/ui/src/meter-draw.ts`:

- **Kitty graphics protocol:** 1-row (or 2-row at height ≥ 28) RGBA capsule
  drawn as a `2×2` pixel dot grid (1 px dot spacing, ordered Bayer dither fade
  across the trailing 4 px of each segment, 2 px ground seam between adjacent
  categories). Non-focused categories dim to `0.32` brightness when a category
  is focused in the legend.
- **Non-Kitty cell fallback:** Unicode Braille cells (`⣿`/`⣶`/`⣤`/`⣀` in
  `NO_COLOR`, colored `⣿` with `⣶` trailing dither cell in color terminals,
  dimmed segments drop to `⠤` in `textDim`), enforcing `min 1 cell` per
  non-zero category whenever `activeCategories <= width` (reusing
  `allocateBarCells` from `packages/ui/src/insights.ts`).
- **Motion discipline (`.docs/ux-principles.md`):**
  - While scanning: bar fills left-to-right with live category bytes; headline
    number counts up; dim mono line shows active `currentDir`.
  - Settled: **zero animation, zero timers.** Moving cursor across categories
    dims non-focused segments instantaneously (0 ms).
  - After a confirmed apply/empty: receipt replaces the subtitle
    (`✓ Freed ~14.2 GiB · disk +13.8 GiB · 168.0 GiB available`), and under
    motion enabled (not `SWEEP_REDUCED_MOTION`), cleared dots extinguish from
    the right edge driven strictly by real engine outcome events.

### 6.3 Terminal UI layouts (80 / 100 / 120 columns)

All widths enforce whole-part shedding (never mid-word clipping) and keep
confirmation strictly separate from browsing.

#### 120 columns × 30 rows (Storage card + right detail margin)

```text
◆ sweep  ~ (home · NVMe 512 GiB)                                                         154.2 GiB free · +28.4 GiB purgeable

357.8 GiB of 512 GiB used                                                                ✓ Scanned 1.4M files in 0.9s
Developer 48.2 GiB · 5 finished worktrees (3.5 GiB) and 26 idle projects (14.2 GiB).
⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⣶⣶⣶⣶⣶⣶⣶⡇⠀⣤⣤⡇⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀

● Apps           58.4 GiB    › ● Developer     48.2 GiB      ● Photos         44.1 GiB   │  Developer · 48.2 GiB
● Videos         39.0 GiB      ● Music         11.2 GiB      ● Documents      14.8 GiB   │  Projects & toolchains
● Downloads      18.6 GiB      ● Caches        34.2 GiB      ● Trash          19.4 GiB   │
● System data    56.5 GiB      ● Other         13.4 GiB                                  │  ┌─ Breakdown ─────────────────────┐
                                                                                         │  │ Project artifacts      31.4 GiB │
─────────────────────────────────────────────────────────────────────────────────────────│  │ Reinstalls / rebuilds  [Review] │
Caches are using 34.2 GiB. Apps rebuild them when they need them.   [ Review Caches ↵ ]  │  │ Xcode DerivedData       9.8 GiB │
                                                                                         │  │ Comes back on its own           │
                                                                                         │  │ Cargo & Bun stores      4.6 GiB │
                                                                                         │  │ Check first · owner tool        │
                                                                                         │  │ Source & git history    2.4 GiB │
                                                                                         │  │ Information only                │
                                                                                         │  └─────────────────────────────────┘
 ↑↓←→ category   enter review/details   r rescan   w projects   ? keys   q quit
```

_(Moving cursor onto `Photos` immediately dims every other bar segment, swaps
the insight line to `"Photos 44.1 GiB · Information only — Sweep never queues
or removes personal files."`, and renders the read-only folder breakdown in the
right margin with zero action buttons.)_

#### 100 columns × 28 rows (Full storage card, single column, 3-col legend)

```text
◆ sweep  ~ (home)                                                                   154.2 GiB free

357.8 GiB of 512 GiB used                                                           1.4M files · 0.9s
Developer 48.2 GiB · 5 finished worktrees (3.5 GiB) and 26 idle projects (14.2 GiB).
⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⣶⣶⣶⣶⣶⡇⠀⣤⣤⡇⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⣿⣿⣿⣿⣿⣿⣿⡇⠀⣿⣿⣿⣿⣿⣿⣿⡇⠀⣀⣀⣀⣀⣀⣀⣀

● Apps          58.4 GiB     › ● Developer    48.2 GiB       ● Photos        44.1 GiB
● Videos        39.0 GiB       ● Music        11.2 GiB       ● Documents     14.8 GiB
● Downloads     18.6 GiB       ● Caches       34.2 GiB       ● Trash         19.4 GiB
● System data   56.5 GiB       ● Other        13.4 GiB

  Top in Developer:
    Project build artifacts (112 projects)           31.4 GiB   Reinstalls / rebuilds   [Review]
    Xcode DerivedData                                 9.8 GiB   Comes back on its own   [Review]
    Cargo & Bun toolchains                            4.6 GiB   Check first · owner tool

──────────────────────────────────────────────────────────────────────────────────────────────────
Caches are using 34.2 GiB. Apps rebuild them when they need them.             [ Review Caches ↵ ]

 ↑↓←→ category   enter review/details   r rescan   w projects   ? keys   q quit
```

#### 80 columns × 24 rows (Compact storage card, 2-col legend, zero clipping)

```text
◆ sweep  ~                                                        154.2 GiB free

357.8 GiB of 512 GiB used                                         1.4M files
Developer 48.2 GiB · 5 finished worktrees (3.5 GiB), 26 idle (14.2 GiB).
⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⣶⣶⣶⡇⠀⣤⡇⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⣿⣿⣿⣿⣿⣿⡇⠀⣿⣿⣿⣿⣿⣿⡇⠀⣀⣀⣀⣀

● Apps            58.4 GiB       › ● Developer       48.2 GiB
● Photos          44.1 GiB         ● Videos          39.0 GiB
● Music           11.2 GiB         ● Documents       14.8 GiB
● Downloads       18.6 GiB         ● Caches          34.2 GiB
● Trash           19.4 GiB         ● System data     56.5 GiB
● Other           13.4 GiB

────────────────────────────────────────────────────────────────────────────────
Caches: 34.2 GiB (rebuild automatically).                    [ Review Caches ↵ ]
 ↑↓ category   enter review   r rescan   w projects   ? keys   q quit
```

#### Short terminal (`height < 20` rows) & narrow fallback (`width < 60`)

- Below 20 rows: drop the inline "Top in \<Category\>" list first (keep
  headline, bar, compact legend, footer recommendation + button, and hints).
  `Enter` or `i` opens the scrollable detail overlay (clamped to viewport per
  UX Principle 9).
- Below 40 cols or 12 rows: disable destructive confirmation dialogs until the
  terminal fits (preserving UX Principle 6).

#### Footer recommendation progression (one sentence + one action)

1. Largest actionable category first (tie-break: `caches` `"Comes back on its
   own"` → `developer` idle/finished → `trash`):
   - `"Caches are using 34.2 GiB. Apps rebuild them when they need them."`
     `[ Review Caches ↵ ]`
   - `"Developer artifacts hold 31.4 GiB across 112 projects (14.2 GiB idle 30+ days)."`
     `[ Review Developer ↵ ]`
   - `"The Trash is holding 19.4 GiB of things you've already deleted."`
     `[ Review Trash ↵ ]`
2. Every button opens a **Review / Confirmation** surface — never deletes on
   click or single `Enter`.
3. Once nothing actionable exceeds 100 MiB (or user cleared all three):
   - `"Nothing else is worth clearing right now."` (no action button).

### 6.4 Website specification (`apps/docs`)

Adds a prerendered, interactive **Space Storage Card** section on the landing
page (`apps/docs/src/components/landing/`) and a dedicated
`docs/users/space.md` guide, using Sweep's existing CSS tokens
([apps/docs/src/theme.css](../apps/docs/src/theme.css)):

- **Card container:**
  - Dark surface: `oklch(18.5% 0.013 128)` (`--color-fd-popover`), light
    surface: `oklch(95.6% 0.008 100)` (`--color-fd-card`), `border-radius: 20px`,
    layered inset hairline highlight (`inset 0 1px 0 oklch(100% 0 none / 0.09),
    inset 0 0 0 1px oklch(100% 0 none / 0.06)`) + soft ambient shadow.
  - Sunken inner breakdown canvas (`oklch(13% 0.01 128)` dark /
    `oklch(92.5% 0.008 100)` light) with subtle `16px × 16px` radial dot grid
    (`radial-gradient(circle, var(--canvas-dot) 1px, transparent 1.2px)`) kept
    strictly out of body text.
- **Anatomy:**
  1. **Header:** Big `tabular-nums` display total (`357.8 GiB` + dim
     `of 512 GiB used`) and dim right-aligned `154.2 GiB available`.
  2. **Insight line:** Single dynamic sentence beneath the total, updating on
     legend hover or keyboard focus (`aria-live="polite"`).
  3. **Dithered dot-matrix bar:** `<canvas>` or CSS dot-grid bar (2 px dots on
     4 px pitch) with `aria-hidden="true"` (all exact category amounts live in
     DOM text in the legend). Hovering or focusing a legend button dims other
     segments to `opacity: 0.28` with 0 ms delay for keyboard focus and instant
     settlement under `prefers-reduced-motion: reduce`.
  4. **Responsive legend grid:** 3 columns (`>= 720px`) → 2 columns
     (`440px–719px`) → 1 column (`< 440px`, verified at 320 CSS px and 200%
     zoom). Each legend item is a focusable `<button>` showing colored dot,
     category name, and right-aligned `tabular-nums` size.
  5. **Honest status rows & single CTA footer:** Focused category shows its
     subgroups with plain-language text badges (`Information only`, `Comes back
     on its own`, `Check first`, `Already deleted`) alongside color. Footer
     carries one recommendation sentence and one CTA button (`Review Caches` /
     `Review Developer`) that opens the existing interactive review modal
     (restoring focus cleanly on close, fixing audit A08).
- **Single typed data fixture (audit A15):** Every headline total, free-space
  number, bar share, legend size, and projected post-review receipt is derived
  mathematically from one typed fixture object in `content.ts`, verified by a
  unit test so displayed arithmetic can never drift.
- **Binary units (`GiB`/`MiB`) everywhere** to match the real CLI.

---

## 7. Phased implementation plan, tests, and open questions

Follows `.plans/remaining-work.md` Working Rules (reproduce/fixture first,
destructive authority in its own PR, additive versioned protocol, one PR per
gate passing `bun run check`, `bun run rust:check`, and `bun run verify`).

### 7.1 PR-sized implementation phases

| Phase       | PR scope                                       | Deliverables                                                                                                                                                                                                                                                                                                                                                                                                                 | Destructive authority change?                 |
| ----------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Phase 0** | Safety prereqs & docs                          | Fix audit **F03** (prefix-block OS roots in `assertSafeCwd`, harden `SYSTEM_TOOL_DIRS` in JS & Rust) and **F07** (Windows PATH-only executable resolution); update `.docs/product-direction.md` and `.docs/decision-log.md`.                                                                                                                                                                                                 | Tightens existing guardrails only             |
| **Phase 1** | Protocol, schemas & read-only guard            | Add `space-report.schema.json`, `space-event.schema.json`, TS types (`packages/protocol`), Rust serde types (`crates/sweep-types`), `sweep schema` exports, `assertSafeReadOnlyRoot` (JS + Rust), and personal-category/path refusal guards.                                                                                                                                                                                 | None (read-only contract)                     |
| **Phase 2** | Rust `sweep-engine space`                      | Single-pass LIFO space walker in `crates/sweep-fs`, allocated bytes (`st_blocks * 512` / `GetCompressedFileSizeW`), bounded global hardlink dedupe, volume stats (`statvfs` / `GetDiskFreeSpaceExW`), OS classifiers (Linux XDG/Flatpak/Snap/Trash, macOS `~/Library`/APFS firmlink & purgeable, Windows Known Folders/`SHQueryRecycleBinW`), NDJSON stream, cooperative cancellation, `--capabilities` `spaceReport: true`. | None (read-only)                              |
| **Phase 3** | JS engine parity, CLI `sweep space` & L4 cache | JS fallback `packages/core/src/space-scanner.ts` (using bounded `directoryEntries`), CLI `sweep space [path]` (`--json`, `--json-stream`, `--redact`, `--metric`, `--no-cache`), `packages/display` storage card renderer, private `space-cache.json` (L4), shell completions.                                                                                                                                               | None (read-only)                              |
| **Phase 4** | TUI `SpaceView` & Developer handoff            | Dithered dot-matrix `StackBar` v2 (`dot-matrix.ts`, `meter-draw.ts`, `Meter.tsx`), 11-category tokens in `theme.ts`, `SpaceView.tsx` at 80/100/120 cols + short-height fallback, `sweep ui --view space` + `w` / `Ctrl+K` switcher, read-only handoff into `ProjectsView` for `Developer`.                                                                                                                                   | None (reuses existing Developer review/apply) |
| **Phase 5** | Allowlisted cache review & clean (**own PR**)  | Compiled per-OS cache allowlist (`packages/core/src/cache-allowlist.ts` + Rust parity), running-process detector, `CacheReviewOverlay.tsx` (`Comes back on its own` / `Check first`), apply-time allowlist re-verification + identity pinning, owner-tool command runner/copy.                                                                                                                                               | **Yes — isolated PR** (Rule 5)                |
| **Phase 6** | Separate Trash review & empty (**own PR**)     | Platform Trash inspector (`~/.Trash`, FreeDesktop `Trash/info/*.trashinfo`, Windows `SHQueryRecycleBinW`), dedicated `TrashConfirmOverlay.tsx` (permanent-delete warning, never bundled with other queues), platform-bounded Trash empty (`SHEmptyRecycleBinW` on Windows, root-pinned descriptor removal on Unix).                                                                                                          | **Yes — isolated PR** (Rule 5)                |
| **Phase 7** | Website card & user docs                       | Interactive `SpaceCard` on `apps/docs` landing page (derived from typed fixture + unit tests), `docs/users/space.md`, updates to `docs/users/privacy.md`, `docs/users/safety.md`, and `docs/users/commands.md`.                                                                                                                                                                                                              | None                                          |

### 7.2 Verification and test matrix

1. **Per-category, per-OS synthetic fixtures (`packages/test-fixtures/`):**
   - **Linux:** custom `XDG_CONFIG_HOME/user-dirs.dirs` (including localized
     names and adversarial `XDG_DESKTOP_DIR="$HOME/"`), `~/.cache` with
     allowlisted + non-allowlisted dirs, `~/.local/share/Trash/{files,info}`,
     `~/.local/share/flatpak`, `~/Projects` with `node_modules` & `target`,
     `.jpg`/`.mp4`/`.flac`/`.pdf`, sparse `.img`, cross-category hardlink web,
     unreadable `chmod 000` dir, ANSI-escape filename.
   - **macOS (unit + hosted macOS CI):** `.app` bundle containing `.png`/`.wav`
     assets (must classify as `apps`, never `photos`/`music`), `*.photoslibrary`
     package, `~/Library/Caches` + `~/Library/Developer/Xcode/DerivedData`,
     `~/.Trash`, APFS firmlink dedupe & purgeable-space reporting.
   - **Windows (unit + hosted Windows CI):** mocked/real Known Folders,
     `%LOCALAPPDATA%\Temp` & browser caches, NTFS junction (must not follow),
     sparse file allocated vs apparent bytes, `SHQueryRecycleBinW` probe.
2. **Guardrail & non-queueability tests (BOTH JS and Rust engines):**
   - Prove `assertSafeCwd` still refuses `~`, `/`, `C:\`, `C:\Windows\System32`,
     `/etc/ssh`, `/System/Library` for `scan`, `clean`, `plan`, and `apply`.
   - Prove `SpaceReport` JSON is rejected by `loadPlan` / `sweep apply --plan`.
   - Prove forged cache-clean plans containing any personal path (`~/Photos`,
     `~/Documents`, `~/Downloads`, `~/Videos`, `~/Music`) or any non-allowlisted
     path under `~/.cache` / `~/Library/Caches` / `%LOCALAPPDATA%` are refused
     with `protected_path` in **both** JS and Rust engines.
   - Prove Trash empty refuses any target whose canonical identity is not the
     user's OS Trash root (including symlink-swapped `~/.Trash`).
   - Prove `sweep space --redact` strips username, `$HOME`, and personal paths
     across every JSON field and human output line.
3. **Engine parity tests:**
   - Normalized JS-vs-Rust `SpaceReport` diff on the shared synthetic fixture
     verifying identical category assignments, allocated/apparent totals,
     hardlink dedupe counts, and `system_data` math.
4. **TUI & Web qualification:**
   - PTY tests at `80×24`, `100×28`, `120×30`, `80×16`, `NO_COLOR=1`, and
     `SWEEP_REDUCED_MOTION=1` verifying zero clipping, `Esc` unwinding,
     refusal to queue `info_only` categories, and separate Trash confirmation.
   - Web tests for `SpaceCard` arithmetic derivation, keyboard focus restore,
     320 px mobile viewport, 200% zoom, and light/dark contrast.
5. **Performance regression check:**
   - Automated benchmark script over generated tmpfs/disk corpora (never real
     `~`) asserting peak RSS < 16 MiB and 250k-file tmpfs walk < 150 ms.

### 7.3 Open questions for the owner

1. **`sweep ui ~` default behavior:** When a user runs plain `sweep ui ~`
   (without `--view space`), should it:
   - _(Recommended)_ Open directly in read-only `SpaceView` (with a clear
     `"Read-only home overview"` chip and safe handoffs to `~/Projects`,
     allowlisted caches, and Trash), OR
   - Keep refusing `sweep ui ~` with the current hint and require explicit
     `sweep space` / `sweep ui --view space ~`?
2. **Developer source code vs build artifacts in `Developer`:** Inside
   `~/Projects`, should the `Developer` category include the entire project
   folder (source + `.git` as an `info_only` subgroup alongside actionable
   build artifacts, matching Clove's mental model), or count **only** build
   artifacts + toolchains (leaving source files in `Documents`/`Other`)?
   _(Recommended: include source + `.git` under `Developer` as an `info_only`
   subgroup so the user sees their true total developer footprint while only
   build artifacts enter cleanup review.)_
3. **Cache deletion vs Trash:** For Class B allowlisted caches (`"Comes back
   on its own"`), should default removal delete directly (immediately freeing
   disk space, since caches regenerate automatically) or offer Sweep's
   `--trash` toggle in the cache confirmation dialog? _(Recommended: delete
   directly as the default for allowlisted regenerable caches, with clear
   `"Comes back on its own"` explanation, since moving 30 GiB of caches into
   a local trash dir frees 0 bytes until purged.)_
4. **macOS Spotlight enrichment:** Should macOS `sweep space` stay 100%
   filesystem-walk + compiled UTI table in Phase 2 (predictable, zero
   Spotlight-daemon dependency, identical semantics across OSes), adding
   optional bounded `mdfind` screen-recording insights later, or include
   `mdfind` in Phase 2? _(Recommended: filesystem-walk + compiled UTI table in
   Phase 2; optional bounded `mdfind` insight enrichment in a follow-up.)_
5. **Cross-platform binary units:** Standardize on `GiB`/`MiB` across `sweep
   space`, TUI, and website (matching `packages/display`), or offer `--si`
   (base-10 `GB`/`MB`, matching macOS Finder / Clove) as an opt-in display
   flag? _(Recommended: `GiB`/`MiB` by default everywhere for honesty and
   consistency with existing `sweep`, with optional `--si` if users want
   macOS Finder parity.)_
