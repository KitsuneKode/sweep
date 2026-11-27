Status: planned
Scope: product, protocol, engine, core, cli, ui, docs
Created: 2026-11-27
Updated: 2026-11-27 (rev 2)
Commit: uncommitted

# Space report (`sweep space`): "Where your space goes"

Design specification for a read-only whole-home and whole-volume storage
breakdown (`sweep space` and a Space view inside `sweep ui`) that makes `sweep`
useful beyond project directories while preserving Sweep's trust-first safety
contract.

Adapted to Sweep's cross-platform CLI, TUI, and website architecture,
olive-chartreuse visual system, and explicit review-before-removal invariants
([.docs/ux-principles.md](../.docs/ux-principles.md)). Satisfies ledger item
**L3** (`sweep report`), builds on **S3** (per-item protection before reading
`~`), and integrates **L4** (cached instant start with visible staleness) from
[.plans/remaining-work.md](remaining-work.md).

---

## 1. Product shape and trust rules

### 1.1 Category taxonomy (11 mutually exclusive buckets)

Every attributed allocated byte inside a walked invoking-user root is assigned
to **exactly one** of eleven categories (zero double counting across
categories). Walked attribution, volume free/used counters, and reclaim
estimates are tracked as separate quantities (Section 3.6).

| #   | Protocol ID   | Label       | What belongs here                                                                                        | Actionability                                                 |
| --- | ------------- | ----------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | `apps`        | Apps        | Sealed app bundles (`.app`, `.framework`, Flatpak, Snap, Program Files, WindowsApps), non-cache app data | **Info only**                                                 |
| 2   | `developer`   | Developer   | Eligible project build artifacts (`node_modules`, `target`, `.next`, ...), toolchains/SDKs, project src  | **Developer review** (artifacts only) + copy-only owner hints |
| 3   | `photos`      | Photos      | Pictures folder, sealed `*.photoslibrary` packages, image formats outside projects and bundles           | **Info only**                                                 |
| 4   | `videos`      | Videos      | Movies/Videos folder, screen recordings, video formats outside projects and bundles                      | **Info only**                                                 |
| 5   | `music`       | Music       | Music folder, audio libraries, audio formats outside projects and bundles                                | **Info only**                                                 |
| 6   | `documents`   | Documents   | Documents & Desktop folders, office/PDF/book/text formats outside projects and bundles                   | **Info only**                                                 |
| 7   | `downloads`   | Downloads   | User Downloads directory (installers, archives, saved files; type-only subgroup totals)                  | **Info only**                                                 |
| 8   | `system_data` | System data | Unclassified volume usage residual when accounting domains match, plus other accounts on volume scope    | **Info only**                                                 |
| 9   | `caches`      | Caches      | Verified regenerable OS/app/package-manager cache leaves and OS cache containers                         | **Allowlisted cache review** (compiled allowlist leaves only) |
| 10  | `trash`       | Trash       | Invoking user's Trash / Recycle Bin on the walked volume(s)                                              | **Separate Trash confirm**                                    |
| 11  | `other`       | Other       | Remaining files inside the walked invoking-user root (VM images, game saves, unknown blobs)              | **Info only**                                                 |

### 1.2 Non-negotiable trust rules

1. **Personal files are strictly information-only forever.**
   `photos`, `videos`, `music`, `documents`, and `downloads` (plus `apps`,
   `system_data`, and `other`) can **never** be queued, placed into a
   `ScanPlan`, or removed by `sweep`. This is enforced at four independent
   layers:
   - **Protocol:** `SpaceReport` is a read-only document (`readOnly: true`)
     with no `selectedCandidateIds`, no actionable file paths, and no executable
     command strings. `loadPlan` and `sweep apply --plan` reject `SpaceReport`
     documents unconditionally.
   - **Core planner (JS) and Rust engine:** Both `guardrails.ts` and
     `crates/sweep-engine/src/guardrails.rs` keep `assertSafeCwd` unchanged for
     destructive commands (`scan`, `clean`, `plan`, `apply`). A separate
     read-only guard (`assertSafeReadOnlyRoot`) permits `~` and volume roots
     **only** for `sweep space`. Classification and apply-time eligibility both
     enforce the category-overlap table in Section 3.1 so the classifier and
     apply boundary always agree.
   - **TUI:** On the space overview, `Space`, `a`, `s`, `x`, and `d` do nothing.
     Attempting to select or delete an `info_only` category flashes a plain
     notice: `Personal files are info-only. Sweep never queues or removes them.`
     All destructive flows obey [.docs/ux-principles.md](../.docs/ux-principles.md)
     Section 3 (**every apply confirms**; nothing destructive is automatic) and
     Section 5 (confirmation requires a **committed dialog** for the current
     item set; elapsed time cannot arm unseen consent).
   - **Apply boundary:** `sweep-engine apply` and JS `applyPlan` only accept
     explicit `ScanPlan` (developer artifacts), `CacheCleanPlan` (compiled
     allowlist IDs re-derived and re-verified at apply time), or
     `TrashEmptyRequest` (verified user, volume identity, and confirmed item
     snapshot). A forged JSON report or plan cannot smuggle a personal path
     through any lane.

2. **Three and only three action classes exist:**
   - **Class A: Developer artifacts (existing planner, positive eligibility, no report-path handoff).**
     The report never passes serialized paths (`targetRoots` or subgroup
     `path` values) into a cleanup scan or `ScanPlan`. `spaceAction` carries
     only a fixed navigation intent (`developer_review`). When the user opens
     Developer review (`c` on Developer), the UI requires the user to choose a
     validated project root independently (from live validated project discovery
     or an explicit project path) and starts a **fresh scan** with an **empty
     queue**. All existing protections apply verbatim (`assertSafeCwd`, S1
     context checks, VCS and git-tracked file blocks, filesystem-identity
     pinning, `maxSizeGB`, and committed confirmation). In addition, because S1
     only demotes mismatches to `dangerous` (which remains manually selectable)
     and existing apply revalidation checks containment, type, and identity
     rather than generated-output eligibility, both JS and Rust engines must
     enforce a **positive artifact eligibility check** for the Space review
     handoff at review time **and** re-derive it at apply time:
     - The candidate must positively match a recognized generated-output
       artifact rule with valid project context (outside sealed bundles, tool
       homes, and system prefixes).
     - Protected personal subtrees (Pictures, Videos, Music, Documents,
       Downloads, Desktop, including redirected XDG/Known-Folder roots, plus
       sealed bundles) win against both catalog patterns and recursive ancestor
       selection. A candidate that **contains** a protected personal subtree
       (mixed subtree) or **is** a redirected personal root is never eligible.
     - If the policy cannot positively prove that the entire candidate subtree
       is eligible generated output, leave it out of the Space review.
     - Developer **toolchains** (`~/.rustup/toolchains`, `~/go/pkg/mod`, Docker
       images, Xcode Simulators) are never raw-deleted by `sweep`; they remain
       info-only with compiled copy-only owner-tool commands (e.g.
       `docker system prune`, `xcrun simctl delete unavailable`,
       `rustup toolchain list`).
   - **Class B: Verified regenerable cache leaves (compiled per-OS allowlist).**
     Only audited, verified regenerable cache leaves present in Sweep's
     compiled, versioned per-OS cache allowlist (Section 1.3) may enter cache
     review. Every other directory inside `~/.cache`, `~/Library/Caches`, or
     `%LOCALAPPDATA%` stays **info-only**. Broad general-purpose directories
     (such as Windows `%LOCALAPPDATA%\Temp`) are never bulk-selected. Each
     allowlisted entry carries:
     - a stable internal `allowlistId` (the report never passes an executable
       path or shell command),
     - a plain-language reason,
     - an explicit rebuild badge: **`Comes back on its own`** (refills silently
       on next run; eligible for `s` cache bulk-select inside Cache Review) or
       **`Check first`** (slow to re-download, clears offline store, or holds
       general-purpose temp files; never bulk-selected, requires explicit
       per-row opt-in),
     - a strict active-process check: if the owning app or any helper process
       is active, block **every** selection mode (both bulk and manual per-row
       selection) and mark the row `in use, close app first`; if process-state
       detection fails or is restricted (unknown process state), keep the row
       **display-only** (never selectable),
     - apply-time re-derivation and safety checks: right before removal, both
       engines re-derive the exact same-user target root from trusted OS
       configuration (never from report JSON), verify same-user ownership,
       verify the path is neither an ancestor nor a descendant of any personal
       root (including redirected XDG/Known-Folder roots; conflicting redirects
       or unverifiable targets stay display-only), pin the root's filesystem
       identity and volume, re-run the active-process check, require a
       cooperative lock or documented safe owner primitive where mid-removal
       app restart cannot be ruled out (aborting or skipping on `in_use`), and
       traverse strictly with no-follow, no-cross-mount handle primitives
       (`openat2` `RESOLVE_BENEATH | RESOLVE_NO_XDEV | RESOLVE_NO_SYMLINKS` on
       Linux, `openat` + `O_NOFOLLOW` on macOS, parent-handle Win32 open
       without following reparse points on Windows).
     - **Direct removal and confirmation:** Verified `"Comes back on its own"`
       cache leaves delete directly (no Trash toggle, since moving caches to
       Trash on the same volume frees 0 bytes) behind an explicit
       permanent-delete confirmation stating that bytes are removed permanently
       (not moved to Trash) and that local snapshots may still hold the blocks.
       Owner-tool commands in v1 are **copy-only** (never spawned, never run
       `sudo`). If a future revision ever executes a documented safe owner
       primitive, it must dispatch strictly from a compiled `argv` table keyed
       by `allowlistId` with direct exec (no shell), ignoring any `ownerCommand`
       string on input; `pacman`, `apt`, `dnf`, and `brew cleanup` stay
       copy-only permanently.
   - **Class C: Emptying the Trash (separate review, membership & volume bound).**
     Trash is **never** bundled into a Developer or Cache selection queue.
     Reviewing Trash opens a dedicated confirmation modal displaying item count,
     allocated bytes (`"up to N GiB"`), oldest and newest deletion dates when
     readable, the exact volume or drive name, and a notice that local
     snapshots may still hold freed blocks. The modal states clearly that
     emptying Trash is **permanent (no undo)** and requires its own committed
     confirmation (`y` after committed render, matching UX Principle 5).
     Confirmation is bound to the verified invoking user, the pinned volume
     device/GUID identity (re-statted at confirm open and again at apply,
     aborting if the device identity changed), and an explicit snapshot of
     verified Trash entries (Section 3.3 and Section 3.4).

3. **S3 guardrail prerequisite (`.plans/remaining-work.md`):**
   Before allowing read-only walks of `~` or volume roots, close the OS-root
   exact-match gap in `assertSafeCwd` and `SYSTEM_TOOL_DIRS` in both JS and
   Rust:
   - **Prefix-block** `/etc`, `/sys`, `/proc`, `/dev`, `/boot`, `/bin`,
     `/sbin`, `/lib`, `/lib64`, and `C:\Windows` (currently exact-match
     blocking lets subpaths like `/etc/ssh` and `C:\Windows\System32` pass
     `assertSafeCwd`).
   - **Keep `/var` and `/usr` exact-match only** (with existing sub-exclusions
     such as `/var/lib` and `/usr/share` in `SYSTEM_TOOL_DIRS`) so valid
     project trees under `/var/www` and `/usr/local` remain scannable.
   - Harden Windows executable discovery to resolve native tools strictly via
     trusted PATH / installation rules (never current working directory).
   - Enforce per-item positive artifact eligibility (S3 completion) in both
     engines before enabling the Space-to-Developer handoff.

### 1.3 Explicit per-OS regenerable cache allowlist

Only audited, verified cache leaves in this compiled allowlist can enter Class B
cache review. Root-owned system package caches (`pacman`, `apt`, `dnf`) and
broad owner tools (`brew cleanup`, `pnpm store prune`, `yay -Sc`/`paru -Sc`) are
**copy-only**: Sweep measures them (when readable without privilege escalation)
and displays the compiled command string for the user to run themselves, never
spawning a shell and never running `sudo`.

#### macOS allowlist

| ID                       | Canonical path template                         | Owner         | Status badge          | Reason                                                                                                         | Mechanism                                                                       |
| ------------------------ | ----------------------------------------------- | ------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `macos-xcode-derived`    | `~/Library/Developer/Xcode/DerivedData`         | Xcode         | Comes back on its own | Intermediate build outputs and indexes; Xcode rebuilds on next build                                           | Sweep bounded remove (block if `Xcode`/`xcodebuild`/`SourceKitService` running) |
| `macos-xcode-previews`   | `~/Library/Developer/Xcode/UserData/Previews`   | Xcode         | **Check first**       | SwiftUI canvas preview simulator clones; prefer owner tool                                                     | Copy-only command: `xcrun simctl --set previews delete all`                     |
| `macos-xcode-sim-caches` | `~/Library/Developer/CoreSimulator/Caches`      | CoreSimulator | Comes back on its own | Simulator dyld and runtime image caches                                                                        | Sweep bounded remove (block if `Simulator`/`CoreSimulatorService` running)      |
| `macos-homebrew-cache`   | `~/Library/Caches/Homebrew`                     | Homebrew      | Comes back on its own | Downloaded bottle tarballs only (never removes installed versions; `brew cleanup --prune=all` is not executed) | Sweep bounded remove of verified cache leaf (block if `brew` running)           |
| `macos-npm-cache`        | `~/.npm/_cacache`                               | npm           | Comes back on its own | Content-addressed tarball cache; re-downloads when needed                                                      | Sweep bounded remove (block if `npm` running)                                   |
| `macos-bun-cache`        | `~/.bun/install/cache`                          | Bun           | Comes back on its own | Global package install cache; refills on next `bun install`                                                    | Sweep bounded remove (block if `bun` running)                                   |
| `macos-pnpm-store`       | `~/Library/pnpm/store`                          | pnpm          | **Check first**       | Shared content-addressed hardlink store; raw delete breaks offline installs, `pnpm store prune` drops unused   | Copy-only command: `pnpm store prune`                                           |
| `macos-yarn-cache`       | `~/Library/Caches/Yarn`                         | Yarn          | Comes back on its own | Cached Yarn package archives                                                                                   | Sweep bounded remove (block if `yarn` running)                                  |
| `macos-pip-cache`        | `~/Library/Caches/pip`                          | pip           | Comes back on its own | Cached Python wheels and HTTP responses                                                                        | Sweep bounded remove (block if `pip` running)                                   |
| `macos-uv-cache`         | `~/Library/Caches/uv`                           | uv            | Comes back on its own | Cached Python wheels and archives                                                                              | Sweep bounded remove (block if `uv` running); copy-only hint `uv cache clean`   |
| `macos-cargo-cache`      | `~/.cargo/registry/cache`                       | Cargo         | Comes back on its own | Compressed `.crate` archives (keeps unpacked `src` untouched)                                                  | Sweep bounded remove (block if `cargo` running)                                 |
| `macos-go-build-cache`   | `~/Library/Caches/go-build`                     | Go            | Comes back on its own | Compiled Go build artifacts; `go build` rebuilds automatically                                                 | Sweep bounded remove (block if `go` running); copy-only hint `go clean -cache`  |
| `macos-gradle-caches`    | `~/.gradle/caches`                              | Gradle        | **Check first**       | Downloaded JARs and build transforms; slow to re-download offline                                              | Sweep bounded remove (block if `java`/`gradle` running)                         |
| `macos-cocoapods-cache`  | `~/Library/Caches/CocoaPods`                    | CocoaPods     | Comes back on its own | Downloaded pod specs and archives                                                                              | Sweep bounded remove (block if `pod` running)                                   |
| `macos-playwright-cache` | `~/Library/Caches/ms-playwright`                | Playwright    | **Check first**       | Downloaded headless browser binaries; requires `playwright install` to restore                                 | Sweep bounded remove (block if Playwright browser running)                      |
| `macos-chrome-cache`     | `~/Library/Caches/Google/Chrome`                | Chrome        | Comes back on its own | Web asset and shader cache (preserves profiles, logins, bookmarks)                                             | Sweep bounded remove (block if Chrome or helpers running)                       |
| `macos-firefox-cache`    | `~/Library/Caches/Firefox/Profiles/*/cache2`    | Firefox       | Comes back on its own | Browser HTTP disk cache (preserves profiles)                                                                   | Sweep bounded remove (block if Firefox running)                                 |
| `macos-electron-code`    | `~/Library/Application Support/Code/CachedData` | VS Code       | Comes back on its own | V8 bytecode caches rebuilt on editor start                                                                     | Sweep bounded remove (block if Code or helpers running)                         |
| `macos-hf-cache`         | `~/.cache/huggingface/hub`                      | Hugging Face  | **Check first**       | Multi-GiB downloaded ML model weights; very slow to re-download                                                | Sweep bounded remove (opt-in only)                                              |

_(Note: `~/Library/Caches/com.apple.Safari` is intentionally excluded from the
macOS allowlist because Safari data lives inside TCC-protected containers that
Sweep skips without opening; see Section 3.2.)_

#### Linux allowlist

| ID                       | Canonical path template                                   | Owner           | Status badge          | Reason                                                                                                       | Mechanism                                                                      |
| ------------------------ | --------------------------------------------------------- | --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `linux-bun-cache`        | `~/.bun/install/cache`                                    | Bun             | Comes back on its own | Global Bun package install cache                                                                             | Sweep bounded remove (block if `bun` running)                                  |
| `linux-npm-cache`        | `~/.npm/_cacache`                                         | npm             | Comes back on its own | npm content-addressed download cache                                                                         | Sweep bounded remove (block if `npm` running)                                  |
| `linux-pnpm-store`       | `$XDG_DATA_HOME/pnpm/store` (`~/.local/share/pnpm/store`) | pnpm            | **Check first**       | Shared content-addressed hardlink store; `pnpm store prune` removes unreferenced packages without wiping all | Copy-only command: `pnpm store prune`                                          |
| `linux-yarn-cache`       | `$XDG_CACHE_HOME/yarn` (`~/.cache/yarn`)                  | Yarn            | Comes back on its own | Cached Yarn archives                                                                                         | Sweep bounded remove (block if `yarn` running)                                 |
| `linux-pip-cache`        | `$XDG_CACHE_HOME/pip` (`~/.cache/pip`)                    | pip             | Comes back on its own | Cached Python wheels and HTTP responses                                                                      | Sweep bounded remove (block if `pip` running)                                  |
| `linux-uv-cache`         | `$XDG_CACHE_HOME/uv` (`~/.cache/uv`)                      | uv              | Comes back on its own | Cached Python wheels and archives                                                                            | Sweep bounded remove (block if `uv` running); copy-only hint `uv cache clean`  |
| `linux-cargo-cache`      | `~/.cargo/registry/cache`                                 | Cargo           | Comes back on its own | Downloaded `.crate` tarballs                                                                                 | Sweep bounded remove (block if `cargo` running)                                |
| `linux-go-build-cache`   | `$XDG_CACHE_HOME/go-build` (`~/.cache/go-build`)          | Go              | Comes back on its own | Compiled Go build cache                                                                                      | Sweep bounded remove (block if `go` running); copy-only hint `go clean -cache` |
| `linux-gradle-caches`    | `~/.gradle/caches`                                        | Gradle          | **Check first**       | Downloaded JVM artifacts; slow to re-download                                                                | Sweep bounded remove (block if `java`/`gradle` running)                        |
| `linux-thumbnails`       | `$XDG_CACHE_HOME/thumbnails` (`~/.cache/thumbnails`)      | Desktop         | Comes back on its own | File-manager image and video preview thumbnails                                                              | Sweep bounded remove                                                           |
| `linux-mesa-shader`      | `$XDG_CACHE_HOME/mesa_shader_cache*`                      | Mesa GPU        | Comes back on its own | Compiled OpenGL/Vulkan shaders; rebuilt on next launch                                                       | Sweep bounded remove                                                           |
| `linux-chrome-cache`     | `$XDG_CACHE_HOME/google-chrome` / `chromium`              | Chrome/Chromium | Comes back on its own | Browser HTTP/GPU cache (profiles stay in `~/.config`)                                                        | Sweep bounded remove (block if Chrome/Chromium or helpers running)             |
| `linux-firefox-cache`    | `$XDG_CACHE_HOME/mozilla/firefox/*/cache2`                | Firefox         | Comes back on its own | Browser HTTP cache (profiles stay in `~/.mozilla`)                                                           | Sweep bounded remove (block if Firefox running)                                |
| `linux-playwright-cache` | `$XDG_CACHE_HOME/ms-playwright`                           | Playwright      | **Check first**       | Headless browser binaries; needs `playwright install`                                                        | Sweep bounded remove (block if Playwright browser running)                     |
| `linux-yay-paru-cache`   | `$XDG_CACHE_HOME/yay` & `$XDG_CACHE_HOME/paru/clone`      | AUR helpers     | **Check first**       | Cloned AUR build trees and built `.pkg.tar.zst` files                                                        | Copy-only command: `yay -Sc` / `paru -Sc`                                      |
| `linux-hf-cache`         | `$XDG_CACHE_HOME/huggingface/hub`                         | Hugging Face    | **Check first**       | Multi-GiB ML model weights; slow to re-download                                                              | Sweep bounded remove (opt-in only)                                             |
| `linux-pacman-cache`     | `/var/cache/pacman/pkg`                                   | pacman          | **Check first**       | System package cache (root-owned; Sweep never runs `sudo`)                                                   | Copy-only command: `sudo paccache -r`                                          |
| `linux-apt-cache`        | `/var/cache/apt/archives`                                 | apt             | **Check first**       | System `.deb` package cache (root-owned; Sweep never runs `sudo`)                                            | Copy-only command: `sudo apt clean`                                            |
| `linux-dnf-cache`        | `/var/cache/dnf` / `/var/cache/libdnf5`                   | dnf             | **Check first**       | System RPM metadata and package cache (root-owned; Sweep never runs `sudo`)                                  | Copy-only command: `sudo dnf clean all`                                        |

#### Windows allowlist

| ID                     | Canonical path template                            | Owner        | Status badge          | Reason                                                                                                       | Mechanism                                                                           |
| ---------------------- | -------------------------------------------------- | ------------ | --------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `win-user-temp`        | `%LOCALAPPDATA%\Temp`                              | Windows      | **Check first**       | General-purpose per-user temp folder; may hold installers in progress or unlocked files that exist only here | Sweep bounded remove (opt-in only, never bulk-selected; skip locked/in-use entries) |
| `win-npm-cache`        | `%LOCALAPPDATA%\npm-cache`                         | npm          | Comes back on its own | npm download cache                                                                                           | Sweep bounded remove (block if `npm`/`node` running npm)                            |
| `win-bun-cache`        | `%USERPROFILE%\.bun\install\cache`                 | Bun          | Comes back on its own | Global Bun package cache                                                                                     | Sweep bounded remove (block if `bun.exe` running)                                   |
| `win-pnpm-store`       | `%LOCALAPPDATA%\pnpm\store`                        | pnpm         | **Check first**       | Shared content-addressed hardlink store; `pnpm store prune` removes unreferenced packages without wiping all | Copy-only command: `pnpm store prune`                                               |
| `win-yarn-cache`       | `%LOCALAPPDATA%\Yarn\Cache`                        | Yarn         | Comes back on its own | Cached Yarn archives                                                                                         | Sweep bounded remove (block if `yarn` running)                                      |
| `win-pip-cache`        | `%LOCALAPPDATA%\pip\Cache`                         | pip          | Comes back on its own | Cached Python wheels                                                                                         | Sweep bounded remove (block if `pip.exe` running)                                   |
| `win-uv-cache`         | `%LOCALAPPDATA%\uv\cache`                          | uv           | Comes back on its own | Cached Python wheels and tool archives                                                                       | Sweep bounded remove (block if `uv.exe` running); copy-only hint `uv cache clean`   |
| `win-cargo-cache`      | `%USERPROFILE%\.cargo\registry\cache`              | Cargo        | Comes back on its own | Downloaded `.crate` tarballs                                                                                 | Sweep bounded remove (block if `cargo.exe` running)                                 |
| `win-go-build-cache`   | `%LOCALAPPDATA%\go-build`                          | Go           | Comes back on its own | Compiled Go build cache                                                                                      | Sweep bounded remove (block if `go.exe` running); copy-only hint `go clean -cache`  |
| `win-nuget-http`       | `%LOCALAPPDATA%\NuGet\v3-cache`                    | NuGet        | Comes back on its own | NuGet HTTP metadata cache                                                                                    | Sweep bounded remove (block if `dotnet.exe`/`nuget.exe` running)                    |
| `win-gradle-caches`    | `%USERPROFILE%\.gradle\caches`                     | Gradle       | **Check first**       | Downloaded JVM artifacts; slow to re-download                                                                | Sweep bounded remove (block if `java.exe`/`gradle` running)                         |
| `win-playwright-cache` | `%LOCALAPPDATA%\ms-playwright`                     | Playwright   | **Check first**       | Headless browser binaries; needs `playwright install`                                                        | Sweep bounded remove (block if Playwright browser running)                          |
| `win-chrome-cache`     | `%LOCALAPPDATA%\Google\Chrome\User Data\*\Cache`   | Chrome       | Comes back on its own | Browser HTTP cache (profiles and logins untouched)                                                           | Sweep bounded remove (block if `chrome.exe` or helpers running)                     |
| `win-edge-cache`       | `%LOCALAPPDATA%\Microsoft\Edge\User Data\*\Cache`  | Edge         | Comes back on its own | Browser HTTP cache (profiles and logins untouched)                                                           | Sweep bounded remove (block if `msedge.exe` or helpers running)                     |
| `win-firefox-cache`    | `%LOCALAPPDATA%\Mozilla\Firefox\Profiles\*\cache2` | Firefox      | Comes back on its own | Browser HTTP cache                                                                                           | Sweep bounded remove (block if `firefox.exe` running)                               |
| `win-dx-shader`        | `%LOCALAPPDATA%\D3DSCache`                         | DirectX      | Comes back on its own | Compiled GPU shader cache; rebuilt on next launch                                                            | Sweep bounded remove                                                                |
| `win-hf-cache`         | `%USERPROFILE%\.cache\huggingface\hub`             | Hugging Face | **Check first**       | Multi-GiB ML model weights                                                                                   | Sweep bounded remove (opt-in only)                                                  |

### 1.4 Proposed edits to `.docs/product-direction.md`

Apply these edits to [.docs/product-direction.md](../.docs/product-direction.md)
in Phase 0b (separate from guardrail authority code changes).

Replace lines 5 to 8 with:

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

Append to [.docs/decision-log.md](../.docs/decision-log.md) in Phase 0b
(separate from guardrail authority code changes):

```markdown
## Read-only space report (`sweep space`, 2026-11-27)

The owner approved expanding `sweep` with a read-only "Where your space goes"
report across 11 categories (`Apps`, `Developer`, `Photos`, `Videos`, `Music`,
`Documents`, `Downloads`, `System data`, `Caches`, `Trash`, `Other`), reachable
via `sweep space [path]` and `sweep ui --view space`:

- **Read-only home/volume access is decoupled from destructive guardrails.**
  `assertSafeCwd` continues to refuse `~`, `/`, drive roots, and OS system
  subtrees for `scan`, `clean`, `plan`, and `apply`, and `sweep ui ~` remains
  refused. `sweep space` uses a separate `assertSafeReadOnlyRoot` policy that
  permits `~` and volume roots strictly for read-only aggregation and never
  produces an executable `ScanPlan` or passes report paths into cleanup scans.
- **Personal files are permanently information-only.** Photos, Videos, Music,
  Documents, Downloads, Apps, System data, and Other cannot be queued, planned,
  or removed in either engine or the TUI. Sealed app and photo bundles are
  classified atomically before catalog matching.
- **Only three action classes are permitted**, each with its own confirmation
  boundary: (1) Developer project artifacts via an independent fresh project
  scan enforcing positive artifact eligibility in both engines; (2) a compiled,
  versioned, per-OS allowlist of verified regenerable cache leaves, each tagged
  "Comes back on its own" or "Check first" with strict running-app blocking;
  and (3) emptying the OS Trash behind a separate permanent-delete confirmation
  bound to the invoking user, pinned volume identity, and confirmed item set.
- **Cache direct-delete exception against UX reversibility convention.**
  Verified "Comes back on its own" cache leaves delete directly after an
  explicit permanent-delete confirmation (stating that bytes are removed rather
  than moved to Trash and that local snapshots may still hold blocks), with no
  Trash toggle because moving caches to local Trash frees 0 bytes on the same
  volume and Trash has its own flow. Check-first caches (including Windows
  Temp) stay opt-in. Owner-tool commands (`pacman`, `apt`, `dnf`, `brew
  cleanup`, `pnpm store prune`) are copy-only; `sweep` never spawns `sudo`.
- **Allocated bytes lead, in binary GiB/MiB only.** Space reports count
  attributed disk allocation alongside apparent bytes, keep walked totals,
  volume counters, and reclaim estimates distinct, and enforce no-recall
  metadata-only access before the first filesystem operation (zero MIME content
  reads in v1). `System data` represents unclassified volume usage only when
  walked allocation and volume capacity share a demonstrated accounting domain.
- **Zero telemetry and aggregate-only caching.** Nothing leaves the machine.
  L4 cached instant-start snapshots use a separate aggregate-only schema with
  no file paths, mount labels, or project names, and disable every action until
  a fresh complete scan settles. `--redact` serializes only approved fields
  across JSON, NDJSON, human output, and stderr.
```

---

## 2. CLI surface, protocol schemas, exit codes, and Rust engine reuse

### 2.1 CLI surface (`apps/cli`)

#### New command: `sweep space [path]`

Read-only category breakdown. Never mutates the filesystem. Uses binary units
(`GiB`, `MiB`, `KiB`, `B`) only in human output and integer bytes in JSON (no
`--si` flag).

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
  --redact                        Serialize only approved anonymized fields
                                  across JSON, NDJSON, stdout, and stderr
  --no-cache                      Ignore cached snapshot; wait for fresh walk
  --engine <auto|rust|js>         Scan engine (default: auto)
  --resource-profile <profile>    balanced (default) or low-memory
  --no-color                      Disable ANSI colors
  -q, --quiet                     Summary line only (human mode)
  --verbose                       Include subgroup tables and coverage stats
```

**Intentional omissions:** `sweep space` accepts **zero** destructive flags
(`--yes`, `--dry-run`, `--trash`, `--force-large`, `--allow-dangerous`) and no
`--si` flag. Passing any destructive flag fails with `invalid_arguments`
(exit 2) and explains the read-only contract.

**Human CLI output** prints the compact storage card: one bold headline figure
(`357.8 GiB` + dim `of 512 GiB used`), a dim free-space line (with separate
purgeable suffix when available), one segmented dot bar, a 3-column category
legend, and one sentence with the exact next command (such as
`Run: sweep ui --view space` or `sweep ui ~/Projects`).

#### TUI integration (`sweep ui`)

- **`sweep ui ~` remains refused** by `assertSafeCwd` (with a clear hint
  pointing to `sweep space` or `sweep ui --view space ~`). Bare `sweep ui
  <path>` continues to mean project cleanup review only.
- **`sweep ui --view space [path]`** extends `--view <projects|full|space>` in
  `apps/cli/src/cli.ts`. When `--view space` is selected (defaulting `[path]`
  to `~`), the target is validated through `assertSafeReadOnlyRoot` and cannot
  construct a `ScanPlan`.
- **In-session navigation from existing views:**
  - Press **`w`** ("Where space goes") in Projects or Full view, or choose
    `Space overview` from the **`Ctrl+K` / `F2`** Actions palette. (`s` remains
    bound to "Queue safe items" inside Projects/Full view with zero conflict.)
  - Per UX Principle 2 (**Esc walks back, it never quits**), `Esc` inside
    `SpaceView` unwinds one layer per press: open modal (Cache review or Trash
    confirm) -> focused category detail drawer -> back to `ProjectsView` (when
    entered from `ProjectsView`), or cancels an active space scan and returns
    to the previous view. When launched directly via `sweep ui --view space ~`
    at the top layer, `Esc` flashes `nothing to unwind - q or ctrl-c quits`.
    Quitting is always explicit `q` or `Ctrl-C`.
- **Key bindings on the Space overview:**
  - `↑↓←→` moves category focus across the 3-column legend (instant highlight,
    no transition delay).
  - `Enter` opens read-only details for the focused category.
  - `c` opens the review surface for the focused actionable category (or the
    single recommended action when an actionable category is focused):
    - On `Developer`: opens the independent project picker (validated live
      project roots, never paths serialized in a report or cache), which
      launches a fresh `ProjectsView` scan with an **empty queue**.
    - On `Caches`: opens the Allowlisted Cache Review overlay (entries start
      unselected; `s` selects only `"Comes back on its own"` rows that are not
      in use and have verified process state; `"Check first"` rows including
      Windows Temp require explicit per-row opt-in; active-process or unknown
      process-state rows cannot be selected in any mode; `c` opens the
      permanent-delete confirm dialog).
    - On `Trash`: opens the dedicated Trash confirmation overlay (separate from
      every other queue, naming the exact pinned volume or drive).
  - On the Space overview itself, `Space`, `a`, `s`, `x`, and `d` do nothing
    and show a one-line notice (matching UX Principle 7).
  - Review (`c`) is disabled whenever `report.cached` is `true`,
    `report.coverage.complete` is `false`, `report.redacted` is `true`, or the
    focused category has `bytesKnown: false`.

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
`0 <= n <= 9007199254740991`, `additionalProperties: false` everywhere). Notice
that `spaceAction` and `spaceSubgroup` intentionally omit `targetRoots`,
action-driving `path`, and executable `ownerCommand` strings so a report can
never steer destructive dispatch or shell execution.

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
      "required": [
        "mountPoint",
        "totalBytes",
        "usedBytes",
        "availableBytes",
        "bytesBasis",
        "accountingDomainComparable"
      ],
      "properties": {
        "mountPoint": { "type": "string", "maxLength": 4096 },
        "fsType": { "type": "string", "maxLength": 64 },
        "totalBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "usedBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "availableBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "purgeableBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "snapshotCount": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "snapshotsIncludedInPurgeable": { "type": "boolean" },
        "bytesBasis": { "enum": ["statvfs", "GetDiskFreeSpaceEx", "unavailable"] },
        "accountingDomainComparable": { "type": "boolean" }
      }
    },
    "coverage": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "scannedDirs",
        "scannedFiles",
        "scannedNames",
        "skippedDirs",
        "skippedFiles",
        "permissionDeniedDirs",
        "crossDeviceSkippedDirs",
        "hardlinkDedupedInodes",
        "hardlinkDedupCapHit",
        "cycleCapHit",
        "complete",
        "partialReasons"
      ],
      "properties": {
        "scannedDirs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "scannedFiles": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "scannedNames": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "skippedDirs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "skippedFiles": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "permissionDeniedDirs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "crossDeviceSkippedDirs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "hardlinkDedupedInodes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "hardlinkDedupCapHit": { "type": "boolean" },
        "cycleCapHit": { "type": "boolean" },
        "complete": { "type": "boolean" },
        "partialReasons": {
          "type": "array",
          "maxItems": 16,
          "items": {
            "enum": [
              "permission_denied",
              "tcc_or_permission",
              "hardlink_dedup_cap",
              "cycle_cap",
              "queue_cap",
              "clone_or_compression_overlap",
              "allocated_unavailable",
              "unreadable_entries",
              "cloud_placeholders_excluded",
              "no_recall_policy_unavailable",
              "other_volumes_excluded"
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
      "required": [
        "id",
        "label",
        "allocatedBytes",
        "apparentBytes",
        "fileCount",
        "nameCount",
        "actionability"
      ],
      "properties": {
        "id": { "type": "string", "maxLength": 128 },
        "label": { "type": "string", "maxLength": 256 },
        "allocatedBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "apparentBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "fileCount": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "nameCount": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "actionability": {
          "enum": [
            "info_only",
            "developer_cleanup",
            "allowlisted_cache",
            "trash_empty",
            "owner_tool_copy_only"
          ]
        },
        "allowlistId": { "type": "string", "maxLength": 128 },
        "rebuildStatus": {
          "enum": ["comes_back", "reinstall", "rebuild", "check_first", "info_only"]
        },
        "reason": { "type": "string", "maxLength": 512 },
        "processState": { "enum": ["idle", "in_use", "unknown"] }
      }
    },
    "spaceCategory": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "label",
        "fileCount",
        "nameCount",
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
        "nameCount": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "bytesKnown": { "type": "boolean" },
        "unknownReason": {
          "enum": [
            "tcc_or_permission",
            "hardlink_dedup_cap",
            "incomparable_domain",
            "invalid_residual",
            "not_applicable_for_scope"
          ]
        },
        "actionability": {
          "enum": [
            "info_only",
            "developer_cleanup",
            "allowlisted_cache",
            "trash_empty",
            "owner_tool_copy_only"
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
        "intent",
        "category",
        "estimatedBytes",
        "sentence",
        "buttonLabel",
        "requiresConfirmation"
      ],
      "properties": {
        "id": { "type": "string", "maxLength": 128 },
        "intent": {
          "enum": ["developer_review", "cache_review", "trash_review", "owner_command_copy"]
        },
        "category": { "enum": ["developer", "caches", "trash"] },
        "estimatedBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "statusLabel": { "enum": ["Comes back on its own", "Check first", "In Trash"] },
        "sentence": { "type": "string", "maxLength": 512 },
        "buttonLabel": { "type": "string", "maxLength": 64 },
        "allowlistIds": {
          "type": "array",
          "maxItems": 32,
          "items": { "type": "string", "maxLength": 128 }
        },
        "requiresConfirmation": { "const": true }
      }
    }
  }
}
```

Key structural invariants in this schema:

1. `"readOnly": { "const": true }`: cannot be confused with an executable
   `ScanPlan`.
2. `spaceAction.category` is strictly `["developer", "caches", "trash"]`,
   coupled with fixed `intent` values (`developer_review`, `cache_review`,
   `trash_review`, `owner_command_copy`) and **no `targetRoots`, no subgroup
   `path`, and no executable `ownerCommand`**. Display strings for copy-only
   owner commands are looked up exclusively from the compiled allowlist by
   `allowlistId`.
3. `statusLabel` is optional and omitted for `developer_review`; Trash uses
   `"In Trash"` (never `"Already deleted"`) to convey that files remain
   recoverable until purged.
4. `allocatedBytes` and `apparentBytes` on `spaceCategory` are optional when
   `bytesKnown` is `false` (for example, an unread macOS TCC folder or an
   incomparable `system_data` residual leaves totals unset instead of reporting
   `0`).
5. **Personal subgroups never keep filenames**, including before `--redact`.
   Subgroups under `photos`, `videos`, `music`, `documents`, `downloads`,
   `apps`, `system_data`, and `other` are strictly type or bucket totals (such
   as `"Photos Library"`, `"HEIC"`, `"MP4"`, `"Not stored on this disk"`).
6. `estimatedBytes` for `developer_review` quotes **eligible build artifact
   bytes only**, never source code, `.git`, or toolchains.

#### New streaming schema: `packages/protocol/schemas/space-event.schema.json`

NDJSON events emitted by `sweep space --json-stream` and consumed by the TUI:

- `space_started`: `{ type, targetDir, scope, redacted, volume? }`
- `space_cached_snapshot`: `{ type, snapshot }` (emitted immediately if a valid
  aggregate-only `SpaceCacheSnapshot` exists, with `cacheAgeMs` so the TUI
  paints an explicitly labeled stale view while scanning and keeps every action
  disabled)
- `space_progress`: `{ type, scannedDirs, scannedFiles, skippedDirs, currentDir?, categories: [{ id, allocatedBytes, apparentBytes, fileCount, nameCount }] }` (throttled to 80 to 120 ms cadence; `currentDir` is omitted when `--redact` is set)
- `space_warning`: `{ type, code, detail? }` (typed warning code from a fixed
  enum; `detail` is omitted under `--redact` so raw paths cannot leak)
- `space_completed`: `{ type, report }` (the complete validated `SpaceReport`)

### 2.3 Exit codes

Reuses `EXIT` in [apps/cli/src/errors.ts](../apps/cli/src/errors.ts) verbatim:

| Exit code | Name                | Meaning for `sweep space`                                                                                                                                                              |
| --------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | `EXIT.OK`           | Report completed (including normal partial coverage such as unreadable macOS TCC folders, clearly flagged via `coverage.complete: false` and `coverage.partialReasons`).               |
| `1`       | `EXIT.ABORTED`      | Cancelled by `SIGINT` / `SIGTERM` or TUI quit before completion.                                                                                                                       |
| `2`       | `EXIT.GUARDRAIL`    | Invalid CLI arguments (including any destructive flag or `--si`), blocked virtual root (`/proc`, `/sys`, `/dev`), volume-scope run as `root` without `SUDO_UID`, or fatal limit abort. |
| `3`       | `EXIT.CONFIG_PARSE` | Malformed stdin JSON (engine CLI) or invalid config file.                                                                                                                              |
| `4`       | `EXIT.FAILURE`      | Target root unreadable or missing, engine crash, malformed stream, or stdout pipe failure.                                                                                             |

### 2.4 Reusing the Rust engine (`crates/sweep-fs`, `crates/sweep-engine`, `crates/sweep-engine-cli`)

- **New native subcommand:** `sweep-engine space <target-dir>` reading
  `SpaceStdinOptions` JSON on stdin (`scope`, `metric`, `jsonStream`,
  `redact`, `limits`, `osHints`).
- **Capability advertisement:** `sweep-engine --capabilities` adds
  `"spaceReport": true` (additive). The JS host checks this capability before
  invoking native `space`; older native binaries fall back to the JS
  `space-scanner.ts` with a typed diagnostic notice (redacted cleanly when
  `--redact` is active; read-only fallback is safe, unlike destructive apply).
- **Direct reuse of `crates/sweep-fs` primitives:**
  - Work-stealing LIFO directory pool (`crossbeam-deque::Worker::new_lifo`,
    `Injector`, `Stealer`) and CPU-aware worker sizing from
    `crates/sweep-fs/src/concurrency.rs`, extended with resumable directory
    cursors / bounded work splitting so wide sibling sets are paused and
    resumed rather than dropped under queue pressure.
  - Cross-platform identity primitives from `crates/sweep-fs/src/identity.rs`
    (Unix `(dev, ino, nlink)`, Windows enumeration attributes first and
    `FILE_FLAG_OPEN_NO_RECALL` handle open only when non-placeholder hardlink
    identity is needed).
  - Symlink and reparse-point refusal (`meta_is_reparse_point`, never following
    symlinks or non-Known-Folder junctions) and `MAX_DIR_ENTRIES` (4,000,000)
    runaway-dir guard.
  - Existing `PatternMatcher`, `artifact_rule_for`, and `classify.rs` extended
    with bundle-sealing and positive artifact eligibility in the **same single
    pass**.
  - Cooperative cancellation via `AtomicBool` wired to `SIGINT`/`SIGTERM`
    (Unix) and console control handler (Windows). Cancellation separates
    **prompt acknowledgement** (<100 ms CLI/UI ack) from **worker exit**,
    because cooperatively checked flags cannot interrupt a kernel-blocked
    syscall (such as hung NFS/FUSE I/O).
- **Separated cycle/alias and hardlink state under one coordinated budget:**
  - `VisitedDirs` (directory cycle and mount-alias protection) is stored in its
    own dedicated map, strictly separate from `SeenHardlinks` (multi-link file
    accounting), so a pnpm/Bun hardlink store can never crowd out cycle
    prevention.
  - `space_walk` retains zero per-file path strings. Directory frames, open
    file descriptors, queued path bytes, `VisitedDirs`, `SeenHardlinks`,
    top-K subgroup tables, serialized progress events, and host-side buffers
    share one explicit coordinated memory budget (Section 4.2).

---

## 3. Classification method per OS

### 3.1 Deterministic priority waterfall and category-overlap table

Before any classification rule runs, the engine installs the OS **no-recall
policy** (Section 3.2 and Section 3.4) and resolves the **invoking user**
boundary (below). Each directory or file encountered during the single-pass
walk is then classified by the **first matching rule** in this strict order:

1. **No-recall policy, invoking-user scope boundary, and skip rules (before opening or matching):**
   - **No-recall before root resolution:** On macOS, call `setiopolicy_np` to
     disable dataless materialization before resolving roots or calling
     `read_dir`/`lstat`. On Windows, inspect `FindFirstFileEx` attributes before
     any size, identity, or open call. Reject remote, auto-mounted, or cloud
     provider paths when local no-recall access cannot be established.
   - **Invoking-user isolation on `--scope volume` (`/` or `C:\`):** Classify
     personal categories, `developer`, `caches`, and `trash` **only** for the
     invoking user (`getuid()`, or `SUDO_UID` when running under `sudo` on Unix;
     invoking Windows token user SID on Windows). If running as `root` (uid 0)
     with `SUDO_UID` unset, refuse volume-scope personal classification with
     `EXIT.GUARDRAIL` (2) and tell the operator to run as themselves. Sum every
     other `/home/*`, `/Users/*`, and `C:\Users\*`, plus `/Users/Shared` and
     `C:\Users\Public`, directly into `system_data` as an aggregate byte total
     with **no paths, no subgroups, and no actions**.
   - **Symlinks and non-Known-Folder reparse points:** Price only the link
     inode itself; never recurse into its target.
   - **macOS privacy containers and TCC pre-probe:** Skip `~/Library/Mail`,
     `~/Library/Messages`, `~/Library/Safari`, `~/Library/Calendars`,
     `~/Library/Contacts`, `~/Library/Reminders`, `~/Library/HomeKit`,
     `~/Library/Cookies`, and `~/Library/IdentityServices` without opening
     them. Probe `~/Desktop`, `~/Documents`, `~/Downloads`, and `~/Pictures`
     once on the calling thread before the worker pool starts (Section 3.2).
   - **Pseudo, virtual, automount, WSL, and snapshot boundaries:** Skip
     `/proc`, `/sys`, `/dev`, `/run`, `/snap/*` squashfs mounts, `autofs`
     mounts (detected from mount table / `AT_NO_AUTOMOUNT` without triggering
     automount), nested `tmpfs`/`proc`/`sysfs`/`overlay` mounts (while still
     walking the root filesystem when the container root itself is `overlay`),
     WSL `/mnt/c` and other `drvfs` Windows mounts (with a visible note), and
     snapshot trees (ZFS `.zfs`, Snapper `.snapshots`, Timeshift snapshot
     trees, and btrfs subvolumes with `parent_uuid` set).
   - **Cross-device mounts (`st_dev != root_dev`):** Skip foreign devices on
     `home`/`volume` scope, increment `coverage.crossDeviceSkippedDirs`, and
     surface a visible `"not on this disk"` note for bind mounts or foreign
     devices mounted under `$HOME` (with explicit carve-outs only for
     non-snapshot read-write btrfs subvolumes on the same filesystem UUID and
     the macOS APFS Data volume).
   - **Cycle and alias dedupe (`VisitedDirs`):** Dedicated `(dev, ino)`
     directory table catches bind mounts and macOS firmlinks. If its cap is
     reached, stop descending into unverified subtrees and record `cycle_cap`
     (`complete: false`) rather than risking an infinite loop.
2. **`trash` (canonical Trash roots for the invoking user):**
   Home trash (`~/.Trash`, `$XDG_DATA_HOME/Trash`, invoking user's Recycle Bin
   on the home drive) plus external volume trash roots when on the targeted
   volume (Section 3.2 to Section 3.4). Everything under a trash root, including
   a deleted video or `node_modules`, belongs to `trash` and enters Trash
   confirm only.
3. **Sealed bundles (BEFORE catalog, cache, or extension matching):**
   Assign the entire subtree atomically to its bundle category and run **zero**
   catalog, cache, or extension rules inside:
   - macOS: `*.app`, `*.framework` -> `apps`; `*.photoslibrary` -> `photos`
   - Linux: Flatpak app and runtime trees (`~/.local/share/flatpak`,
     `/var/lib/flatpak`) and Snap roots (`~/snap`, `/var/lib/snapd/snaps`) ->
     `apps`
   - Windows: `Program Files`, `Program Files (x86)`, and `WindowsApps` ->
     `apps`
     An Electron `node_modules` inside `~/Applications/Foo.app/Contents/Resources/app/node_modules`,
     a downloaded `.app` inside `~/Downloads`, a Flatpak tree, or `WindowsApps`
     stays inside its sealed bundle and contributes zero actionable bytes.
4. **`caches` (verified compiled allowlist leaves and OS cache containers):**
   - Exact canonical realpath match against a resolved per-OS allowlist leaf
     (verified same-user ownership and non-overlap with any personal root) ->
     `caches` with `actionability: "allowlisted_cache"` (or
     `"owner_tool_copy_only"` for copy-only entries like `pnpm/store` or
     root-owned system package caches).
   - Guard against redirected cache env vars: if resolved `XDG_CACHE_HOME`,
     `npm_config_cache`, `CARGO_HOME`, `PNPM_HOME`, or `GRADLE_USER_HOME`
     equals (or is an ancestor/descendant conflicting with) a personal folder
     itself, that personal folder wins and is never queued.
   - Other directories inside `$XDG_CACHE_HOME` / `~/.cache`,
     `~/Library/Caches`, or `%LOCALAPPDATA%` cache containers stay `caches`
     with `actionability: "info_only"`. A copied `cacache`,
     `~/Documents/.cache`, or a directory merely named `Cache` does not match
     the allowlist and stays in its enclosing folder.
5. **`developer` (eligible catalog artifacts, recognized projects, and toolchains):**
   - **Eligible catalog artifacts:** Directories matched by Sweep's catalog
     (`node_modules`, `target` with sibling `Cargo.toml` or `CACHEDIR.TAG`,
     `.next`, `.turbo`, `.venv`, and peers) outside sealed bundles and system/
     tool homes that pass the **positive artifact eligibility check** and
     contain **no protected personal subtree** -> `developer`, eligible for
     Developer review. When such an eligible artifact sits inside a project
     under `Documents`, `Desktop`, or `Downloads`, it counts under `developer`
     (not `Documents`/`Downloads`) and the review sentence names the parent
     folder.
   - **Recognized project roots (source, `.git`, and project media):** Inside a
     recognized project root (with a project manifest or `.git`) located
     outside the six personal known folders, non-artifact source files, `.git`,
     and project media count under `developer` in an `info_only` subgroup
     (`Source & git history`) and are never queued; extension fallback does not
     run inside a recognized project.
   - **Developer toolchains and SDK homes:** `~/.rustup`, `~/.cargo` (minus
     `registry/cache`), `~/.nvm`, `~/.fnm`, `~/.volta`, `~/.pyenv`, `~/.rbenv`,
     `~/.sdkman`, `~/.asdf`, `~/.mise`, `~/go`, `~/.m2`, `~/.gradle` (minus
     `caches`), `~/.android`, `~/.docker`, `~/.local/share/containers`,
     `~/Library/Developer` (minus allowlisted cache leaves), `~/.vscode`,
     `~/.cursor`, `~/.local/share/JetBrains` -> `developer`, `info_only` (with
     copy-only owner commands where relevant).
6. **Remaining `apps` trees (`info_only`):**
   Non-sealed app data and install locations: macOS `~/Library/Application
   Support` (excluding allowlisted cache leaves like `Code/CachedData`),
   `~/Library/Containers`, `~/Library/Group Containers`; Linux
   `~/.var/app/*/data` and `config`, `*.AppImage`; Windows
   `%LOCALAPPDATA%\Programs`, `%LOCALAPPDATA%\Packages`, `ProgramData`
   (non-cache).
7. **Known personal folders (OS-resolved, longest-prefix match, always `info_only`):**
   - `downloads`: OS Downloads directory
   - `photos`: OS Pictures directory (`*.photoslibrary` already sealed in
     Rule 3)
   - `videos`: OS Movies/Videos directory
   - `music`: OS Music directory
   - `documents`: OS Documents and Desktop directories (guarding against any
     XDG entry resolving to `$HOME` itself)
8. **Compiled extension table fallback (outside known folders, sealed bundles, and recognized projects):**
   Classify remaining files by static lowercase ASCII extension table into
   `photos`, `videos`, `music`, or `documents`. **Zero MIME content reads in
   v1.**
9. **`other` (`info_only`):** Everything remaining inside the walked
   invoking-user scope (VM disk images, ISO files, game data, unrecognized
   blobs).
10. **`system_data` (Unclassified volume usage, `info_only`):** Computed
    post-walk at `home` or `volume` scope only when accounting domains match
    (Section 3.7), plus aggregated other-user home/Shared/Public totals on
    `volume` scope.

#### Authoritative category-overlap table (shared by classifier and apply guard)

This table replaces any ad-hoc `isPersonalRootTarget` check so classification,
UI review, and both apply engines enforce identical boundaries:

| Where the file or directory is                                                                                                                                     | Category                           | Action and apply boundary                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Video, audio, or PDF inside a recognized project root (outside personal known folders)                                                                             | `developer` (`info_only` subgroup) | Never queued. Extension fallback does not run inside the project.                                                                                             |
| That same file inside Pictures, Movies/Videos, Music, Documents, Downloads, or Desktop                                                                             | That known folder (longest prefix) | Never queued.                                                                                                                                                 |
| Eligible catalog artifact (`node_modules`, `target`, `.next`, peers) inside Documents/Desktop/Downloads                                                            | `developer`                        | Reviewable only if positive artifact eligibility holds and no protected personal subtree is inside. Sentence names parent folder. Excluded from personal sum. |
| Catalog artifact inside a sealed bundle (`.app`, `.framework`, `*.photoslibrary`, Flatpak, Snap, etc.)                                                             | The bundle (`apps` or `photos`)    | Never queued. Sealed bundles block catalog, cache, and extension rules (Rule 3).                                                                              |
| Realpath equals a resolved compiled allowlist entry (same user, no personal-root overlap)                                                                          | `caches`                           | Reviewable (`allowlisted_cache` or copy-only). A copied `cacache`, `~/Documents/.cache`, or a dir only named `Cache` stays in its enclosing folder.           |
| Resolved `XDG_CACHE_HOME`, `npm_config_cache`, `CARGO_HOME`, `PNPM_HOME`, or `GRADLE_USER_HOME` is a personal folder (or ancestor/descendant conflicting with one) | That personal folder               | Never queued. Display-only.                                                                                                                                   |
| Anything under a verified invoking-user trash root, including a deleted video or `node_modules`                                                                    | `trash`                            | Trash confirm only.                                                                                                                                           |

### 3.2 macOS specifics

- **No-recall policy before root resolution:**
  Before resolving the target root, probing folders, or starting worker threads,
  call `setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
  IOPOL_SCOPE_PROCESS, IOPOL_MATERIALIZE_DATALESS_FILES_OFF)` (or
  `IOPOL_SCOPE_THREAD` on every worker thread). If policy installation fails,
  record `no_recall_policy_unavailable` in `coverage.partialReasons` and skip
  cloud-provider / dataless paths rather than risking hydration. If any
  `read_dir` or `open` returns `EDEADLK` (macOS signal that a dataless
  directory would have to materialize), treat it as skipped coverage
  (`cloud_placeholders_excluded`) and never retry.
- **No Spotlight in v1:**
  Phase 2 uses the filesystem walk and compiled UTI-aligned extension table on
  every OS. `mdls` and `mdfind` are not invoked in v1 so byte totals have zero
  Spotlight-daemon dependency and zero recall risk.
- **TCC privacy containers and pre-pool probe:**
  - Skip `~/Library/Mail`, `~/Library/Messages`, `~/Library/Safari`,
    `~/Library/Calendars`, `~/Library/Contacts`, `~/Library/Reminders`,
    `~/Library/HomeKit`, `~/Library/Cookies`, and `~/Library/IdentityServices`
    **without opening them**.
  - Probe `~/Desktop`, `~/Documents`, `~/Downloads`, and `~/Pictures` **once,
    on the calling thread, before the worker pool starts** (so any OS
    permission prompt cannot stall worker threads or blow cancellation).
  - On `EPERM` or `EACCES`: set that category's `bytesKnown` to `false`, leave
    its `allocatedBytes` and `apparentBytes` unset (never report `0 GiB` for an
    unread folder), set `unknownReason: "tcc_or_permission"`, explain in the
    category insight that the folder was not read, name those unread folders in
    the `System data` sentence, add `tcc_or_permission` to
    `coverage.partialReasons`, and set `coverage.complete: false`.
- **Dataless cloud files (`UF_DATALESS` / `SF_DATALESS`):**
  For `~/Library/CloudStorage` and iCloud Drive files with the dataless flag
  set, keep `allocatedBytes = 0`, record `apparentBytes` from `lstat` metadata
  without opening the file, add `cloud_placeholders_excluded` to
  `coverage.partialReasons`, and display a visible info-only subgroup
  **`"Not stored on this disk"`** on the default card so Photos or Documents do
  not look empty. Never describe dataless files as "sparse".
- **`~/Library` and `/Applications` routing:**
  - `~/Library/Caches` -> `caches` (allowlisted leaves reviewable; rest
    `info_only`).
  - `~/Library/Developer` -> allowlisted cache leaves (`Xcode/DerivedData`,
    `CoreSimulator/Caches`, `Xcode/UserData/Previews`) route to `caches` in
    Rule 4; remaining SDKs, DeviceSupport, Archives, and CoreSimulator data
    route to `developer` (`info_only`).
  - `~/Library/Application Support`, `~/Library/Containers`,
    `~/Library/Group Containers` -> `apps` (carving out explicitly allowlisted
    cache leaves like `Code/CachedData`).
  - `/Applications` and `~/Applications`: every `.app` and `.framework` is
    sealed atomically as `apps` in Rule 3 before catalog matching. On
    `--scope home`, `/Applications` on the same APFS Data volume is read-only
    probed so installed apps are attributed to `apps` rather than `system_data`.
- **APFS Data volume, firmlinks, snapshots, and purgeable space:**
  - Read `totalBytes`, `usedBytes`, and `availableBytes` from the **APFS Data
    volume** containing the home directory (`/System/Volumes/Data` via
    `statvfs(home)` / Data volume mount), never from the sealed read-only `/`
    system snapshot volume. On a standard Mac, `sweep space /` and
    `sweep space ~` must report the exact same volume total, used, and free
    figures.
  - When walking `--scope volume`, walk `/System/Volumes/Data` and skip
    `/System/Volumes/*` aliases via `VisitedDirs` so firmlinks (`/Users`,
    `/Applications`, `/Library`) are never counted twice.
  - **Purgeable calculation:** `NSURLVolumeAvailableCapacityForImportantUsageKey`
    reports `availableBytes + purgeableBytes`, not purgeable alone. Compute:
    ```text
    purgeableBytes = max(0, importantUsage - availableBytes)
    ```
    Keep `purgeableBytes` strictly off the headline used figure and out of
    `availableBytes` (display only on the dim secondary free-space line, e.g.
    `154.2 GiB free, +28.4 GiB purgeable`). Keep APFS container headroom,
    per-volume attribution, local snapshots, and estimated purgeable capacity
    distinct.
  - Local APFS snapshots (`com.apple.TimeMachine.*`): query `snapshotCount` via
    `fs_snapshot_list` when permitted without root. When snapshot blocks are
    already reflected in `purgeableBytes` (`snapshotsIncludedInPurgeable:
    true`), the `System data` sentence must not claim them a second time.
- **Trash roots:**
  Recognize `~/.Trash` on home scope and `<volume>/.Trashes/<uid>` on external
  or targeted volumes (owned by invoking uid).

### 3.3 Linux specifics

- **XDG User Directories (zero subprocess spawn):**
  Read `$XDG_CONFIG_HOME/user-dirs.dirs` (fallback `~/.config/user-dirs.dirs`)
  with a bounded 16 KiB `O_NOFOLLOW | O_NONBLOCK` read. Parse
  `XDG_PICTURES_DIR`, `XDG_VIDEOS_DIR`, `XDG_MUSIC_DIR`, `XDG_DOCUMENTS_DIR`,
  `XDG_DOWNLOAD_DIR`, `XDG_DESKTOP_DIR` (expanding `$HOME` and honoring
  localized names like `~/Bilder` or `~/Téléchargements`). Reject any entry
  that resolves to `$HOME` itself, traverses via `..`, or points to `/`. If an
  XDG known folder resolves cleanly to a path **outside `$HOME`** (for example,
  `/mnt/media/Downloads` on another disk), record that folder as **"on another
  disk"** (`other_volumes_excluded` note) and do **not** silently replace it
  with an empty `~/Downloads`. Fall back to
  `$HOME/{Pictures,Videos,Music,Documents,Downloads,Desktop}` only when the XDG
  entry is absent.
- **Flatpak, Snap, and AppImage (`apps`):**
  - `~/.local/share/flatpak`, `/var/lib/flatpak` (on volume scope, or probed
    read-only on home scope when on the same volume), `~/snap`, and
    `/var/lib/snapd/snaps` are **sealed** as `apps` in Rule 3 before catalog
    matching.
  - `~/.var/app/*/data` and `config` -> `apps`; `~/.var/app/*/cache` ->
    `caches` (`info_only` unless allowlisted).
  - `/snap/*` squashfs loop mounts are skipped by mount-type/device check so
    compressed snap images are never double-counted.
  - `*.AppImage` files -> `apps`.
- **Walk boundaries (mounts, snapshots, network filesystems, WSL):**
  - Parse `/proc/self/mountinfo` once (capped at 1 MiB) before walking.
  - **Snapshots:** Skip ZFS `.zfs`, Snapper `.snapshots`, Timeshift snapshot
    directories, and btrfs subvolumes whose `parent_uuid` is set (inode dedup
    does not collapse snapshots). Include another btrfs synthetic `st_dev`
    **only** for a non-snapshot read-write subvolume on the same filesystem
    UUID.
  - **Autofs and virtual mounts:** Never trigger `autofs` (identify `autofs`
    mountpoints from `mountinfo` and pass `AT_NO_AUTOMOUNT` / avoid `stat` on
    automount triggers). Skip nested `tmpfs`, `proc`, `sysfs`, `devtmpfs`,
    `cgroup2`, and nested `overlay` mounts, while still walking the root
    filesystem when the container root itself is `overlay`.
  - **Network and virtual filesystems (`nfs`, `nfs4`, `smb`, `cifs`, `9p`, `drvfs`):**
    When `st_blocks` is missing or reported as zero for non-empty files, ignore
    `st_blocks`, show apparent bytes, and add `allocated_unavailable` to
    `coverage.partialReasons`. Section 4.2's local-SSD timing targets do not
    apply as failures on network homes.
  - **WSL:** Under WSL, exclude `/mnt/c` and other `drvfs` Windows drive mounts
    from a home or `/` report and show a clear note that Windows drives are not
    included.
  - **Bind mounts and foreign devices under `$HOME`:** Skipping a bind mount or
    foreign device increments `coverage.crossDeviceSkippedDirs` and surfaces a
    visible `"not on this disk"` note.
  - **Separate `/home` volume:** When `/home` is its own mounted filesystem,
    `System data`'s sentence names other accounts, unread directories, and
    filesystem metadata; it does **not** say `"OS files"`.
- **Caches (`~/.cache` and system package caches):**
  - `$XDG_CACHE_HOME` (default `~/.cache`) -> `caches`, with compiled
    allowlist leaves tagged `allowlisted_cache` and unknown subdirs tagged
    `info_only`.
  - System package caches (`/var/cache/pacman/pkg`, `/var/cache/apt/archives`,
    `/var/cache/dnf`, `/var/cache/libdnf5`, `/var/cache/zypp`): when readable
    by the current user without elevation on the same volume, measure them and
    report as `actionability: "owner_tool_copy_only"` with their compiled
    copy-only `sudo` commands. Sweep never executes `sudo`.
- **Trash (FreeDesktop Trash Specification 1.0):**
  - Home Trash: `$XDG_DATA_HOME/Trash` (default `~/.local/share/Trash`),
    counting `files/`, `info/*.trashinfo`, and `expunged/` if present.
  - External volume Trash: check `<top>/.Trash/<uid>` **only** when
    `<top>/.Trash` exists, is not a symlink, and has the sticky bit (`01000`)
    set, and `<uid>` is owned by the invoking user; otherwise recognize
    `<top>/.Trash-<uid>` owned by the invoking user.
  - Reading `.trashinfo` files (bounded to 4 KiB each, `O_NOFOLLOW | O_NONBLOCK`,
    sampled up to 1,000 for date range) provides oldest/newest `DeletionDate`
    and display-only metadata. Original `Path=` values are **never** used as
    deletion targets and **never** written to journals, receipts, or caches.
  - At confirmation and apply time, rediscover and verify the invoking user's
    Trash root and volume device ID, capture an explicit confirmed snapshot of
    verified Trash entries (with inode identities), remove only entries in that
    confirmed snapshot, and skip any replacement or new arrival created after
    confirmation.

### 3.4 Windows specifics

- **Enumeration and no-recall placeholder handling:**
  - Enumerate directories using `FindFirstFileExW` (`FindExInfoBasic` and
    `FIND_FIRST_EX_LARGE_FETCH`) so size (`nFileSizeHigh`/`nFileSizeLow`) and
    attributes (`dwFileAttributes`) come directly from directory enumeration
    without opening files (avoiding both cloud hydration and Windows Defender
    on-open scans).
  - **Never call `GetCompressedFileSizeW` on cloud placeholders** (it opens the
    file and triggers OneDrive Files On-Demand hydration).
  - Inspect `dwFileAttributes` **before** any size, identity, or open call. For
    any entry with `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (`0x00400000`),
    `FILE_ATTRIBUTE_RECALL_ON_OPEN` (`0x00040000`), or `FILE_ATTRIBUTE_OFFLINE`
    (`0x00001000`), or uncertain cloud reparse tags:
    - record `allocatedBytes = 0`,
    - record `apparentBytes` from `FindFirstFileExW` metadata,
    - do **not** open the file and do **not** descend into dataless reparse
      subtrees,
    - add `cloud_placeholders_excluded` to `coverage.partialReasons`, and
    - surface the info-only subgroup **`"Not stored on this disk"`** on the
      default card (never call placeholders "sparse").
  - For local non-placeholder files where allocated size differs from apparent
    size (NTFS compressed or sparse flag set in `dwFileAttributes`) or when
    querying hardlink identity, open the handle strictly with
    `FILE_FLAG_OPEN_NO_RECALL | FILE_FLAG_OPEN_REPARSE_POINT |
    FILE_FLAG_BACKUP_SEMANTICS` and query
    `GetFileInformationByHandleEx(FileStandardInfo)` /
    `GetFileInformationByHandle`.
- **Known Folders, junctions, and long paths:**
  - Query `SHGetKnownFolderPath` via `windows-sys` for `FOLDERID_Pictures`,
    `FOLDERID_Videos`, `FOLDERID_Music`, `FOLDERID_Documents`,
    `FOLDERID_Desktop`, `FOLDERID_Downloads`, `FOLDERID_LocalAppData`,
    `FOLDERID_RoamingAppData`, `FOLDERID_ProgramFiles`,
    `FOLDERID_ProgramFilesX86`, and `FOLDERID_ProgramData`.
  - Walk the exact canonical path returned by `SHGetKnownFolderPath` even when
    the profile-relative directory name is a junction; do **not** follow any
    other reparse point or junction (`FILE_ATTRIBUTE_REPARSE_POINT`).
  - Seal `Program Files`, `Program Files (x86)`, and `WindowsApps` atomically
    as `apps` in Rule 3 before catalog matching.
  - Enable extended-length / long paths (`\\?\` prefix handling and application
    manifest `longPathAware`) so paths deeper than 260 characters are walked
    and accounted accurately.
  - If a Known Folder lives on a different volume than the scan root, record it
    separately as `"on another disk"` without contaminating same-volume
    `System data` math.
  - Volume free/used space via `GetDiskFreeSpaceExW` on the pinned volume.
- **Recycle Bin (reporting and redesigned apply boundary):**
  - Read-only measurement uses `SHQueryRecycleBinW(validatedDriveRoot, &info)`
    for each explicitly reviewed drive (never passing `NULL` or `""`).
  - **Why `SHEmptyRecycleBinW` cannot enforce a confirmed item set:** Passing a
    `NULL` or empty root to `SHEmptyRecycleBinW` empties **every** Recycle Bin
    on every drive. Even with a single validated drive root,
    `SHEmptyRecycleBinW` empties the drive's live bin and cannot enforce the
    exact confirmed item set (files deleted into the Recycle Bin between
    confirmation and apply would be purged without consent).
  - **Required Windows Trash design:** Pin the drive volume GUID/serial and
    invoking user token SID, require a nonempty freshly validated drive root
    named explicitly in the confirmation dialog, and implement **per-item
    verified deletion** over the confirmed snapshot of invoking-user
    `$Recycle.Bin\<SID>` entries on that pinned drive (revalidating each
    entry's identity before removal and skipping new arrivals or replacements).
    Until per-item verified deletion is implemented and tested on Windows CI,
    **Windows Trash remains reporting-only** (no empty action enabled), unless
    the owner later approves a separate decision-log entry for a single-drive
    live-bin confirmation contract that explicitly names the drive and states
    that live arrivals on that drive are included.

### 3.5 Compiled extension table (zero MIME content reads in v1)

| Category    | Representative lowercase ASCII extensions (compiled static match)                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `photos`    | `jpg`, `jpeg`, `png`, `gif`, `webp`, `heic`, `heif`, `avif`, `bmp`, `tif`, `tiff`, `raw`, `cr2`, `cr3`, `nef`, `arw`, `orf`, `rw2`, `dng`, `psd`, `psb`, `xcf`, `svg`, `ico`, `jxl`    |
| `videos`    | `mp4`, `m4v`, `mov`, `mkv`, `avi`, `webm`, `wmv`, `flv`, `mpg`, `mpeg`, `ts`, `mts`, `m2ts`, `vob`, `ogv`, `3gp`, `mxf`, `r3d`, `braw`, `prores`                                       |
| `music`     | `mp3`, `flac`, `wav`, `aif`, `aiff`, `aac`, `m4a`, `ogg`, `opus`, `wma`, `alac`, `ape`, `wv`, `dsf`, `dff`, `mid`, `midi`                                                              |
| `documents` | `pdf`, `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, `odt`, `ods`, `odp`, `rtf`, `txt`, `md`, `markdown`, `csv`, `tsv`, `epub`, `mobi`, `azw3`, `pages`, `numbers`, `key`, `tex`, `org` |

**MIME content reads are dropped from v1.** Opening extensionless files to read
magic bytes risks hydrating cloud files, waking spindown/network storage,
triggering AV scans on Windows, and violating the strict metadata-only contract.
Extensionless files outside known folders, sealed bundles, and recognized
projects classify directly into `other`.

### 3.6 Accounting domains, byte metrics, hardlinks, clones, and sparse files

Three quantities are always kept distinct in protocol, engine, and UI:

1. **Attributed allocation (`allocatedBytes`):** Sum of on-disk block
   allocations (`st_blocks * 512` on Unix; NTFS `AllocationSize` on Windows for
   local non-placeholder files; `0` for cloud placeholders) across walked
   unique inodes.
2. **Volume free/used counters (`volume.totalBytes`, `volume.usedBytes`, `volume.availableBytes`):**
   OS volume accounting (`statvfs` on the APFS Data / mounted volume;
   `GetDiskFreeSpaceExW` on Windows). Kept separate from APFS container
   headroom, snapshots, and `purgeableBytes`.
3. **Reclaim estimates (`spaceAction.estimatedBytes`):** Qualified estimate
   (`"up to N GiB"`) of what removing eligible items may free, noting that
   shared clones, hardlinks, or local snapshots can keep blocks allocated until
   all references and snapshots expire.

| Phenomenon                                          | How `sweep space` handles it                                                                                                                                                                                                                                                                                                                                                                                                                               | Displayed and JSON semantics                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Allocated vs apparent**                           | Attributed allocation leads on local filesystems; `apparentBytes` is accumulated in parallel and never subtracted from allocated volume usage. On network/virtual FS where `st_blocks` is missing or always zero, show apparent bytes and set `allocated_unavailable`.                                                                                                                                                                                     | Headline and bar use `allocatedBytes` when available. JSON always carries both integer byte fields. `--metric apparent` switches display only and never fabricates an allocated residual.                                                                                                                                               |
| **Sparse files**                                    | Allocated blocks report only physically written extents (a 10.00 GiB sparse VM image with 0 allocated blocks reports `0 B` allocated, `10.00 GiB` apparent).                                                                                                                                                                                                                                                                                               | Subgroup detail shows `0 B on disk (10.00 GiB logical)` when `apparent > allocated * 2` and `apparent >= 64 MiB`. Never confuse sparse files with cloud dataless files.                                                                                                                                                                 |
| **Cloud dataless / placeholders**                   | Detected from metadata (`UF_DATALESS`/`SF_DATALESS` on macOS, `FindFirstFileEx` attributes on Windows) without opening. Count `0 B` allocated and directory-metadata `apparentBytes`.                                                                                                                                                                                                                                                                      | Shown in visible info-only subgroup `"Not stored on this disk"` on the default card. Never labeled sparse.                                                                                                                                                                                                                              |
| **Small-file block overhead**                       | `st_blocks * 512` captures 4 KiB cluster rounding (1,000,000 x 128 B files = 3.81 GiB on 4 KiB ext4 blocks, not 122.07 MiB).                                                                                                                                                                                                                                                                                                                               | Prevents phantom "unaccounted space" inflation in `System data`.                                                                                                                                                                                                                                                                        |
| **Hardlinks (`nlink > 1`) under parallel workers**  | Separate `SeenHardlinks` map keyed by `(dev, ino)` (or Windows volume serial + file index) stores the **winning category priority** (from Section 3.1 waterfall) and a deterministic tie-breaker (lowest canonical relative-path hash on equal priority). When parallel workers visit a higher-priority link later, atomically transfer the inode's bytes from the previous owner to the new owner so totals are 100% independent of worker arrival order. | `fileCount` counts unique attributed inodes; `nameCount` (`coverage.scannedNames`) counts directory entries separately. If `maxDedupIdentities` is hit (for example in a pnpm/Bun store), set `hardlink_dedup_cap` **only** (never `clone_or_compression_overlap`), set `bytesKnown: false` on affected categories, and disable review. |
| **CoW clones / reflinks (APFS, Btrfs, XFS, ReFS)**  | Cloned files have distinct inodes and each reports full `st_blocks`. Shared extents can overlap even when `sum(classified) <= volume.usedBytes`, and missing/unreadable entries and clone overlap can occur together. Sweep does not claim exact CoW extent dedupe (and makes no APFS Time Machine hardlink claim, as APFS Time Machine uses snapshots and clones).                                                                                        | If `sum(classified) > volume.usedBytes` without a hardlink cap hit, set `clone_or_compression_overlap`, mark `system_data` `bytesKnown: false` (`invalid_residual`), and show an explicit unknown caveat.                                                                                                                               |
| **Filesystem compression (APFS, Btrfs, ZFS, NTFS)** | `st_blocks * 512` and NTFS `AllocationSize` natively report compressed on-disk bytes.                                                                                                                                                                                                                                                                                                                                                                      | Reconciles with on-disk allocation; still subject to clone/snapshot overlap caveats.                                                                                                                                                                                                                                                    |

### 3.7 Computing "System data" (Unclassified volume usage) honestly

`system_data` represents **Unclassified volume usage**: bytes reported as used
by the volume that were not attributed to the invoking user's other ten
categories (plus other accounts' aggregated totals on `--scope volume`). Sweep
refuses to fabricate this residual when the accounting domains do not match:

- **Only compute a residual when accounting domains match:**
  Requires `scope === "volume"` or `scope === "home"`, a readable same-volume
  `volume` counter (`accountingDomainComparable === true`), allocated bytes
  available (not `allocated_unavailable`), and no `hardlink_dedup_cap`:
  ```text
  classified_same_dev = sum(cat.allocatedBytes for cat != "system_data" on volume_dev)
  raw_residual        = volume.usedBytes - classified_same_dev
  ```
  - If `raw_residual >= 0`: `system_data.allocatedBytes = raw_residual`
    (with `bytesKnown: true` when no unread/overlap caveat invalidates it; when
    `tcc_or_permission` or `permission_denied` occurred, `system_data` retains
    its residual with `bytesKnown: false` and explicitly names the unread
    folders so users know those bytes sit inside the residual).
  - If `raw_residual < 0` (clone/compression overlap exceeded volume used) or
    if `accountingDomainComparable === false` (for example network FS,
    `--metric apparent`, quota/reserved-block mismatch, or `hardlink_dedup_cap`):
    set `system_data.bytesKnown = false`, leave `system_data.allocatedBytes`
    unset (`unknownReason: "invalid_residual"` or `"incomparable_domain"`), and
    display an explicit unknown state rather than fabricating `0 B`.
- **Same-volume OS-shared probes on `home` scope:**
  On `scope === "home"`, Sweep performs a bounded read-only probe of standard
  OS-shared app and system-cache trees on the **same volume** (macOS
  `/Applications`; Linux `/var/lib/flatpak`, `/var/lib/snapd/snaps`,
  `/var/cache/{pacman,apt,dnf}`; Windows `Program Files`, `Program Files
  (x86)`, `ProgramData`) so installed apps are not dumped into `System data`.
- **Honest `System data` sentences (plain sentences, no em dashes):**
  - Standard root volume: `"Unclassified volume usage: OS files, other accounts, and filesystem metadata."`
  - Separate `/home` volume on Linux: `"Unclassified volume usage: other accounts, unread directories, and filesystem metadata."` (Never says `"OS files"`.)
  - When unread TCC folders exist on macOS: `"Unclassified volume usage. Includes unread folders: Documents, Desktop."`
  - When local APFS snapshots exist and are NOT already counted in `purgeableBytes`: `"Includes N local APFS snapshots that hold freed blocks."` (Never double-claims snapshots already inside `purgeableBytes`.)
  - When other users were aggregated on `--scope volume`: `"Unclassified volume usage, including other user accounts and shared folders."`
  - When residual is invalid or incomparable: `"Unclassified volume usage is unknown because shared clones, compression, or volume limits overlap."`
- **On `scope === "path"` (a single folder like `~/Projects`):**
  `system_data` is reported with `bytesKnown: false`,
  `unknownReason: "not_applicable_for_scope"`, totals unset, insight
  `"Not computed for a single folder. Run 'sweep space' on ~ or a volume."`,
  and omitted from the bar and legend.

---

## 4. Performance budget and empirical measurements

### 4.1 Proxy syscall-rate measurements on the current Rust engine

The numbers below measure the existing `sweep-engine` binary (`scan` /
`size_directories`), **not** the future `sweep-engine space` pipeline. They
serve strictly as a **syscall-rate bound** (parallel `read_dir` + `lstat`
overhead): the measured walk does **not** run the 11-category classifier,
parse `/proc/self/mountinfo`, install macOS/Windows no-recall policies, or
maintain a global cross-category hardlink dedup map (current `sweep-fs` sizing
dedupes inodes only inside each apparent-sizing job).

- **Hardware (initial author probe at `a5a1c41`):** 13th Gen Intel Core
  i5-13450HX (16 logical CPUs), 23 GiB RAM, Linux ext4 on NVMe
  (`/dev/nvme1n1p6`) and `tmpfs` (`/tmp`).
- **Corpora generated under `mktemp -d` (removed after measurement; real `~` untouched):**
  - `tmpfs 250k`: 250,000 x 128 B files across 2,500 dirs (10 top-level
    buckets) + 10 x 10 MiB allocated files + 5 x 1 GiB sparse files + 1,000
    hardlinks to one 64 KiB file + sample `node_modules` and `target` = 251,216
    files, 2,516 dirs.
  - `NVMe ext4 1M`: 1,000,000 x 128 B files across 10,000 dirs + 20 x 10 MiB
    allocated files + 10 x 1 GiB sparse files + 1,000 hardlinks (64 KiB) +
    sample `node_modules` and `target` = 1,001,231 files, 10,016 dirs.
  - `tmpfs 55k dirs`: 100 x 550 = 55,101 directories probing queue caps.
- **Independent reviewer verification at `dede206`:**
  Rebuilt release `sweep-engine` and ran `scan` with 10 top-level patterns, no
  selection, and `exact: false` on a fresh generated tmpfs tree (251,016 file
  names, 2,511 dirs): three runs took **294.8 to 327.7 ms** (median **299.4
  ms**), peak RSS **3.48 to 3.80 MiB**. Adding a hardlink in a second bucket
  increased reported total by 65,536 B (confirming per-job dedup only); with
  `exact: true`, the extra 1,000 names in the original bucket added
  65,536,000 B.

| Proxy scenario (`sweep-engine scan`)  | Corpus and FS                     | Profile / options                      | Post-creation run 1 | Median wall (3 runs) |   Min-Max wall | Observed signal                    | Peak RSS | Exit |
| ------------------------------------- | --------------------------------- | -------------------------------------- | ------------------: | -------------------: | -------------: | ---------------------------------- | -------: | ---: |
| `tmpfs_250k_discovery` (`a5a1c41`)    | 251k files, 2.5k dirs (tmpfs)     | `balanced`, default patterns           |             35.3 ms |              27.0 ms |   22.9-35.3 ms | Discovery only (not full stat)     | 3.48 MiB |    0 |
| `tmpfs_250k_full_meta` (`a5a1c41`)    | 251k files, 2.5k dirs (tmpfs)     | `balanced`, 10 top-level buckets       |             63.2 ms |              59.0 ms |   43.2-63.2 ms | Syscall-rate bound only            | 3.55 MiB |    0 |
| `tmpfs_250k_repro` (`dede206`)        | 251,016 names, 2,511 dirs (tmpfs) | `balanced`, 10 patterns, `exact:false` |            327.7 ms |             299.4 ms | 294.8-327.7 ms | Independent reviewer repro         | 3.80 MiB |    0 |
| `disk_1M_full_meta` (`a5a1c41`)       | 1.00M files, 10k dirs (NVMe ext4) | `balanced`, 10 top-level buckets       |            995.7 ms |             220.7 ms | 178.0-995.7 ms | Post-creation run 1 vs warm cache  | 4.03 MiB |    0 |
| `disk_1M_stream` (`a5a1c41`)          | 1.00M files, 10k dirs (NVMe ext4) | `balanced`, `--json-stream`            |            184.8 ms |             184.8 ms | 183.6-205.9 ms | 1st event 1.96 ms (warm cache)     | 4.21 MiB |    0 |
| `tmpfs_55k_dirs_lowmem` (`a5a1c41`)   | 55,101 dirs (tmpfs)               | `low-memory` (2,048 queue cap)         |              8.4 ms |               8.4 ms |              - | Fails fast on cumulative/queue cap | 3.61 MiB |    2 |
| `tmpfs_55k_dirs_balanced` (`a5a1c41`) | 55,101 dirs (tmpfs)               | `balanced` (32,768 queue cap)          |             72.9 ms |              83.8 ms |  72.9-110.0 ms | Completes with 32k queue           | 5.73 MiB |    0 |

#### Key findings from these proxy runs

1. **Proxy runs do not validate final `sweep space` latency or 5M-file gates.**
   Post-creation run 1 (995.7 ms on ext4) still benefits from freshly written
   inodes in the page cache and is not a true cold-cache measurement. Because
   the real `sweep space` walker adds classification, mountinfo parsing,
   no-recall checks, and cross-category hardlink tracking, Phase 2 must publish
   the **fixture generator and benchmark command** under `scripts/` and qualify
   the real `sweep-engine space` pipeline across cold and warm Linux, macOS,
   and Windows runs before locking regression thresholds.
2. **Cumulative `maxDirectories` and small fixed queue caps break on real homes.**
   The 55k-dir probe hit `low-memory`'s `maxQueuedDirs = 2,048` in 8.4 ms
   (exit 2). Real developer homes routinely exceed 300,000 directories.
   `sweep space` therefore uses **live bounded resources with resumable
   directory cursors** (bounded work splitting so wide sibling sets pause and
   resume instead of dropping siblings) and non-fatal degradation when a hard
   cap is reached.
3. **Allocated vs apparent reconciliation (in binary GiB and MiB only):**
   On the 1,001,231-file ext4 corpus, `sweep-engine`'s apparent total was
   `11,079,435,304 B` (**10.32 GiB**): `122.07 MiB` for 1,000,000 x 128 B files
   - `200.00 MiB` for 20 x 10 MiB videos + `10.00 GiB` for 10 x 1 GiB sparse
     images + `64 KiB` for 1,000 hardlinks + `4.04 MiB` for developer artifacts.
     On disk, those 10 sparse images occupy **0 B** while the 1,000,000 x 128 B
     files occupy **3.81 GiB** of 4 KiB blocks. Reporting apparent bytes in a
     whole-disk breakdown would be off by more than **6 GiB** on this single
     fixture.

### 4.2 Coordinated memory budget, targets, and cap behavior

The initial draft's 4 MiB measured RSS came from a walk without a global dedup
map; a 500,000-entry hash map (~12 MiB raw payload, ~20 to 24 MiB with hash
table load factor and allocator slack) plus a 16 MiB queued-path buffer would
exceed 32 MiB. `SpaceLimits` therefore enforces **one coordinated memory
budget** across every retained structure (directory frames, open FDs, queued
paths, `VisitedDirs`, `SeenHardlinks`, top-K subgroups, serialized events, and
host retention):

| Metric (local SSD targets; network homes exempt from wall targets) | `balanced` target                     | `low-memory` target                   | Measurement separation                                               |
| ------------------------------------------------------------------ | ------------------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| Cached instant paint (L4 hit)                                      | **< 50 ms**                           | **< 50 ms**                           | Aggregate-only `space-cache.json` read before spawn                  |
| Time to first live event (`space_started`)                         | **< 20 ms**                           | **< 20 ms**                           | Emitted after root validation and volume stat                        |
| Live progress heartbeat                                            | Every **80 ms** or **16k files**      | Every **120 ms** or **16k files**     | Coalesced atomic snapshot, bounded channel (max 4 in-flight frames)  |
| Peak Rust engine RSS (coordinated budget ceiling)                  | **<= 48 MiB** (typical 8 to 24 MiB)   | **<= 20 MiB** (typical 4 to 12 MiB)   | Accounts for hash-table slack, worker buffers, and transport         |
| Cancellation acknowledgement (`SIGINT` / `Esc`)                    | **< 100 ms** ack (separate from exit) | **< 100 ms** ack (separate from exit) | Prompt UI/CLI ack; worker exit waits on any kernel-blocked syscall   |
| Local SSD wall-time qualification                                  | Qualified in Phase 2/3 bench harness  | Qualified in Phase 2/3 bench harness  | Separate discovery, first data, complete coverage, true cold vs warm |

#### Coordinated `SpaceLimits` and explicit cap behavior

| Retained resource                                    | `balanced` cap (est. RAM incl. slack) | `low-memory` cap (est. RAM incl. slack) | Exact behavior when cap is reached                                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------: | --------------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resumable directory frames & queued path bytes       |          16,384 dirs / 4 MiB (~6 MiB) |             2,048 dirs / 1 MiB (~2 MiB) | Pause sibling fan-out via resumable directory cursors (drain depth-first); if frames still overflow, skip excess and set `queue_cap` (`complete: false`, disable review).                       |
| Open directory FDs across all workers                |                            64 FDs max |                              16 FDs max | Close parent cursor or serialize worker dir open; never exhaust `RLIMIT_NOFILE`.                                                                                                                |
| Cycle/alias table (`VisitedDirs`, dedicated)         |           131,072 dir inodes (~6 MiB) |            32,768 dir inodes (~1.5 MiB) | Never shares space with hardlinks. On cap, refuse further descent into unverified subtrees, set `cycle_cap` (`complete: false`), disable review.                                                |
| Hardlink dedup table (`SeenHardlinks`, dedicated)    |         262,144 file inodes (~16 MiB) |             65,536 file inodes (~4 MiB) | Remaining multi-link files count as upper bound; set `hardlink_dedup_cap` **only** (never `clone_or_compression_overlap`), set affected `bytesKnown: false`, `complete: false`, disable review. |
| Max dirents per single directory (`MAX_DIR_ENTRIES`) |                             4,000,000 |                               4,000,000 | Stop reading runaway dir; mark `unreadable_entries`, `complete: false`, disable review.                                                                                                         |
| Top-K heavy subgroups per category                   |                64 in-memory (16 wire) |                  32 in-memory (16 wire) | Evict smallest subgroup; totals in category accumulators stay exact.                                                                                                                            |
| Serialized event queue & JS host retention           |           4 pending frames (~256 KiB) |             2 pending frames (~128 KiB) | Drop superseded `space_progress` frames under slow consumer; never drop `space_started` or `space_completed`.                                                                                   |

### 4.3 Streaming, cancellation, and L4 cached instant start

- **Streaming partial results:** Workers accumulate lock-free per-worker
  category counters and merge into an atomic snapshot every 80 ms (`balanced`)
  or 120 ms (`low-memory`), emitting `space_progress`. While scanning, the bar
  grows left-to-right and the headline updates with a `~` / `SCANNING` mark;
  the instant `space_completed` lands, motion stops completely. When
  `coverage.complete` is `false`, the card displays a clear partial mark
  (`~` and `Partial scan`) and **disables every review action**, matching the
  stale-cache safety rule.
- **Cancellation (`Esc` vs `q` vs `Ctrl-C`):**
  - In the CLI, `Ctrl-C` (`SIGINT`/`SIGTERM`) sets the cancellation
    `AtomicBool` and acknowledges cancellation immediately (<100 ms).
  - In the TUI, **`Esc` never quits** (UX Principle 2): pressing `Esc` during a
    running scan cancels the scan and returns to the previous view (or stops
    scanning in place when launched directly with `--view space`); **`q`** (or
    `Ctrl-C`) quits the TUI.
  - Cooperative worker checks bail at the next 256-entry boundary and write no
    partial cache. Because a cooperative flag cannot interrupt a kernel-blocked
    syscall (e.g. hung network mount), prompt UI/CLI acknowledgement is tracked
    separately from child-process exit, with bounded teardown timeout.
- **L4 Cached instant start (`<configDir>/space-cache.json`, separate aggregate-only schema):**
  - Does **not** persist a completed `SpaceReport`. Instead, persists a
    dedicated, versioned, path-free **`SpaceCacheSnapshot`** (`cacheVersion:
    "1"`) containing ONLY:
    - `cacheVersion: "1"`,
    - `key`: opaque keyed hash (HMAC-SHA256 with a local `0600` per-install
      salt over `(canonicalTarget, device, inode, scope, platform)`) so even
      the cache key leaks no path,
    - `createdAt`, `scope`, `engine`, `metric`,
    - aggregate `volume` numeric totals (`totalBytes`, `usedBytes`,
      `availableBytes`, `purgeableBytes`, `bytesBasis`,
      `accountingDomainComparable`; **no `mountPoint` or `fsType` path**),
    - `coverage` counts and enum `partialReasons`,
    - fixed 11-item `categories` array with `{ id, allocatedBytes?,
      apparentBytes?, fileCount, nameCount, bytesKnown, unknownReason? }` only
      (**zero `targetDir`, zero action roots, zero subgroup paths, zero project
      basenames, zero free-text warnings**).
  - Stored alongside `size-cache.json` in `sweepConfigDir()` (`0600` POSIX /
    user ACL Windows, `O_NOFOLLOW | O_NONBLOCK`, 256 KiB hard ceiling, atomic
    write-temp-fsync-rename, verifying parent dir ownership).
  - Any live context (target display label, subgroups, validated project roots,
    allowlist instances) is derived strictly in memory during a fresh scan.
  - On launch, `sweep ui --view space` (and `sweep space` unless `--no-cache`)
    paints the cached snapshot with a prominent staleness chip (`Cached 3h ago,
    scanning fresh...`). **Every review and cleanup action stays disabled**
    until a fresh complete scan settles.

---

## 5. Privacy and shareable output

1. **Zero network, zero telemetry:** `sweep space` performs strictly local
   filesystem and OS API reads. No data, hashes, sizes, or diagnostics ever
   leave the machine.
2. **No personal paths in reports, history, journals, receipts, or cache:**
   - `sweep space` never writes to `history.jsonl`.
   - Personal subgroups (`photos`, `videos`, `music`, `documents`, `downloads`,
     `apps`, `system_data`, `other`) emit **type totals only** (never
     filenames), even when `--redact` is **not** set.
   - `space-cache.json` uses the path-free `SpaceCacheSnapshot` format (Section
     4.3) with zero paths, zero mount labels, and zero project names.
   - Trash `.trashinfo` original paths (`Path=`) are display-only in the
     ephemeral Trash confirmation UI (sanitized) and are **never** persisted to
     journals, receipts, history, or caches.
   - Other accounts' directories (`/home/*`, `/Users/*`, `C:\Users\*`,
     `/Users/Shared`, `C:\Users\Public`) are summed into `system_data` with no
     paths, no subgroups, and no actions.
3. **Allowlist-driven redacted transport (`--redact`):**
   Extends [docs/users/privacy.md](../docs/users/privacy.md) using **typed
   field allowlisting** (rather than brittle post-hoc regex replacement) across
   **every output sink**: `--json`, `--json-stream` NDJSON, human stdout, and
   stderr:
   - `targetDir` -> `<home>`, `<volume>`, or `<target>`.
   - `volume.mountPoint` -> `<volume-1>` (and `fsType` restricted to known OS
     FS enum tokens).
   - `space_progress.currentDir` -> omitted completely.
   - `space_warning` and error diagnostics -> emit only fixed typed warning/
     error codes and static template messages (never raw OS error strings
     containing paths, never native-child fallback paths or argv dumps).
   - Subgroup `id` and `label` -> preserve only compiled allowlist display
     names (`Homebrew cache`, `npm cache`), fixed personal type labels
     (`Photos Library`, `HEIC`, `Not stored on this disk`), and fixed Developer
     bucket labels (`Project build artifacts`, `Toolchains & SDKs`, `Source &
     git history`); any non-compiled identifier is replaced with deterministic
     placeholders (`<group-1>`, `<group-2>`).
   - Compiled copy-only owner commands are emitted from static allowlist
     templates (never containing usernames or paths).
   - Actions are disabled on any `redacted: true` payload.
4. **Terminal escape safety:** Every displayed string passes through
   `sanitizeTerminalText` (`packages/protocol`) and `terminal_safe`
   (`sweep-engine-cli`) before reaching any terminal.

---

## 6. UI specification (Terminal 80 / 100 / 120 columns and Website)

### 6.1 Visual identity and 11-category Direction R palette

Preserves Sweep's warm olive-black canvas (`#0b0d08` dark / `#f7f6f0` paper
light) and `meterTrack` (`#1d2216` dark / `#e3e2d6` light) from
[packages/ui/src/theme.ts](../packages/ui/src/theme.ts) and
[apps/docs/src/theme.css](../apps/docs/src/theme.css).

Per [.docs/ux-principles.md](../.docs/ux-principles.md), **chartreuse
(`accent`: `#cdf450` / `#4a6a12`) keeps one job**: focus, the queued mark, and
the primary keycap. Category fills never reuse `accent`, `positive`, `warning`
(`#e2b552` / `#7a5806`), `danger` (`#f47f69` / `#b0372c`), `info` (`#a2b4ca` /
`#46617c`), or `blocked`. Actionable categories use the Direction R cost tokens
(`costInstall`, `costCache`, `costCustom`) and read-only categories use
dedicated `disk*` hues. Every swatch below is verified at **>= 3.0:1** non-text
contrast against `meterTrack` (and >= 4.4:1 on canvas) in both dark and light
themes:

| Category      | Token           | Dark hex  | Contrast vs dark track (`#1d2216`) | Light hex | Contrast vs light track (`#e3e2d6`) | Role / hue family   | Action badge     |
| ------------- | --------------- | --------- | ---------------------------------: | --------- | ----------------------------------: | ------------------- | ---------------- |
| `developer`   | `costInstall`   | `#63c5da` |                             8.15:1 | `#15687a` |                              4.89:1 | Cool cyan           | Developer review |
| `caches`      | `costCache`     | `#6ee7b7` |                            10.66:1 | `#0f766e` |                              4.20:1 | Fresh mint          | Allowlist review |
| `trash`       | `costCustom`    | `#e88bb8` |                             6.82:1 | `#9d2b6b` |                              5.39:1 | Orchid plum         | Separate confirm |
| `apps`        | `diskApps`      | `#94a3f3` |                             6.80:1 | `#3b4fa8` |                              5.62:1 | Periwinkle          | Info only        |
| `photos`      | `diskPhotos`    | `#6cb8e6` |                             7.45:1 | `#1d608c` |                              5.19:1 | Cerulean blue       | Info only        |
| `videos`      | `diskVideos`    | `#c792ea` |                             6.75:1 | `#6d32a8` |                              6.03:1 | Soft violet         | Info only        |
| `music`       | `diskMusic`     | `#f08c9d` |                             6.92:1 | `#a8244a` |                              5.34:1 | Rose                | Info only        |
| `documents`   | `diskDocuments` | `#79b8a9` |                             7.15:1 | `#246b5c` |                              4.84:1 | Sage teal           | Info only        |
| `downloads`   | `diskDownloads` | `#eb9c64` |                             7.33:1 | `#9e4710` |                              4.79:1 | Warm terracotta     | Info only        |
| `system_data` | `diskSystem`    | `#8a8f7e` |                             4.88:1 | `#5b604e` |                              4.99:1 | Warm olive-stone    | Info only        |
| `other`       | `diskOther`     | `#747a6c` |                             3.67:1 | `#63685c` |                              4.40:1 | Neutral slate-olive | Info only        |

### 6.2 Dithered dot-matrix segmented bar (`StackBar` v2)

Shared pure segmentation engine in `packages/ui/src/dot-matrix.ts` and
`packages/ui/src/meter-draw.ts`:

- **Kitty graphics protocol:** 1-row (or 2-row at height >= 28) RGBA capsule
  drawn as a `2x2` pixel dot grid (1 px dot spacing, ordered Bayer dither fade
  across the trailing 4 px of each segment, 2 px ground seam between adjacent
  categories). Non-focused categories dim to `0.32` brightness instantaneously
  when a category is focused in the legend.
- **Non-Kitty cell fallback and `NO_COLOR`:**
  - Color terminals render colored `⣿` cells with a `⣶` trailing dither cell
    and `⠤` in `textDim` for dimmed non-focused segments, enforcing `min 1 cell`
    per non-zero category whenever `activeCategories <= width` (reusing
    `allocateBarCells` from `packages/ui/src/insights.ts`).
  - `NO_COLOR` keeps **every category name on screen** in the legend and pairs
    it with a clear focus caret (`›`) and three simple bar states (focused
    segment `⣿`, other segments `⣶` / `⣤` separated by `⡇` seams, track `⣀`)
    rather than claiming 11 distinct Braille dot densities.
- **Motion discipline ([.docs/ux-principles.md](../.docs/ux-principles.md)):**
  - While scanning: bar fills left-to-right with live category bytes; headline
    updates with `~`; dim mono line shows active `currentDir`.
  - Settled: **zero animation, zero timers.** Moving cursor across categories
    dims non-focused segments instantaneously (0 ms).
  - After a confirmed apply or Trash empty: receipt replaces the subtitle
    (`Freed ~14.2 GiB, disk +13.8 GiB, 168.0 GiB available`), and under motion
    enabled (not `SWEEP_REDUCED_MOTION`), cleared dots extinguish from the
    right edge driven strictly by real engine outcome events.

### 6.3 Terminal UI layouts (80 / 100 / 120 columns)

All layouts obey Sweep's storage-card grammar:

- **One bold headline figure** (`357.8 GiB`) plus dim `of 512 GiB used`. Free
  space (including optional purgeable suffix) stays on the dim line. No extra
  Developer sentence above the bar.
- **One dot bar** directly beneath the headline.
- **Three legend columns** at 80, 100, and 120 columns (using compact sizes
  like `58.4GiB` at 80 columns); two columns only below 72 columns. All 11
  categories including `Other` remain visible.
- **One focused category sentence and one action (`c`):** The focused category
  supplies the only sentence and the only action button in the footer. There
  are zero inline `[Review]` controls in the 100-column list or 120-column
  margin. `Enter` opens details; `c` starts review.
- **Exact terminal cell budget:** Every mock line below is measured in terminal
  cells and fits strictly within **`width - 1`** (<= 119 cells at 120 cols,
  <= 99 cells at 100 cols, <= 79 cells at 80 cols) so no line wraps on the
  right edge.

#### 120 columns x 30 rows (max line width <= 119 cells)

```text
◆ sweep  ~ (home, NVMe 512 GiB)                                                    154.2 GiB free, +28.4 GiB purgeable

357.8 GiB of 512 GiB used                                                                Scanned 1.4M files in 0.9s
⣿⣿⣿⣿⣿⣿⣿⡇⠀⣿⣿⣿⣿⣿⣿⡇⠀⣿⣿⣿⣿⣿⡇⠀⣿⣿⣿⣿⡇⠀⣿⣿⣿⡇⠀⣿⣿⡇⠀⣿⣿⡇⠀⣿⣿⣿⣿⡇⠀⣿⣿⣿⡇⠀⣿⣿⣿⣿⣿⣿⡇⠀⣿

● Apps          58.4 GiB    › ● Developer    48.2 GiB      ● Photos        44.1 GiB  │ Developer (48.2 GiB)
● Videos        39.0 GiB      ● Music        11.2 GiB      ● Documents     14.8 GiB  │ Breakdown (info only unless
● Downloads     18.6 GiB      ● Caches       34.2 GiB      ● Trash         19.4 GiB  │ marked eligible):
● System data   56.5 GiB      ● Other        13.4 GiB                                │  Build artifacts    31.4 GiB
                                                                                     │  Toolchains & SDKs  14.4 GiB
─────────────────────────────────────────────────────────────────────────────────────│  Source & git        2.4 GiB
Developer has 31.4 GiB of build output across 112 projects.     [ c Review Developer ]
 ↑↓←→ category   enter details   c review   r rescan   w projects   ? keys   q quit
```

_(Moving cursor onto `Photos` immediately dims every other bar segment, swaps
the footer sentence to `"Photos: 44.1 GiB. Personal files are info-only. Sweep
never queues or removes them."` with no action button, and renders read-only
type totals such as `"Photos Library"`, `"HEIC"`, and `"Not stored on this
disk"` in the right margin.)_

#### 100 columns x 28 rows (max line width <= 99 cells)

```text
◆ sweep  ~ (home)                                               154.2 GiB free, +28.4 GiB purgeable

357.8 GiB of 512 GiB used                                                       1.4M files in 0.9s
⣿⣿⣿⣿⣿⣿⡇⠀⣿⣿⣿⣿⣿⡇⠀⣿⣿⣿⣿⡇⠀⣿⣿⣿⡇⠀⣿⣿⡇⠀⣿⣿⡇⠀⣿⣿⡇⠀⣿⣿⣿⡇⠀⣿⣿⡇⠀⣿⣿⣿⣿⣿⡇⠀⣿

● Apps          58.4 GiB      › ● Developer    48.2 GiB        ● Photos        44.1 GiB
● Videos        39.0 GiB        ● Music        11.2 GiB        ● Documents     14.8 GiB
● Downloads     18.6 GiB        ● Caches       34.2 GiB        ● Trash         19.4 GiB
● System data   56.5 GiB        ● Other        13.4 GiB

  In Developer:
    Project build artifacts (112 projects)           31.4 GiB   Eligible for Developer review
    Toolchains & SDKs                                14.4 GiB   Info only (owner tool commands)
    Source & git history                              2.4 GiB   Info only

───────────────────────────────────────────────────────────────────────────────────────────────────
Developer has 31.4 GiB of build output across 112 projects.                  [ c Review Developer ]
 ↑↓←→ category   enter details   c review   r rescan   w projects   ? keys   q quit
```

#### 80 columns x 24 rows (3-col legend with compact sizes, max line width <= 79 cells)

```text
◆ sweep  ~                                                       154.2 GiB free

357.8 GiB of 512 GiB used                                            1.4M files
⣿⣿⣿⣿⣿⡇⠀⣿⣿⣿⣿⡇⠀⣿⣿⣿⡇⠀⣿⣿⣿⡇⠀⣿⡇⠀⣿⡇⠀⣿⡇⠀⣿⣿⣿⡇⠀⣿⣿⡇⠀⣿⣿⣿⣿⡇⠀⣿

● Apps        58.4GiB   › ● Developer 48.2GiB     ● Photos     44.1GiB
● Videos      39.0GiB     ● Music     11.2GiB     ● Documents  14.8GiB
● Downloads   18.6GiB     ● Caches    34.2GiB     ● Trash      19.4GiB
● System data 56.5GiB     ● Other     13.4GiB

───────────────────────────────────────────────────────────────────────────────
Developer: 31.4 GiB of build output (112 projects).      [ c Review Developer ]
 ↑↓←→ category   enter details   c review   r rescan   ? keys   q quit
```

#### Narrow (`width < 72`) and short (`height < 20`) fallbacks

- Below 72 columns: switch the legend from 3 columns to 2 columns (keeping all
  11 categories including `Other` visible).
- Below 20 rows: drop the inline `"In <Category>:"` breakdown list first (keep
  headline, bar, legend, single focused sentence + action, and hints). `Enter`
  opens the scrollable detail overlay (clamped to viewport per UX Principle 9).
- Below 40 cols or 12 rows: disable destructive confirmation dialogs until the
  terminal fits (preserving UX Principle 6).
- Partial or stale state (`coverage.complete === false` or `cached === true`):
  prefix the headline with `~`, display `Partial scan` or `Cached Xh ago` on
  the right status text, and disable the review action button until a fresh
  complete scan finishes.

#### Focused category sentence and single action (plain copy, no em dashes)

- **Actionable categories (when complete and fresh):**
  - `Developer`: `"Developer has 31.4 GiB of build output across 112 projects."`
    `[ c Review Developer ]` (always quotes eligible artifact bytes only; when
    an eligible artifact sits inside `Documents`, `Desktop`, or `Downloads`,
    names that parent folder).
  - `Caches`: `"Caches are using 34.2 GiB. Apps rebuild allowlisted caches when they need them."`
    `[ c Review Caches ]`
  - `Trash`: `"Trash holds up to 19.4 GiB of items in Trash. Emptying is permanent and local snapshots may still hold blocks."`
    `[ c Review Trash ]`
- **Info-only categories:**
  - `Photos` (and other personal categories): `"Photos: 44.1 GiB. Personal files are info-only. Sweep never queues or removes them."` (No action button.)
  - Unread macOS TCC folder (e.g. `Documents` with `bytesKnown: false`):
    `"Documents was not read (permission required). Personal files are info-only."`
- Every review button opens a **Review / Confirmation** surface and never
  deletes on click or single `Enter`.
- When nothing actionable exceeds 100 MiB:
  `"Nothing else is worth clearing right now."` (no action button).

### 6.4 Website specification (`apps/docs`)

Adds a prerendered, interactive **Space Storage Card** section on the landing
page (`apps/docs/src/components/landing/`) and a dedicated
`docs/users/space.md` guide, using Sweep's existing CSS tokens
([apps/docs/src/theme.css](../apps/docs/src/theme.css)) and the Direction R +
`disk*` category tokens from Section 6.1:

- **Card container:**
  - Dark surface `oklch(18.5% 0.013 128)` (`--color-fd-popover`), light surface
    `oklch(95.6% 0.008 100)` (`--color-fd-card`), `border-radius: 20px`,
    layered inset hairline highlight and soft ambient shadow.
  - Sunken inner breakdown canvas (`oklch(13% 0.01 128)` dark /
    `oklch(92.5% 0.008 100)` light) with subtle `16px x 16px` radial dot grid
    kept strictly out of body text.
- **Anatomy:**
  1. **Header:** One bold `tabular-nums` display total (`357.8 GiB` + dim
     `of 512 GiB used`) and dim right-aligned `154.2 GiB free`.
  2. **Dithered dot-matrix bar:** `<canvas>` or CSS dot-grid bar (2 px dots on
     4 px pitch) with `aria-hidden="true"` (exact category amounts live in DOM
     text in the legend).
     - **Motion:** Pointer hover may dim non-hovered segments over **150 ms**.
       **Keyboard focus stays instant (0 ms)**, including on the website.
       `prefers-reduced-motion: reduce` snaps immediately (0 ms).
  3. **Responsive legend grid:** 3 columns (`>= 720px`) -> 2 columns
     (`440px-719px`) -> 1 column (`< 440px`, verified at 320 CSS px and 200%
     zoom). Each legend item is a focusable `<button>` showing colored dot,
     category name, and right-aligned `tabular-nums` size.
  4. **Focused breakdown and single CTA footer:** Focused category shows its
     subgroups with plain-language badges (`Info only`, `Comes back on its
     own`, `Check first`, `In Trash`) alongside color. Footer carries one
     sentence and at most one CTA button (`Review Caches` / `Review Developer`)
     that opens the interactive preview dialog and restores focus cleanly to
     the triggering control on close.
- **Single typed data fixture:** Every headline total, free-space number, bar
  share, legend size, and projected post-review receipt is derived
  mathematically from one typed fixture object in `content.ts`, verified by a
  unit test so displayed arithmetic can never drift.
- **Binary units (`GiB`/`MiB`) everywhere** to match the real CLI and TUI. Add
  one sentence in `docs/users/space.md` explaining why Finder shows decimal GB
  while `sweep` shows binary GiB.

---

## 7. Phased implementation plan, tests, and open questions

Follows [.plans/remaining-work.md](remaining-work.md) Working Rules strictly,
especially **Rule 5**: apply-authority changes (revalidation, identity,
confirmation, journals) ship in their own authority-only PRs and are never
bundled with UI, docs, or schema work. Each PR passes `bun run check`,
`bun run rust:check`, and `bun run verify`.

### 7.1 PR-sized implementation phases (authority PRs strictly isolated)

| Phase        | PR scope                                          | Prerequisites           | Deliverables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Apply authority change?                      |
| ------------ | ------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Phase 0a** | Guardrail authority hardening (**own PR**)        | None                    | Prefix-block `/etc`, `/sys`, `/proc`, `/dev`, `/boot`, `/bin`, `/sbin`, `/lib`, `/lib64`, and `C:\Windows` in `assertSafeCwd` (JS + Rust), keeping `/var` and `/usr` exact-match so `/var/www` and `/usr/local` stay valid; harden `SYSTEM_TOOL_DIRS`; harden Windows PATH-only executable resolution; add JS + Rust regression tests.                                                                                                                                                                                                                     | **Yes, authority-only PR** (Rule 5)          |
| **Phase 0b** | Product direction and decision log                | Owner approval of plan  | Apply the proposed edits to `.docs/product-direction.md` and `.docs/decision-log.md` (including the cache direct-delete exception).                                                                                                                                                                                                                                                                                                                                                                                                                        | None (docs only)                             |
| **Phase 1**  | Protocol, schemas, read-only guard, L4 schema     | Phase 0a                | Add `space-report.schema.json`, `space-event.schema.json`, aggregate-only `SpaceCacheSnapshot` schema, TS types (`packages/protocol`), Rust serde types (`crates/sweep-types`), `sweep schema` exports, `assertSafeReadOnlyRoot` (JS + Rust), and typed redaction serializer contract.                                                                                                                                                                                                                                                                     | None (read-only contract)                    |
| **Phase 2**  | Rust `sweep-engine space` and bench harness       | Phase 1                 | Single-pass LIFO space walker with resumable directory cursors in `crates/sweep-fs`; macOS `setiopolicy_np` + TCC pre-pool probe + APFS Data volume + `purgeableBytes = max(0, importantUsage - availableBytes)`; Windows `FindFirstFileEx` no-recall + Known Folders + long paths; Linux XDG/mountinfo/snapshot/autofs/WSL boundaries; sealed bundles before catalog; deterministic parallel hardlink ownership; coordinated `SpaceLimits`; `--capabilities` `spaceReport: true`; published fixture generator and cross-OS bench script under `scripts/`. | None (read-only)                             |
| **Phase 3**  | JS engine parity, CLI `sweep space`, L4 cache     | Phase 2                 | JS fallback `packages/core/src/space-scanner.ts` (same no-recall, bundle-seal, and overlap rules), CLI `sweep space [path]` (`--json`, `--json-stream`, `--redact`, `--metric`, `--no-cache`, zero destructive flags, no `--si`), `packages/display` storage card renderer, path-free `space-cache.json` (L4), shell completions.                                                                                                                                                                                                                          | None (read-only)                             |
| **Phase 4a** | Positive artifact eligibility (**own PR**, S3)    | Phase 0a                | Enforce positive artifact eligibility for Space-to-Developer handoff at both review and apply time in **both** JS and Rust engines; prove protected personal subtrees (including redirected roots and sealed bundles) beat catalog patterns and recursive ancestor selection (mixed subtrees rejected); full adversarial fixture tests.                                                                                                                                                                                                                    | **Yes, authority-only PR** (Rule 5, S3 gate) |
| **Phase 4b** | TUI `SpaceView` and independent Developer handoff | Phase 3, Phase 4a       | Dithered dot-matrix `StackBar` v2, Direction R + `disk*` tokens in `theme.ts`, `SpaceView.tsx` at 80/100/120 cols + narrow/short fallbacks, `sweep ui --view space` + `w` / `Ctrl+K` switcher, independent validated project picker into fresh `ProjectsView` scan (empty queue; zero report paths passed).                                                                                                                                                                                                                                                | None (UI only; reuses Phase 4a boundary)     |
| **Phase 5a** | Cache apply authority (**own PR**)                | Phase 1, G3 containment | Compiled per-OS cache allowlist (`packages/core/src/cache-allowlist.ts` + Rust parity), apply-time trusted-config root re-derivation, identity + volume pinning, ancestor/descendant personal-root exclusion, no-follow/no-cross-mount handle removal, active-process blocking (all selection modes + apply recheck + unknown-state display-only), permanent-delete confirmation contract, journals, copy-only owner command table, destructive fixture tests.                                                                                             | **Yes, authority-only PR** (Rule 5)          |
| **Phase 5b** | Cache review overlay and TUI wiring               | Phase 4b, Phase 5a      | `CacheReviewOverlay.tsx` (`Comes back on its own` / `Check first`, `s` selects only safe regenerable idle rows, `c` opens committed permanent-delete confirm, copy-only command display) wired to Phase 5a authority.                                                                                                                                                                                                                                                                                                                                      | None (UI only)                               |
| **Phase 6a** | Trash apply authority (**own PR**)                | Phase 1, G3 containment | Platform Trash discovery (home + external roots: macOS `.Trashes/<uid>`, Linux sticky non-symlink `.Trash/<uid>` or `.Trash-<uid>`, Windows per-drive bin), verified user + pinned volume identity re-stat + confirmed entry-snapshot removal, `.trashinfo` paths excluded from journals/receipts, Windows per-item verified deletion (or reporting-only gate until verified), destructive fixture tests.                                                                                                                                                  | **Yes, authority-only PR** (Rule 5)          |
| **Phase 6b** | Separate Trash confirm overlay and TUI wiring     | Phase 4b, Phase 6a      | Dedicated `TrashConfirmOverlay.tsx` (permanent-delete warning, `"up to N GiB"`, named volume/drive, snapshot caveat, never bundled with other queues) wired to Phase 6a authority.                                                                                                                                                                                                                                                                                                                                                                         | None (UI only)                               |
| **Phase 7**  | Website card and user docs                        | Phase 4b                | Interactive `SpaceCard` on `apps/docs` landing page (single typed fixture + arithmetic unit tests, 150 ms pointer hover / 0 ms keyboard focus / reduced motion snap), `docs/users/space.md` (with binary GiB vs Finder decimal GB note), updates to `docs/users/privacy.md`, `docs/users/safety.md`, and `docs/users/commands.md`.                                                                                                                                                                                                                         | None (docs and web only)                     |

### 7.2 Verification and test matrix

1. **Per-category, per-OS synthetic fixtures (`packages/test-fixtures/`):**
   - **Linux:** custom `XDG_CONFIG_HOME/user-dirs.dirs` (localized names,
     adversarial `XDG_DESKTOP_DIR="$HOME/"`, and XDG folder pointing outside
     `$HOME` onto another volume), `~/.cache` with allowlisted + non-allowlisted
     dirs + redirected `XDG_CACHE_HOME` pointing to `~/Documents`, FreeDesktop
     Trash (home + sticky `.Trash/<uid>` + non-sticky fallback `.Trash-<uid>`),
     sealed Flatpak/Snap trees containing `node_modules` (must yield 0
     actionable bytes), `~/Projects` with eligible artifacts and source/media,
     sparse `.img`, cross-category hardlink web under parallel workers,
     snapshot trees (`.zfs`, `.snapshots`), unreadable `chmod 000` dir,
     ANSI-escape filename, multi-user `/home/other-user` volume-scope fixture.
   - **macOS (unit + hosted macOS CI):** `.app` and `.framework` bundles
     containing Electron `node_modules` and `.png`/`.wav` assets (must classify
     as `apps` with **zero** actionable Developer bytes), `*.photoslibrary`
     sealed as `photos`, TCC pre-pool probe returning `EPERM` (`bytesKnown:
     false`, totals unset, `tcc_or_permission`, System data names unread
     folder), skipped privacy containers (verify zero `open`/`read_dir` calls
     on Mail/Messages/Safari), APFS Data volume parity (`sweep space /` ==
     `sweep space ~`), `purgeableBytes = max(0, importantUsage - availableBytes)`,
     native File Provider dataless test verifying **zero** hydration/recall and
     visible `"Not stored on this disk"` subgroup.
   - **Windows (unit + hosted Windows CI):** Known Folders (including a
     profile-relative junction resolved via `SHGetKnownFolderPath`), non-Known-
     Folder junction (never followed), sealed `Program Files` / `WindowsApps`
     containing `node_modules` (0 actionable bytes), long paths deeper than 260
     characters, `%LOCALAPPDATA%\Temp` marked `Check first` (never bulk
     selected), native OneDrive / cloud-placeholder fixture that **fails if the
     placeholder file gains any local disk allocation**, per-drive Recycle Bin
     query.
2. **Accounting domain and hardlink tests:**
   - Below-capacity clone/reflink overlap, above-capacity overlap
     (`invalid_residual`), hardlinks spanning multiple categories under parallel
     workers (asserting identical deterministic attribution across repeated
     runs), `hardlink_dedup_cap` (asserting `clone_or_compression_overlap` is
     NOT emitted), redirected off-volume Known Folders, separate `/home` volume
     wording, quota / reserved-block residual cases, and network FS zero
     `st_blocks` (`allocated_unavailable`).
3. **Guardrail, authority, and non-queueability tests (BOTH JS and Rust engines):**
   - Prove `assertSafeCwd` refuses `~`, `/`, `C:\`, `C:\Windows\System32`,
     `/etc/ssh`, `/bin/sh`, `/System/Library` while allowing `/var/www/app` and
     `/usr/local/src/app`.
   - Prove `sweep space /` as `root` with `SUDO_UID` unset exits 2, and with a
     non-root user sums other homes, `/Users/Shared`, and `C:\Users\Public`
     into `system_data` with no paths, no subgroups, and no actions.
   - Prove `SpaceReport` JSON is rejected by `loadPlan` and `sweep apply --plan`.
   - Test full **report -> UI -> apply** Developer handoff with forged report
     hints, custom patterns, an artifact-shaped personal folder (e.g.
     redirected Documents named `target`), and a **mixed subtree** (a
     candidate directory containing a protected personal subtree).
   - Prove forged cache plans with personal paths, non-allowlisted paths,
     redirected env conflicts, symlink swaps, mount-boundary swaps, or
     process-state transitions (idle -> active before apply, or unknown process
     state) are refused in both engines.
   - Prove Trash apply rejects drive remapping, volume device-ID drift, symlink-
     swapped Trash roots, non-sticky `.Trash` parents, and files arriving after
     confirmation (new arrivals remain untouched; `.trashinfo` original paths
     never appear in journals or receipts).
4. **Redaction and privacy tests across every sink:**
   - Run distinctive sentinel usernames, folder names, mount labels, and paths
     through `--json --redact`, `--json-stream --redact`, human stdout
     `--redact`, stderr (including cancellation and native-child fallback
     diagnostics), and `space-cache.json`, asserting zero sentinel leakage.
5. **Engine parity tests:**
   - Normalized JS-vs-Rust `SpaceReport` diff on shared fixtures verifying
     identical category assignments, allocated/apparent totals, hardlink
     ownership, `bytesKnown` states, and `system_data` behavior.
6. **TUI, Web, and benchmark qualification:**
   - PTY tests at `80x24`, `100x28`, `120x30`, `70x24`, `80x16`, `NO_COLOR=1`,
     and `SWEEP_REDUCED_MOTION=1` measuring every rendered line in terminal
     cells (`<= width - 1`), verifying 3-col legend at 80/100/120, `Esc`
     unwinding without quitting, `Space`/`a`/`s` no-op on overview, `c` review
     disabled on partial/stale/redacted cards, and separate Trash confirmation.
   - Web tests for `SpaceCard` arithmetic derivation, focus restore on modal
     close, 150 ms pointer hover vs 0 ms keyboard focus, reduced-motion snap,
     320 px mobile viewport, 200% zoom, and >= 3:1 swatch contrast in light and
     dark themes.
   - Published benchmark harness (`scripts/bench-space.ts`) run over generated
     wide/deep trees, unique hardlink webs, slow consumers (backpressure), and
     blocked I/O on Linux (true cold + warm), macOS, and Windows before locking
     regression gates.

### 7.3 Open questions for the owner

Both the correctness review and the platform review converged on the same
recommendations for all five questions. Each is recorded below as **Recommended
(owner to confirm)**:

1. **`sweep ui ~` invocation:**
   - **Recommended (owner to confirm):** Keep refusing `sweep ui ~`; ship
     `sweep space` and `sweep ui --view space` as the only entrypoints. Bare
     `sweep ui <path>` already means project cleanup review guarded by
     `assertSafeCwd`, so keeping home-wide space walks explicit avoids merging
     a guardrail and a full-home walk into the same command. Consider aliasing
     later only after the space view is qualified and proven unable to
     construct a `ScanPlan`.
2. **Developer source code vs build artifacts in `Developer`:**
   - **Recommended (owner to confirm):** Count source files, `.git`, and
     project media inside a recognized project root under `Developer` as an
     **info-only** subgroup (never queued, and not also counted under Videos or
     Documents). Files already inside Pictures, Music, Movies, Documents,
     Downloads, or Desktop stay in those personal categories unless they are
     verified eligible catalog artifacts (and contain no protected personal
     subtree). Review sentences and `estimatedBytes` quote **eligible artifact
     bytes only**, never total Developer footprint.
3. **Cache deletion vs Trash:**
   - **Recommended (owner to confirm):** Delete verified `"Comes back on its
     own"` cache leaves directly after an explicit permanent-delete
     confirmation that states bytes are removed permanently (not moved to
     Trash) and that local snapshots may still hold the blocks. Offer no Trash
     toggle for caches (moving caches to Trash frees 0 bytes on the same volume
     and Trash has its own flow). Check-first rows, including `win-user-temp`,
     stay opt-in. Never run `sudo`. Record this cache-specific exception in
     `.docs/decision-log.md` against the current UX reversibility convention.
4. **macOS Spotlight (`mdfind`):**
   - **Recommended (owner to confirm):** No Spotlight in v1. Ship the
     filesystem walk and compiled extension table across all OSes. Revisit
     optional insight-only enrichment only after native no-recall tests pass,
     off by default and never altering byte totals.
5. **Binary units (`GiB`/`MiB`) vs `--si`:**
   - **Recommended (owner to confirm):** Binary `GiB`/`MiB` only across CLI,
     TUI, and website; JSON in integer bytes; no `--si` flag. Add one sentence
     in `docs/users/space.md` explaining macOS Finder's decimal GB display.

---

## 8. Review resolution

Tracks every finding from the correctness review and the platform review
(`6087425602`) at commit `dede206`, where the revised plan handles it, and any
item deliberately deferred.

| ID    | Review      | Severity   | Finding summary                                                                                                                                                                                          | Handled in plan                              | Deliberately deferred / notes                                                                                                     |
| ----- | ----------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| C-B1  | Correctness | Blocker    | Keep report data out of Developer apply path; enforce positive artifact eligibility & mixed-subtree blocks                                                                                               | §§1.2, 2.1, 2.2, 3.1, 7.1 (Phase 4a/4b), 7.2 | None. `targetRoots` and subgroup `path` removed; independent project picker + dual-engine positive eligibility required.          |
| C-B2  | Correctness | Blocker    | Bounded cache leaves, apply-time identity/scope/owner-activity rechecks, copy-only owner commands                                                                                                        | §§1.2, 1.3, 2.2, 7.1 (Phase 5a), 7.2         | Executing owner-tool primitives deferred; all owner commands are copy-only in v1 (any future execution requires compiled `argv`). |
| C-B3  | Correctness | Blocker    | Bind Trash confirmation to verified user, volume identity, and confirmed item set; redesign Windows path                                                                                                 | §§1.2, 3.3, 3.4, 7.1 (Phase 6a), 7.2         | Windows Trash stays reporting-only until per-item verified deletion lands (or owner logs an explicit live-bin exception).         |
| C-B4  | Correctness | Blocker    | No-recall policy before first FS op (macOS `setiopolicy_np`, Windows enumeration); drop MIME reads in v1                                                                                                 | §§2.4, 3.1, 3.2, 3.4, 3.5, 7.2               | MIME magic-byte content probes dropped from v1 to guarantee zero content reads and zero cloud hydration.                          |
| C-B5  | Correctness | Blocker    | Separate path-free L4 cache format; disable actions on stale/incomplete/redacted; redact all sinks                                                                                                       | §§2.2, 4.3, 5, 7.1 (Phase 1/3), 7.2          | None. Dedicated `SpaceCacheSnapshot` schema and typed field allowlisting across JSON, NDJSON, stdout, and stderr.                 |
| C-B6  | Correctness | Blocker    | Split authority changes from UI under Rule 5; make S3 & G3 explicit prerequisites                                                                                                                        | §7.1 (Phases 0a/0b, 4a/4b, 5a/5b, 6a/6b)     | None. Phase 0, 4, 5, and 6 split into isolated authority-only PRs and follow-up docs/UI PRs.                                      |
| C-S1  | Correctness | Should-fix | Separate accounting domains; Unclassified volume usage residual; unknown state; deterministic hardlinks                                                                                                  | §§1.1, 2.2, 3.6, 3.7, 7.2                    | Exact CoW extent dedupe remains out of scope (requires root or per-file `FIEMAP`); overlap is surfaced explicitly as unknown.     |
| C-S2  | Correctness | Should-fix | Qualify real pipeline; publish fixture generator & bench command; label proxy & post-creation runs                                                                                                       | §§4.1, 4.2, 7.1 (Phase 2), 7.2               | Fixed wall-time regression gates (e.g. 150 ms / 5M targets) deferred until real `sweep-engine space` is benchmarked cross-OS.     |
| C-S3  | Correctness | Should-fix | Coordinated memory budget; split cycle state from hardlinks; resumable cursors; separate cancel ack/exit                                                                                                 | §§2.4, 4.2, 4.3, 7.2                         | None. `VisitedDirs` separated from `SeenHardlinks`; resumable cursors and explicit cap degradation specified.                     |
| C-N1  | Correctness | Nit        | Cite UX §3 and §5 committed-dialog rules; change "Already deleted" to "In Trash"                                                                                                                         | §§1.2, 2.2, 6.4                              | None.                                                                                                                             |
| P-B1  | Platform    | Blocker    | Seal bundles (`.app`, `.framework`, `.photoslibrary`, Flatpak, Snap, Program Files, WindowsApps) early                                                                                                   | §§1.1, 3.1 (Rule 3), 3.2, 3.3, 3.4, 7.2      | None. Bundle sealing moved ahead of catalog, cache, and extension rules; Electron `node_modules` fixture added.                   |
| P-B2  | Platform    | Blocker    | macOS privacy containers skipped; pre-pool TCC probe; `bytesKnown: false` (unset total) on `EPERM`                                                                                                       | §§2.2, 3.1, 3.2, 3.7, 6.3, 7.2               | None. Unreadable known folders never show `0 GiB`; `tcc_or_permission` added and named in `System data`.                          |
| P-B3  | Platform    | Blocker    | Windows: no `GetCompressedFileSizeW` on placeholders; `FindFirstFileEx` + `FILE_FLAG_OPEN_NO_RECALL`; single-drive Trash                                                                                 | §§3.4, 7.2                                   | See C-B3 for Windows Trash reporting-only gate until per-item verified deletion is qualified.                                     |
| P-B4  | Platform    | Blocker    | Volume scope stays inside invoking user; refuse root without `SUDO_UID`; other homes/Shared/Public to System data                                                                                        | §§2.3, 3.1 (Rule 1), 3.7, 5, 7.2             | None. Other accounts contribute an aggregate byte total only with no paths, no subgroups, and no actions.                         |
| P-B5  | Platform    | Blocker    | `purgeableBytes = max(0, importantUsage - availableBytes)`; read APFS Data volume; no snapshot double-claim                                                                                              | §§2.2, 3.2, 3.7, 7.2                         | None. `sweep space /` and `sweep space ~` share the APFS Data volume totals.                                                      |
| P-B6  | Platform    | Blocker    | Ignore `ownerCommand` on input; compiled `argv` per `allowlistId` with no shell; `pacman`/`apt`/`dnf` copy-only, never `sudo`                                                                            | §§1.2, 1.3, 2.2, 7.1 (Phase 5a)              | All owner commands are copy-only in v1; compiled `argv` contract governs any future non-copy-only owner primitive.                |
| P-S7  | Platform    | Should-fix | Waterfall-ordered parallel hardlink ownership; `hardlink_dedup_cap` only; drop APFS Time Machine claim; RAM budget                                                                                       | §§3.6, 4.2, 7.2                              | None. Winning category stored on inode identity with atomic transfer on higher-priority hit.                                      |
| P-S8  | Platform    | Should-fix | Explicit category-overlap table; pnpm store labelling; replace `isPersonalRootTarget`; artifact-only `estimatedBytes`                                                                                    | §§1.2, 1.3, 2.2, 3.1                         | None. 7-row overlap table shared by classifier and apply guard.                                                                   |
| P-S9  | Platform    | Should-fix | Walk boundaries: skip snapshots, autofs, nested tmpfs/overlay (keep container root), WSL `/mnt/c`, network FS `st_blocks`, off-volume XDG, bind mounts, separate `/home`, Windows junctions & >260 paths | §§3.1, 3.3, 3.4, 3.6, 3.7, 7.2               | None.                                                                                                                             |
| P-S10 | Platform    | Should-fix | External trash roots per OS/uid; volume re-stat at confirm & apply; "up to N GiB" + snapshot caveat                                                                                                      | §§1.2, 3.2, 3.3, 3.4, 6.3, 7.2               | None.                                                                                                                             |
| P-S11 | Platform    | Should-fix | Mark `win-user-temp` (`%LOCALAPPDATA%\Temp`) as Check first (opt-in only), keep locked-file skip                                                                                                         | §§1.2, 1.3, 2.1, 7.2                         | None.                                                                                                                             |
| P-S12 | Platform    | Should-fix | Visible info-only subgroup `"Not stored on this disk"` for dataless/placeholder files; not "sparse"                                                                                                      | §§3.2, 3.4, 3.6, 6.3, 7.2                    | None.                                                                                                                             |
| P-S13 | Platform    | Should-fix | Direction R (`costInstall`/`costCache`/`costCustom`) + `disk*` tokens; >= 3:1 on `meterTrack` incl. `other`                                                                                              | §6.1, §7.2                                   | None. Zero reuse of chartreuse/warning/danger/info; all 11 swatches verified >= 3.67:1 on `meterTrack`.                           |
| P-S14 | Platform    | Should-fix | Card grammar (1 number, 1 sentence, 1 action), `c` review / `Enter` details, 3-col legend at 80/100/120, `Esc` never quits, mocks <= `width - 1`, `NO_COLOR` clarity, no em dashes                       | §§1.2, 2.1, 4.3, 6.2, 6.3, 7.2               | None. Every mock line verified in terminal cells (<= 79, <= 99, <= 119).                                                          |
| P-S15 | Platform    | Should-fix | Label §4.1 as syscall-rate bound; rewrite reconciliation in GiB/MiB only; partial card disables review                                                                                                   | §§2.1, 4.1, 4.3, 6.3                         | Fixed latency gate deferred to Phase 2/3 real-pipeline benchmark qualification (see C-S2).                                        |
| P-S16 | Platform    | Should-fix | Make `statusLabel` optional (unset for Developer); personal subgroups are type totals with no filenames                                                                                                  | §§2.2, 5, 6.3                                | None.                                                                                                                             |
| P-N17 | Platform    | Nit        | Remove absent `F03`/`F07` IDs; spell OS prefix-block list (`/etc`..`C:\Windows`), keep `/var` & `/usr`                                                                                                   | §§1.2, 7.1 (Phase 0a), 7.2                   | None. Also removed absent `F09`, `A08`, `A15`, and local `.reference/clove-storage-*` references.                                 |
| P-N18 | Platform    | Nit        | Website pointer hover 150 ms; keyboard focus instant (0 ms); reduced motion snaps immediately                                                                                                            | §6.4, §7.2                                   | None.                                                                                                                             |
| Q1-Q5 | Both        | Open Qs    | Record consensus answers as "Recommended (owner to confirm)" (refuse `sweep ui ~`, Developer source info-only, direct cache delete, no Spotlight in v1, binary GiB/MiB only)                             | §§1.5, 2.1, 3.2, 6.4, 7.3                    | Awaiting final owner confirmation before Phase 0b / Phase 1 implementation begins.                                                |
