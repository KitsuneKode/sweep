Status: planned
Scope: product, protocol, engine, core, cli, ui, docs
Created: 2026-11-27
Updated: 2026-11-27 (rev 3)
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
`~`) and **G3** (platform handle-relative destructive containment), and
integrates **L4** (cached instant start with visible staleness) from
[.plans/remaining-work.md](remaining-work.md).

---

## 1. Product shape and trust rules

### 1.1 Category taxonomy (11 mutually exclusive buckets)

Every attributed allocated byte inside a walked invoking-user root is assigned
to **exactly one** of eleven categories (zero double counting across
categories). Walked attribution, volume free/used counters, and reclaim
estimates are tracked as separate quantities (Section 3.6).

| #   | Protocol ID   | Label       | What belongs here                                                                                                                               | Actionability                                                       |
| --- | ------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | `apps`        | Apps        | Sealed app bundles (`.app`, `.framework`, Flatpak, Snap, Program Files, WindowsApps), non-cache app data                                        | **Info only**                                                       |
| 2   | `developer`   | Developer   | Eligible project build artifacts (`node_modules`, `target`, `.next`, ...) outside personal roots and sealed bundles, toolchains/SDKs, proj. src | **Developer review** (artifacts only, `space_handoff`) + copy hints |
| 3   | `photos`      | Photos      | Pictures folder (incl. redirected root), sealed `*.photoslibrary` packages, image formats outside projects and bundles                          | **Info only**                                                       |
| 4   | `videos`      | Videos      | Movies/Videos folder (incl. redirected root), screen recordings, video formats outside projects and bundles                                     | **Info only**                                                       |
| 5   | `music`       | Music       | Music folder (incl. redirected root), audio libraries, audio formats outside projects and bundles                                               | **Info only**                                                       |
| 6   | `documents`   | Documents   | Documents and Desktop folders (incl. redirected roots), office/PDF/book/text formats outside projects and bundles                               | **Info only**                                                       |
| 7   | `downloads`   | Downloads   | User Downloads directory (incl. redirected root; installers, archives, saved files; type-only subgroup totals)                                  | **Info only**                                                       |
| 8   | `system_data` | System data | Unclassified volume usage residual only when accounting domains are proved comparable (incl. other accounts already within volume used)         | **Info only**                                                       |
| 9   | `caches`      | Caches      | Verified regenerable OS/app/package-manager cache leaves (compiled allowlist, excluding generic temp dirs) and OS cache containers              | **Allowlisted cache review** (verified compiled leaves only)        |
| 10  | `trash`       | Trash       | Invoking user's Trash / Recycle Bin on the walked volume(s)                                                                                     | **Separate Trash confirm** (Windows reporting-only until verified)  |
| 11  | `other`       | Other       | Remaining files inside the walked invoking-user root (VM images, game saves, unknown blobs)                                                     | **Info only**                                                       |

### 1.2 Non-negotiable trust rules

1. **Personal files are strictly information-only forever.**
   `photos`, `videos`, `music`, `documents`, and `downloads` (plus `apps`,
   `system_data`, and `other`) can **never** be queued, placed into a
   `ScanPlan`, or removed by `sweep`. This is enforced at four independent
   layers:
   - **Protocol:** `SpaceReport` is a read-only document (`readOnly: true`)
     with no `selectedCandidateIds`, no actionable file paths, and no executable
     command strings. Its schema uses discriminated unions (Section 2.2) so
     personal categories cannot carry actionable `actionability` values and
     mismatched `spaceAction` category/intent pairs are unrepresentable.
     `loadPlan` and `sweep apply --plan` reject `SpaceReport` documents
     unconditionally.
   - **Core planner (JS) and Rust engine:** Both `guardrails.ts` and
     `crates/sweep-engine/src/guardrails.rs` keep `assertSafeCwd` unchanged for
     destructive commands (`scan`, `clean`, `plan`, `apply`). A separate
     read-only guard (`assertSafeReadOnlyRoot`) permits `~` and volume roots
     **only** for `sweep space`. Classification, UI review, and both apply
     engines enforce the single authoritative category-overlap table in
     Section 3.1 so the classifier and apply boundary always agree: protected
     personal roots (including redirected XDG / Known-Folder roots) and sealed
     bundles strictly win over catalog matching, cache matching, and recursive
     ancestor selection.
   - **TUI:** On the space overview, `Space`, `a`, `s`, `x`, and `d` do nothing.
     Attempting to select or delete an `info_only` category flashes a plain
     notice: `Personal files are info-only. Sweep never queues or removes them.`
     All destructive flows obey [.docs/ux-principles.md](../.docs/ux-principles.md)
     Section 3 (**every apply confirms**; nothing destructive is automatic) and
     Section 5 (confirmation requires a **committed dialog** for the current
     item set; elapsed time cannot arm unseen consent). Overlay availability,
     targets, and selections are derived strictly from trusted live review
     state, never from serialized report JSON or cached snapshots.
   - **Apply boundary:** `sweep-engine apply` and JS `applyPlan` only accept
     explicit `ScanPlan` (developer artifacts, carrying `policyProfile:
     "space_handoff"` when initiated from Space), `CacheCleanPlan` (concrete
     reviewed instances matched to compiled allowlist templates and re-verified
     at apply time), or `TrashEmptyRequest` (verified user, volume identity,
     and confirmed item snapshot). A forged JSON report or plan cannot smuggle
     a personal path through any lane.

2. **Three and only three action classes exist:**
   - **Class A: Developer artifacts (independent project scan, `space_handoff` policy, G3 containment).**
     The report never passes serialized paths (`targetRoots` or subgroup
     `path` values) into a cleanup scan or `ScanPlan`. `spaceAction` carries
     only the fixed discriminated intent `{ category: "developer", intent:
     "developer_review" }`. When the user opens Developer review (`c` on
     Developer), the UI requires the user to choose a validated project root
     independently (from live validated project discovery filtered to the
     invoking user, or an explicit user-chosen project path) and starts a
     **fresh `ProjectsView` scan** with an **empty queue** under explicit
     additive policy mode **`policyProfile: "space_handoff"`** (stored on
     `ScanPlan`, `ScanOptions`, and `ApplyRequest` under `protocolVersion: "1"`,
     default `"standard"` for existing commands).
     All existing protections apply verbatim (`assertSafeCwd`, S1 context
     checks, VCS and git-tracked file blocks, filesystem-identity pinning,
     `maxSizeGB`, and committed confirmation). In addition, because S1 alone
     only demotes mismatches to `dangerous` (which remains manually selectable)
     and existing apply revalidation checks containment, type, and identity
     rather than generated-output eligibility, **`policyProfile:
     "space_handoff"`** is enforced in review, preserved through `loadPlan` and
     saved-plan handling, and re-derived at apply time in **both** JS and Rust
     engines:
     - **Positive artifact eligibility:** The candidate must positively match a
       recognized generated-output artifact rule with valid project context
       (strictly outside sealed bundles, protected personal roots, tool homes,
       and system prefixes).
     - **Protected personal roots and sealed bundles strictly win:** Pictures,
       Videos/Movies, Music, Documents, Downloads, and Desktop (including
       redirected XDG / Known-Folder roots), plus sealed bundles (`.app`,
       `.framework`, `*.photoslibrary`, Flatpak, Snap, `Program Files`,
       `Program Files (x86)`, `WindowsApps`), beat catalog patterns and
       recursive ancestor selection. Any candidate **inside** a protected
       personal root or sealed bundle, OR **containing** one (mixed subtree),
       OR equal to a redirected personal root is rejected in both review and
       apply. If the policy cannot positively prove that the entire candidate
       subtree is eligible generated output, leave it out of the Space review.
     - **Invoking-user ownership:** Verified in the independent project picker
       and in both apply engines, even when running elevated (Section 3.1).
     - **G3 handle-relative containment prerequisite:** Phase 4a/4b cannot ship
       until **G3** handle-relative containment (`openat2` `RESOLVE_BENEATH |
       RESOLVE_NO_XDEV | RESOLVE_NO_SYMLINKS` on Linux, `openat` + `O_NOFOLLOW`
       on macOS, parent-handle Win32 open rejecting reparse points on Windows)
       is enforced on the `space_handoff` apply path.
     - **Fail-closed capability gate (no silent fallback):** Rust advertises
       `"spaceHandoffApply": true` in `--capabilities` once Phase 4a + G3 land.
       If an older native binary lacks `"spaceHandoffApply": true`, or if the
       selected backend cannot enforce `space_handoff` eligibility and G3
       containment, apply refuses with `EXIT.GUARDRAIL` (2) and **never**
       silently falls back to ordinary or older apply authority.
     - **Developer toolchains** (`~/.rustup/toolchains`, `~/go/pkg/mod`, Docker
       images, Xcode Simulators) are never raw-deleted by `sweep`; they remain
       `info_only` with compiled copy-only owner-tool commands (e.g.
       `docker system prune`, `xcrun simctl delete unavailable`,
       `rustup toolchain list`).
   - **Class B: Verified regenerable cache leaves (compiled per-OS allowlist, instance-bound consent).**
     Only audited, verified regenerable cache leaves present in Sweep's
     compiled, versioned per-OS cache allowlist (Section 1.3) may enter cache
     review. Every other directory inside `~/.cache`, `~/Library/Caches`, or
     `%LOCALAPPDATA%` stays **`info_only`**. **General-purpose temporary
     directories (such as Windows `%LOCALAPPDATA%\Temp`, `%TEMP%`, and `/tmp`)
     are excluded from the deletion allowlist and stay strictly `info_only`**
     because they can hold the only copy of an unlocked user file or an
     installer in progress; opt-in selection and locked-file skips cannot
     establish regenerability. Only audited application-owned cache leaves that
     satisfy the restart-exclusion rule may be added.
     Each allowlisted entry carries:
     - a stable internal `allowlistId` (the report never passes an executable
       path or shell command),
     - a plain-language reason,
     - an explicit rebuild badge: **`Comes back on its own`** (refills silently
       on next run; eligible for `s` cache bulk-select inside Cache Review) or
       **`Check first`** (verified regenerable cache that is slow to
       re-download or clears an offline store, such as Gradle, Playwright, or
       Hugging Face; never bulk-selected, requires explicit per-instance opt-in),
     - a strict active-process check: if the owning app or any helper process
       is active, block **every** selection mode (both bulk and manual per-row
       selection) and mark the row `in use, close app first`; if process-state
       detection fails or is restricted (unknown process state), keep the row
       **display-only** (never selectable),
     - **instance-bound confirmation (including wildcard profiles):**
       Confirmation never binds to a category or a wildcard pattern alone. For
       every discovered concrete cache instance (including each profile matched
       by a wildcard template such as Firefox `Profiles/*/cache2` or Chrome/Edge
       `User Data\*\Cache`), review captures an explicit instance record pinning
       `(allowlistId, invokingUserId, canonicalInstancePath, rootIdentity,
       volumeIdentity)`. Confirmation binds strictly to the exact reviewed
       instance records selected by the user.
     - **apply-time re-derivation and G3 containment:** Right before removal,
       both engines re-derive the allowed template roots from trusted OS
       configuration (never from report JSON), verify each confirmed instance
       still matches its exact reviewed `allowlistId`, invoking user, canonical
       path, root identity, and volume (refusing any re-resolved replacement,
       symlink swap, or newly discovered wildcard profile instance not present
       in the confirmed review set), verify the path is neither an ancestor nor
       a descendant of any personal root or sealed bundle (conflicting redirects
       or unverifiable targets stay display-only), re-run the active-process
       check, require a cooperative lock or documented safe owner primitive
       where mid-removal app restart cannot be ruled out (aborting or skipping
       on `in_use`), and traverse strictly with G3 no-follow, no-cross-mount
       handle primitives (`openat2` `RESOLVE_BENEATH | RESOLVE_NO_XDEV |
       RESOLVE_NO_SYMLINKS` on Linux, `openat` + `O_NOFOLLOW` on macOS,
       parent-handle Win32 open rejecting reparse points on Windows).
     - **Direct removal and confirmation:** Verified `"Comes back on its own"`
       cache leaves delete directly (no Trash toggle, since moving caches to
       Trash on the same volume frees 0 bytes) behind an explicit
       permanent-delete confirmation naming each reviewed instance, stating
       that bytes are removed permanently (not moved to Trash), and noting that
       local snapshots may still hold the blocks. Owner-tool commands in v1 are
       **copy-only** (never spawned, never run `sudo`). If a future revision
       ever executes a documented safe owner primitive, it must dispatch
       strictly from a compiled `argv` table keyed by `allowlistId` with direct
       exec (no shell), ignoring any string on input; `pacman`, `apt`, `dnf`,
       and `brew cleanup` stay copy-only permanently.
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

3. **S3 and G3 guardrail prerequisites (`.plans/remaining-work.md`):**
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
   - Require **S3** positive per-item eligibility and **G3** handle-relative
     containment before shipping any destructive Space review UI (Developer
     handoff Phase 4b, Cache review Phase 5b, or Trash confirm Phase 6b).

### 1.3 Explicit per-OS regenerable cache allowlist

Only audited, verified regenerable cache leaves in this compiled allowlist can
enter Class B cache review. Root-owned system package caches (`pacman`, `apt`,
`dnf`) and broad owner tools (`brew cleanup`, `pnpm store prune`, `yay -Sc` /
`paru -Sc`) are **copy-only**: Sweep measures them (when readable without
privilege escalation) and displays the compiled command string for the user to
run themselves, never spawning a shell and never running `sudo`.

For wildcard profile templates (such as Firefox `Profiles/*/cache2`, Chrome
`User Data\*\Cache`, Edge `User Data\*\Cache`, and Mesa `mesa_shader_cache*`),
review and confirmation bind strictly to each concrete discovered profile
instance `(allowlistId, user, canonicalPath, rootIdentity, volumeIdentity)`,
never to the wildcard template as a whole.

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
| `macos-gradle-caches`    | `~/.gradle/caches`                              | Gradle        | **Check first**       | Downloaded JARs and build transforms; slow to re-download offline                                              | Sweep bounded remove (opt-in per instance; block if `java`/`gradle` running)    |
| `macos-cocoapods-cache`  | `~/Library/Caches/CocoaPods`                    | CocoaPods     | Comes back on its own | Downloaded pod specs and archives                                                                              | Sweep bounded remove (block if `pod` running)                                   |
| `macos-playwright-cache` | `~/Library/Caches/ms-playwright`                | Playwright    | **Check first**       | Downloaded headless browser binaries; requires `playwright install` to restore                                 | Sweep bounded remove (opt-in per instance; block if browser running)            |
| `macos-chrome-cache`     | `~/Library/Caches/Google/Chrome`                | Chrome        | Comes back on its own | Web asset and shader cache (preserves profiles, logins, bookmarks)                                             | Sweep bounded remove (block if Chrome or helpers running)                       |
| `macos-firefox-cache`    | `~/Library/Caches/Firefox/Profiles/*/cache2`    | Firefox       | Comes back on its own | Browser HTTP disk cache (preserves profiles; pinned per profile instance)                                      | Sweep bounded remove (block if Firefox running)                                 |
| `macos-electron-code`    | `~/Library/Application Support/Code/CachedData` | VS Code       | Comes back on its own | V8 bytecode caches rebuilt on editor start                                                                     | Sweep bounded remove (block if Code or helpers running)                         |
| `macos-hf-cache`         | `~/.cache/huggingface/hub`                      | Hugging Face  | **Check first**       | Multi-GiB downloaded ML model weights; very slow to re-download                                                | Sweep bounded remove (opt-in per instance only)                                 |

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
| `linux-gradle-caches`    | `~/.gradle/caches`                                        | Gradle          | **Check first**       | Downloaded JVM artifacts; slow to re-download                                                                | Sweep bounded remove (opt-in per instance; block if `java`/`gradle` running)   |
| `linux-thumbnails`       | `$XDG_CACHE_HOME/thumbnails` (`~/.cache/thumbnails`)      | Desktop         | Comes back on its own | File-manager image and video preview thumbnails                                                              | Sweep bounded remove                                                           |
| `linux-mesa-shader`      | `$XDG_CACHE_HOME/mesa_shader_cache*`                      | Mesa GPU        | Comes back on its own | Compiled OpenGL/Vulkan shaders; rebuilt on next launch (pinned per directory instance)                       | Sweep bounded remove                                                           |
| `linux-chrome-cache`     | `$XDG_CACHE_HOME/google-chrome` / `chromium`              | Chrome/Chromium | Comes back on its own | Browser HTTP/GPU cache (profiles stay in `~/.config`)                                                        | Sweep bounded remove (block if Chrome/Chromium or helpers running)             |
| `linux-firefox-cache`    | `$XDG_CACHE_HOME/mozilla/firefox/*/cache2`                | Firefox         | Comes back on its own | Browser HTTP cache (profiles stay in `~/.mozilla`; pinned per profile instance)                              | Sweep bounded remove (block if Firefox running)                                |
| `linux-playwright-cache` | `$XDG_CACHE_HOME/ms-playwright`                           | Playwright      | **Check first**       | Headless browser binaries; needs `playwright install`                                                        | Sweep bounded remove (opt-in per instance; block if browser running)           |
| `linux-yay-paru-cache`   | `$XDG_CACHE_HOME/yay` & `$XDG_CACHE_HOME/paru/clone`      | AUR helpers     | **Check first**       | Cloned AUR build trees and built `.pkg.tar.zst` files                                                        | Copy-only command: `yay -Sc` / `paru -Sc`                                      |
| `linux-hf-cache`         | `$XDG_CACHE_HOME/huggingface/hub`                         | Hugging Face    | **Check first**       | Multi-GiB ML model weights; slow to re-download                                                              | Sweep bounded remove (opt-in per instance only)                                |
| `linux-pacman-cache`     | `/var/cache/pacman/pkg`                                   | pacman          | **Check first**       | System package cache (root-owned; Sweep never runs `sudo`)                                                   | Copy-only command: `sudo paccache -r`                                          |
| `linux-apt-cache`        | `/var/cache/apt/archives`                                 | apt             | **Check first**       | System `.deb` package cache (root-owned; Sweep never runs `sudo`)                                            | Copy-only command: `sudo apt clean`                                            |
| `linux-dnf-cache`        | `/var/cache/dnf` / `/var/cache/libdnf5`                   | dnf             | **Check first**       | System RPM metadata and package cache (root-owned; Sweep never runs `sudo`)                                  | Copy-only command: `sudo dnf clean all`                                        |

#### Windows allowlist

| ID                     | Canonical path template                            | Owner        | Status badge          | Reason                                                                                                       | Mechanism                                                                          |
| ---------------------- | -------------------------------------------------- | ------------ | --------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `win-npm-cache`        | `%LOCALAPPDATA%\npm-cache`                         | npm          | Comes back on its own | npm download cache                                                                                           | Sweep bounded remove (block if `npm`/`node` running npm)                           |
| `win-bun-cache`        | `%USERPROFILE%\.bun\install\cache`                 | Bun          | Comes back on its own | Global Bun package cache                                                                                     | Sweep bounded remove (block if `bun.exe` running)                                  |
| `win-pnpm-store`       | `%LOCALAPPDATA%\pnpm\store`                        | pnpm         | **Check first**       | Shared content-addressed hardlink store; `pnpm store prune` removes unreferenced packages without wiping all | Copy-only command: `pnpm store prune`                                              |
| `win-yarn-cache`       | `%LOCALAPPDATA%\Yarn\Cache`                        | Yarn         | Comes back on its own | Cached Yarn archives                                                                                         | Sweep bounded remove (block if `yarn` running)                                     |
| `win-pip-cache`        | `%LOCALAPPDATA%\pip\Cache`                         | pip          | Comes back on its own | Cached Python wheels                                                                                         | Sweep bounded remove (block if `pip.exe` running)                                  |
| `win-uv-cache`         | `%LOCALAPPDATA%\uv\cache`                          | uv           | Comes back on its own | Cached Python wheels and tool archives                                                                       | Sweep bounded remove (block if `uv.exe` running); copy-only hint `uv cache clean`  |
| `win-cargo-cache`      | `%USERPROFILE%\.cargo\registry\cache`              | Cargo        | Comes back on its own | Downloaded `.crate` tarballs                                                                                 | Sweep bounded remove (block if `cargo.exe` running)                                |
| `win-go-build-cache`   | `%LOCALAPPDATA%\go-build`                          | Go           | Comes back on its own | Compiled Go build cache                                                                                      | Sweep bounded remove (block if `go.exe` running); copy-only hint `go clean -cache` |
| `win-nuget-http`       | `%LOCALAPPDATA%\NuGet\v3-cache`                    | NuGet        | Comes back on its own | NuGet HTTP metadata cache                                                                                    | Sweep bounded remove (block if `dotnet.exe`/`nuget.exe` running)                   |
| `win-gradle-caches`    | `%USERPROFILE%\.gradle\caches`                     | Gradle       | **Check first**       | Downloaded JVM artifacts; slow to re-download                                                                | Sweep bounded remove (opt-in per instance; block if `java.exe`/`gradle` running)   |
| `win-playwright-cache` | `%LOCALAPPDATA%\ms-playwright`                     | Playwright   | **Check first**       | Headless browser binaries; needs `playwright install`                                                        | Sweep bounded remove (opt-in per instance; block if browser running)               |
| `win-chrome-cache`     | `%LOCALAPPDATA%\Google\Chrome\User Data\*\Cache`   | Chrome       | Comes back on its own | Browser HTTP cache (profiles and logins untouched; pinned per profile instance)                              | Sweep bounded remove (block if `chrome.exe` or helpers running)                    |
| `win-edge-cache`       | `%LOCALAPPDATA%\Microsoft\Edge\User Data\*\Cache`  | Edge         | Comes back on its own | Browser HTTP cache (profiles and logins untouched; pinned per profile instance)                              | Sweep bounded remove (block if `msedge.exe` or helpers running)                    |
| `win-firefox-cache`    | `%LOCALAPPDATA%\Mozilla\Firefox\Profiles\*\cache2` | Firefox      | Comes back on its own | Browser HTTP cache (pinned per profile instance)                                                             | Sweep bounded remove (block if `firefox.exe` running)                              |
| `win-dx-shader`        | `%LOCALAPPDATA%\D3DSCache`                         | DirectX      | Comes back on its own | Compiled GPU shader cache; rebuilt on next launch                                                            | Sweep bounded remove                                                               |
| `win-hf-cache`         | `%USERPROFILE%\.cache\huggingface\hub`             | Hugging Face | **Check first**       | Multi-GiB ML model weights                                                                                   | Sweep bounded remove (opt-in per instance only)                                    |

_(Note: General-purpose Windows `%LOCALAPPDATA%\Temp` (previously drafted as
`win-user-temp`) and any other general-purpose temp directory such as `%TEMP%`
or `/tmp` are intentionally **excluded from the deletion allowlist** and kept
strictly **`info_only`** inside `caches`. Because a general-purpose temp
directory can hold the only copy of an unlocked user file or an active
installer, opt-in selection and locked-file skips do not prove regenerability.
Only audited application-owned cache leaves that satisfy the restart-exclusion
rule may be added to the allowlist.)_

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
  or removed in either engine or the TUI. Protected personal folders (including
  redirected roots) and sealed app/photo bundles strictly win over catalog
  matching, cache matching, and ancestor selection.
- **Only three action classes are permitted**, each with G3 handle-relative
  containment and its own confirmation boundary: (1) Developer project
  artifacts via an independent fresh project scan running under
  `policyProfile: "space_handoff"` (positive artifact eligibility enforced in
  review, saved plans, and both apply engines with no silent fallback); (2) a
  compiled, versioned, per-OS allowlist of verified regenerable cache leaves
  (excluding general-purpose temp directories), bound per concrete reviewed
  instance with strict running-app blocking; and (3) emptying the OS Trash
  behind a separate permanent-delete confirmation bound to the invoking user,
  pinned volume identity, and confirmed item set (Windows Trash stays
  reporting-only until verified per-item deletion lands).
- **Cache direct-delete exception against UX reversibility convention.**
  Verified "Comes back on its own" cache leaves delete directly after an
  explicit permanent-delete confirmation (stating that bytes are removed rather
  than moved to Trash and that local snapshots may still hold blocks), with no
  Trash toggle because moving caches to local Trash frees 0 bytes on the same
  volume and Trash has its own flow. Check-first allowlisted caches (such as
  Gradle, Playwright, and Hugging Face) stay opt-in per instance; generic temp
  directories (including Windows `%LOCALAPPDATA%\Temp`) remain info-only.
  Owner-tool commands (`pacman`, `apt`, `dnf`, `brew cleanup`, `pnpm store
  prune`) are copy-only; `sweep` never spawns `sudo`.
- **Allocated bytes lead, in binary GiB/MiB only.** Space reports count
  attributed disk allocation alongside apparent bytes, keep walked totals,
  volume counters, and reclaim estimates distinct, and install fail-closed
  no-recall protection before the first filesystem operation (zero MIME content
  reads in v1). `System data` reports unclassified volume usage only when
  accounting domains are proved comparable (non-CoW local volumes); CoW volumes
  and partially resident placeholders mark unprovable totals explicitly
  unknown rather than fabricating figures.
- **Zero telemetry and aggregate-only caching.** Nothing leaves the machine.
  L4 cached instant-start snapshots use a separate aggregate-only schema with
  no file paths, mount labels, or project names, and disable every action until
  a fresh complete scan settles. `--redact` serializes only closed, allowlisted
  fields and static message templates across JSON, NDJSON, stdout, and stderr.
```

---

## 2. CLI surface, protocol schemas, exit codes, and Rust engine reuse

### 2.1 CLI surface (`apps/cli`)

#### New command: `sweep space [path]`

Read-only category breakdown that leaves the scanned tree untouched (never
modifies, moves, or deletes any scanned file). Unless `--no-cache` is passed,
it writes only an aggregate-only, path-free snapshot to
`<configDir>/space-cache.json` (Section 4.3). Uses binary units (`GiB`, `MiB`,
`KiB`, `B`) only in human output and integer bytes in JSON (no `--si` flag).

```text
sweep space [path] [options]

Arguments:
  [path]                          Directory or mount to report (default: ~)

Options:
  --scope <home|volume|path>      Reporting scope (default: home when [path]
                                  omitted or equals ~; volume for / or drive
                                  root; path for any other directory)
  --metric <allocated|apparent>   Primary displayed byte metric (default:
                                  allocated; JSON includes both integer byte
                                  fields whenever bytesKnown is true, and omits
                                  unknown byte fields when bytesKnown is false)
  --json                          Emit final SpaceReport JSON document
  --json-stream                   Emit NDJSON SpaceEvent lifecycle stream
  --redact                        Serialize only closed anonymized fields and
                                  static templates across all output sinks
  --no-cache                      Ignore and do not write cached snapshot
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
(`357.8 GiB` + dim `of 512 GiB used`), a dim free-space line (with qualified
estimated purgeable suffix on macOS when available), one segmented dot bar, a
3-column category legend, and one sentence with the exact next command (such as
`Run: sweep ui --view space` or `sweep ui ~/Projects`).

#### TUI integration (`sweep ui`)

- **`sweep ui ~` remains refused** by `assertSafeCwd` (with a clear hint
  pointing to `sweep space` or `sweep ui --view space ~`). Bare `sweep ui
  <path>` continues to mean project cleanup review only.
- **`sweep ui --view space [path]`** extends `--view <projects|full|space>` in
  `apps/cli/src/cli.ts`. When `--view space` is selected (defaulting `[path]`
  to `~`), the target is validated through `assertSafeReadOnlyRoot` (and
  invoking-user account isolation) and cannot construct a `ScanPlan`.
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
  - `c` opens the review surface for the focused actionable category (derived
    from live trusted review state, never from report JSON):
    - On `Developer`: opens the independent project picker (live validated
      invoking-user project roots, never paths serialized in a report or
      cache), which launches a fresh `ProjectsView` scan with an **empty
      queue** under `policyProfile: "space_handoff"`.
    - On `Caches`: opens the Allowlisted Cache Review overlay populated from
      live allowlist discovery (entries start unselected; `s` selects only
      `"Comes back on its own"` concrete instances that are idle and have
      verified process state; `"Check first"` allowlisted leaves such as
      Gradle, Playwright, and Hugging Face require explicit per-instance
      opt-in; active-process or unknown process-state instances cannot be
      selected in any mode; generic temp directories are never listed as
      deletable; `c` opens the instance-bound permanent-delete confirm dialog).
    - On `Trash`: opens the dedicated Trash confirmation overlay (separate from
      every other queue, naming the exact pinned volume or drive; unavailable on
      Windows while Windows Trash remains reporting-only).
  - On the Space overview itself, `Space`, `a`, `s`, `x`, and `d` do nothing
    and show a one-line notice (matching UX Principle 7).
  - **Fail-closed action gating (incomplete coverage vs scope exclusions):**
    Review (`c`) is disabled whenever `report.cached` is `true`,
    `report.coverage.complete` is `false` (any `coverage.incompleteReasons`
    present), `report.redacted` is `true`, or the focused actionable category
    has `bytesKnown: false`. Normal deliberate `coverage.scopeExclusions` (such
    as ordinary iCloud/OneDrive placeholders in personal folders or an external
    drive on another mount) do **not** set `coverage.complete: false` and do
    **not** block independently validated local review actions, because each
    review lane independently re-validates its own local, non-placeholder,
    same-user targets.

### 2.2 Additive, versioned protocol and JSON Schema additions

All additions live in `packages/protocol/` and `crates/sweep-types/` under
`protocolVersion: "1"` (additive, non-breaking per `remaining-work.md` Rule 6).
`sweep schema` exports two new optional keys alongside the existing four:

```json
{
  "protocolVersion": "1",
  "schemas": {
    "scanPlan": { "...": "unchanged (plus optional policyProfile: standard | space_handoff)" },
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
`0 <= n <= 9007199254740991`, `additionalProperties: false` everywhere). Both
`spaceCategory` and `spaceAction` use discriminated unions (`oneOf`) so
personal categories can never carry non-`info_only` actionability and
mismatched action/category pairs are unrepresentable in Draft 2020-12.

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
        "estimatedPurgeableBytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "snapshotCount": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
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
        "incompleteReasons",
        "scopeExclusions",
        "accountingCaveats"
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
        "incompleteReasons": {
          "type": "array",
          "maxItems": 16,
          "uniqueItems": true,
          "items": {
            "enum": [
              "permission_denied",
              "tcc_or_permission",
              "hardlink_dedup_cap",
              "cycle_cap",
              "queue_cap",
              "unreadable_entries",
              "no_recall_policy_unavailable",
              "cancelled"
            ]
          }
        },
        "scopeExclusions": {
          "type": "array",
          "maxItems": 16,
          "uniqueItems": true,
          "items": {
            "enum": [
              "cloud_placeholders_excluded",
              "other_volumes_excluded",
              "wsl_windows_drives_excluded",
              "snapshot_trees_excluded",
              "virtual_or_autofs_excluded",
              "privacy_containers_excluded"
            ]
          }
        },
        "accountingCaveats": {
          "type": "array",
          "maxItems": 16,
          "uniqueItems": true,
          "items": {
            "enum": [
              "clone_or_compression_overlap",
              "allocated_unavailable",
              "placeholder_allocation_unknown",
              "cow_unproved_domain"
            ]
          }
        }
      },
      "allOf": [
        {
          "if": { "properties": { "complete": { "const": true } } },
          "then": { "properties": { "incompleteReasons": { "maxItems": 0 } } },
          "else": { "properties": { "incompleteReasons": { "minItems": 1 } } }
        }
      ]
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
    "nonNegInt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "unknownReason": {
      "enum": [
        "tcc_or_permission",
        "hardlink_dedup_cap",
        "incomparable_domain",
        "invalid_residual",
        "placeholder_allocation_unknown",
        "not_applicable_for_scope"
      ]
    },
    "spaceSubgroupBase": {
      "type": "object",
      "required": [
        "id",
        "label",
        "allocatedKnown",
        "apparentBytes",
        "fileCount",
        "nameCount",
        "actionability"
      ],
      "allOf": [
        {
          "if": { "properties": { "allocatedKnown": { "const": true } } },
          "then": { "required": ["allocatedBytes"] },
          "else": { "not": { "required": ["allocatedBytes"] } }
        }
      ]
    },
    "infoOnlySubgroup": {
      "allOf": [{ "$ref": "#/$defs/spaceSubgroupBase" }],
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "minLength": 1, "maxLength": 128 },
        "label": { "type": "string", "minLength": 1, "maxLength": 256 },
        "allocatedKnown": { "type": "boolean" },
        "allocatedBytes": { "$ref": "#/$defs/nonNegInt" },
        "apparentBytes": { "$ref": "#/$defs/nonNegInt" },
        "fileCount": { "$ref": "#/$defs/nonNegInt" },
        "nameCount": { "$ref": "#/$defs/nonNegInt" },
        "actionability": { "const": "info_only" },
        "reason": { "type": "string", "maxLength": 512 }
      }
    },
    "developerSubgroup": {
      "allOf": [{ "$ref": "#/$defs/spaceSubgroupBase" }],
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "minLength": 1, "maxLength": 128 },
        "label": { "type": "string", "minLength": 1, "maxLength": 256 },
        "allocatedKnown": { "type": "boolean" },
        "allocatedBytes": { "$ref": "#/$defs/nonNegInt" },
        "apparentBytes": { "$ref": "#/$defs/nonNegInt" },
        "fileCount": { "$ref": "#/$defs/nonNegInt" },
        "nameCount": { "$ref": "#/$defs/nonNegInt" },
        "actionability": {
          "enum": ["info_only", "developer_cleanup", "owner_tool_copy_only"]
        },
        "allowlistId": { "type": "string", "minLength": 1, "maxLength": 128 },
        "reason": { "type": "string", "maxLength": 512 }
      }
    },
    "cacheSubgroup": {
      "allOf": [{ "$ref": "#/$defs/spaceSubgroupBase" }],
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "minLength": 1, "maxLength": 128 },
        "label": { "type": "string", "minLength": 1, "maxLength": 256 },
        "allocatedKnown": { "type": "boolean" },
        "allocatedBytes": { "$ref": "#/$defs/nonNegInt" },
        "apparentBytes": { "$ref": "#/$defs/nonNegInt" },
        "fileCount": { "$ref": "#/$defs/nonNegInt" },
        "nameCount": { "$ref": "#/$defs/nonNegInt" },
        "actionability": {
          "enum": ["info_only", "allowlisted_cache", "owner_tool_copy_only"]
        },
        "allowlistId": { "type": "string", "minLength": 1, "maxLength": 128 },
        "rebuildStatus": {
          "enum": ["comes_back", "check_first", "info_only"]
        },
        "reason": { "type": "string", "maxLength": 512 },
        "processState": { "enum": ["idle", "in_use", "unknown"] }
      }
    },
    "trashSubgroup": {
      "allOf": [{ "$ref": "#/$defs/spaceSubgroupBase" }],
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "minLength": 1, "maxLength": 128 },
        "label": { "type": "string", "minLength": 1, "maxLength": 256 },
        "allocatedKnown": { "type": "boolean" },
        "allocatedBytes": { "$ref": "#/$defs/nonNegInt" },
        "apparentBytes": { "$ref": "#/$defs/nonNegInt" },
        "fileCount": { "$ref": "#/$defs/nonNegInt" },
        "nameCount": { "$ref": "#/$defs/nonNegInt" },
        "actionability": { "enum": ["info_only", "trash_empty"] },
        "reason": { "type": "string", "maxLength": 512 }
      }
    },
    "categoryByteIntegrity": {
      "allOf": [
        {
          "if": { "properties": { "bytesKnown": { "const": true } } },
          "then": {
            "required": ["allocatedBytes", "apparentBytes"],
            "not": { "required": ["unknownReason"] }
          },
          "else": {
            "required": ["unknownReason"],
            "not": { "required": ["allocatedBytes"] }
          }
        },
        {
          "if": {
            "properties": {
              "unknownReason": {
                "enum": [
                  "tcc_or_permission",
                  "incomparable_domain",
                  "invalid_residual",
                  "not_applicable_for_scope"
                ]
              }
            },
            "required": ["unknownReason"]
          },
          "then": { "not": { "required": ["apparentBytes"] } }
        }
      ]
    },
    "spaceCategory": {
      "oneOf": [
        {
          "allOf": [{ "$ref": "#/$defs/categoryByteIntegrity" }],
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
            "id": {
              "enum": [
                "apps",
                "photos",
                "videos",
                "music",
                "documents",
                "downloads",
                "system_data",
                "other"
              ]
            },
            "label": { "type": "string", "minLength": 1, "maxLength": 64 },
            "allocatedBytes": { "$ref": "#/$defs/nonNegInt" },
            "apparentBytes": { "$ref": "#/$defs/nonNegInt" },
            "fileCount": { "$ref": "#/$defs/nonNegInt" },
            "nameCount": { "$ref": "#/$defs/nonNegInt" },
            "bytesKnown": { "type": "boolean" },
            "unknownReason": { "$ref": "#/$defs/unknownReason" },
            "actionability": { "const": "info_only" },
            "insight": { "type": "string", "maxLength": 512 },
            "subgroups": {
              "type": "array",
              "maxItems": 16,
              "items": { "$ref": "#/$defs/infoOnlySubgroup" }
            }
          }
        },
        {
          "allOf": [{ "$ref": "#/$defs/categoryByteIntegrity" }],
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
            "id": { "const": "developer" },
            "label": { "type": "string", "minLength": 1, "maxLength": 64 },
            "allocatedBytes": { "$ref": "#/$defs/nonNegInt" },
            "apparentBytes": { "$ref": "#/$defs/nonNegInt" },
            "fileCount": { "$ref": "#/$defs/nonNegInt" },
            "nameCount": { "$ref": "#/$defs/nonNegInt" },
            "bytesKnown": { "type": "boolean" },
            "unknownReason": { "$ref": "#/$defs/unknownReason" },
            "actionability": {
              "enum": ["info_only", "developer_cleanup", "owner_tool_copy_only"]
            },
            "insight": { "type": "string", "maxLength": 512 },
            "subgroups": {
              "type": "array",
              "maxItems": 16,
              "items": { "$ref": "#/$defs/developerSubgroup" }
            }
          }
        },
        {
          "allOf": [{ "$ref": "#/$defs/categoryByteIntegrity" }],
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
            "id": { "const": "caches" },
            "label": { "type": "string", "minLength": 1, "maxLength": 64 },
            "allocatedBytes": { "$ref": "#/$defs/nonNegInt" },
            "apparentBytes": { "$ref": "#/$defs/nonNegInt" },
            "fileCount": { "$ref": "#/$defs/nonNegInt" },
            "nameCount": { "$ref": "#/$defs/nonNegInt" },
            "bytesKnown": { "type": "boolean" },
            "unknownReason": { "$ref": "#/$defs/unknownReason" },
            "actionability": {
              "enum": ["info_only", "allowlisted_cache", "owner_tool_copy_only"]
            },
            "insight": { "type": "string", "maxLength": 512 },
            "subgroups": {
              "type": "array",
              "maxItems": 16,
              "items": { "$ref": "#/$defs/cacheSubgroup" }
            }
          }
        },
        {
          "allOf": [{ "$ref": "#/$defs/categoryByteIntegrity" }],
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
            "id": { "const": "trash" },
            "label": { "type": "string", "minLength": 1, "maxLength": 64 },
            "allocatedBytes": { "$ref": "#/$defs/nonNegInt" },
            "apparentBytes": { "$ref": "#/$defs/nonNegInt" },
            "fileCount": { "$ref": "#/$defs/nonNegInt" },
            "nameCount": { "$ref": "#/$defs/nonNegInt" },
            "bytesKnown": { "type": "boolean" },
            "unknownReason": { "$ref": "#/$defs/unknownReason" },
            "actionability": { "enum": ["info_only", "trash_empty"] },
            "insight": { "type": "string", "maxLength": 512 },
            "subgroups": {
              "type": "array",
              "maxItems": 16,
              "items": { "$ref": "#/$defs/trashSubgroup" }
            }
          }
        }
      ]
    },
    "spaceAction": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "category",
            "intent",
            "estimatedBytes",
            "sentence",
            "buttonLabel",
            "requiresConfirmation"
          ],
          "properties": {
            "id": { "type": "string", "minLength": 1, "maxLength": 128 },
            "category": { "const": "developer" },
            "intent": { "const": "developer_review" },
            "estimatedBytes": { "$ref": "#/$defs/nonNegInt" },
            "sentence": { "type": "string", "minLength": 1, "maxLength": 512 },
            "buttonLabel": { "type": "string", "minLength": 1, "maxLength": 64 },
            "requiresConfirmation": { "const": true }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "category",
            "intent",
            "estimatedBytes",
            "statusLabel",
            "allowlistIds",
            "sentence",
            "buttonLabel",
            "requiresConfirmation"
          ],
          "properties": {
            "id": { "type": "string", "minLength": 1, "maxLength": 128 },
            "category": { "const": "caches" },
            "intent": { "const": "cache_review" },
            "estimatedBytes": { "$ref": "#/$defs/nonNegInt" },
            "statusLabel": { "enum": ["Comes back on its own", "Check first"] },
            "allowlistIds": {
              "type": "array",
              "minItems": 1,
              "maxItems": 32,
              "uniqueItems": true,
              "items": { "type": "string", "minLength": 1, "maxLength": 128 }
            },
            "sentence": { "type": "string", "minLength": 1, "maxLength": 512 },
            "buttonLabel": { "type": "string", "minLength": 1, "maxLength": 64 },
            "requiresConfirmation": { "const": true }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "category",
            "intent",
            "estimatedBytes",
            "statusLabel",
            "sentence",
            "buttonLabel",
            "requiresConfirmation"
          ],
          "properties": {
            "id": { "type": "string", "minLength": 1, "maxLength": 128 },
            "category": { "const": "trash" },
            "intent": { "const": "trash_review" },
            "estimatedBytes": { "$ref": "#/$defs/nonNegInt" },
            "statusLabel": { "const": "In Trash" },
            "sentence": { "type": "string", "minLength": 1, "maxLength": 512 },
            "buttonLabel": { "type": "string", "minLength": 1, "maxLength": 64 },
            "requiresConfirmation": { "const": true }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "category",
            "intent",
            "estimatedBytes",
            "allowlistIds",
            "sentence",
            "buttonLabel",
            "requiresConfirmation"
          ],
          "properties": {
            "id": { "type": "string", "minLength": 1, "maxLength": 128 },
            "category": { "enum": ["developer", "caches"] },
            "intent": { "const": "owner_command_copy" },
            "estimatedBytes": { "$ref": "#/$defs/nonNegInt" },
            "statusLabel": { "enum": ["Comes back on its own", "Check first"] },
            "allowlistIds": {
              "type": "array",
              "minItems": 1,
              "maxItems": 32,
              "uniqueItems": true,
              "items": { "type": "string", "minLength": 1, "maxLength": 128 }
            },
            "sentence": { "type": "string", "minLength": 1, "maxLength": 512 },
            "buttonLabel": { "type": "string", "minLength": 1, "maxLength": 64 },
            "requiresConfirmation": { "const": false }
          }
        }
      ]
    }
  }
}
```

Key structural invariants enforced by this schema:

1. `"readOnly": { "const": true }`: cannot be confused with an executable
   `ScanPlan`.
2. **Mismatched action/category pairs are unrepresentable:** `spaceAction` is a
   `oneOf` discriminated union keyed by `category` and `intent`. A validator
   rejects `category: "developer"` with `intent: "trash_review"`, rejects
   `allowlistIds` on `developer_review` or `trash_review`, rejects `statusLabel`
   on `developer_review`, and rejects any action targeting a personal category.
   No `targetRoots`, subgroup `path`, or executable `ownerCommand` field exists
   anywhere in the schema.
3. **Personal categories are locked to `info_only`:** `spaceCategory` uses
   `oneOf` so `apps`, `photos`, `videos`, `music`, `documents`, `downloads`,
   `system_data`, and `other` require `actionability: "info_only"` on both the
   category and every subgroup.
4. **Honest unknown byte representation:** When `bytesKnown` is `false` on a
   category (for example, an unread macOS TCC folder, an unproved CoW or
   invalid `system_data` residual, or a partially resident placeholder whose
   local allocation is unknown), `allocatedBytes` is omitted and
   `unknownReason` is required (and `apparentBytes` is also omitted when unread
   or incomparable, while retained when directory metadata is known for cloud
   placeholders). On `spaceSubgroup`, `allocatedKnown: false` omits
   `allocatedBytes` rather than fabricating `0`.
5. **Completeness separated from scope exclusions:** `coverage.complete` is
   strictly coupled to `coverage.incompleteReasons` being empty, separate from
   `coverage.scopeExclusions` and `coverage.accountingCaveats`.
6. **Personal subgroups never keep filenames**, including before `--redact`.
   Subgroups under `photos`, `videos`, `music`, `documents`, `downloads`,
   `apps`, `system_data`, and `other` are strictly type or bucket totals (such
   as `"Photos Library"`, `"HEIC"`, `"MP4"`, `"Not stored on this disk"`).
7. `estimatedBytes` for `developer_review` quotes **eligible build artifact
   bytes only**, never source code, `.git`, or toolchains.

#### New streaming schema: `packages/protocol/schemas/space-event.schema.json`

NDJSON events emitted by `sweep space --json-stream` and consumed by the TUI:

- `space_started`: `{ type, targetDir, scope, redacted, volume? }`
- `space_cached_snapshot`: `{ type, snapshot }` (emitted immediately if a valid
  aggregate-only `SpaceCacheSnapshot` exists, with `cacheAgeMs` so the TUI
  paints an explicitly labeled stale view while scanning and keeps every action
  disabled)
- `space_progress`: `{ type, scannedDirs, scannedFiles, skippedDirs, currentDir?, categories: [{ id, allocatedBytes?, apparentBytes, fileCount, nameCount }] }` (throttled to 80 to 120 ms cadence; `currentDir` is omitted when `--redact` is set and is never emitted for foreign or uncertain account paths)
- `space_warning`: `{ type, code, detail? }` (typed warning code from a fixed
  enum; `detail` is omitted under `--redact` so raw paths cannot leak)
- `space_completed`: `{ type, report }` (the complete validated `SpaceReport`)

### 2.3 Exit codes

Reuses `EXIT` in [apps/cli/src/errors.ts](../apps/cli/src/errors.ts) verbatim:

| Exit code | Name                | Meaning for `sweep space`                                                                                                                                                                                                                                  |
| --------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | `EXIT.OK`           | Report completed (including partial coverage flagged via `coverage.complete: false` and `coverage.incompleteReasons`, or deliberate `coverage.scopeExclusions`).                                                                                           |
| `1`       | `EXIT.ABORTED`      | Cancelled by `SIGINT` / `SIGTERM` or TUI quit before completion.                                                                                                                                                                                           |
| `2`       | `EXIT.GUARDRAIL`    | Invalid CLI arguments (including any destructive flag or `--si`), blocked virtual root (`/proc`, `/sys`, `/dev`), foreign or uncertain account target on `path`/`home` scope, `root` without `SUDO_UID`, no-recall gate failure, or unsupported apply cap. |
| `3`       | `EXIT.CONFIG_PARSE` | Malformed stdin JSON (engine CLI) or invalid config file.                                                                                                                                                                                                  |
| `4`       | `EXIT.FAILURE`      | Target root unreadable or missing, engine crash, malformed stream, or stdout pipe failure.                                                                                                                                                                 |

### 2.4 Reusing the Rust engine (`crates/sweep-fs`, `crates/sweep-engine`, `crates/sweep-engine-cli`)

- **New native subcommand:** `sweep-engine space <target-dir>` reading
  `SpaceStdinOptions` JSON on stdin (`scope`, `metric`, `jsonStream`,
  `redact`, `limits`, `osHints`).
- **Capability advertisement:** `sweep-engine --capabilities` adds
  `"spaceReport": true` (Phase 2) and `"spaceHandoffApply": true` (Phase 4a,
  requiring G3 handle-relative containment).
- **Fail-closed host and JS fallback contract:**
  - On **macOS and Windows**, the JS host does **not** perform unguarded
    `fs.realpathSync`, `fs.statSync`, or L4 cache-key filesystem probes on
    unchecked targets before the native no-recall policy is active; root
    validation, L4 opaque cache-key computation, and scanning run inside the
    native engine after no-recall setup. If the native binary is unavailable or
    lacks `"spaceReport": true` on macOS or Windows, the JS fallback **refuses
    to run** (`no_recall_policy_unavailable`, exit 2) rather than risking cloud
    hydration or provider enumeration fetches.
  - On **Linux**, the JS fallback (`packages/core/src/space-scanner.ts`) may
    run **only** on verified local non-network, non-autofs, non-FUSE mounts
    (parsing `/proc/self/mountinfo` first) and fails closed if mount
    verification fails.
  - For destructive `space_handoff` apply (Phase 4a), neither host nor engine
    ever falls back silently to ordinary or older apply authority.
- **Direct reuse of `crates/sweep-fs` primitives:**
  - Work-stealing LIFO directory pool (`crossbeam-deque::Worker::new_lifo`,
    `Injector`, `Stealer`) and CPU-aware worker sizing from
    `crates/sweep-fs/src/concurrency.rs`, extended with resumable directory
    cursors / bounded work splitting so wide sibling sets are paused and
    resumed rather than dropped under queue pressure.
  - Cross-platform identity primitives from `crates/sweep-fs/src/identity.rs`
    (Unix `(dev, ino, nlink)` + Linux `mount_id`, Windows enumeration attributes
    first and `FILE_FLAG_OPEN_NO_RECALL` handle open only when verified local
    non-placeholder hardlink identity is needed).
  - Symlink and reparse-point refusal (`meta_is_reparse_point`, never following
    symlinks or non-Known-Folder junctions) and `MAX_DIR_ENTRIES` (4,000,000)
    runaway-dir guard.
  - Existing `PatternMatcher`, `artifact_rule_for`, and `classify.rs` extended
    with sealed-bundle and protected-personal-root precedence plus positive
    artifact eligibility in the **same single pass**.
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

Before any path lookup, L4 cache-key probe, or classification rule runs, the
engine enforces a single **fail-closed pre-walk gate**: (a) OS **no-recall
policy** before the first filesystem operation (Sections 3.2 and 3.4), and
(b) **invoking-user account isolation** across every scope (`home`, `volume`,
and explicit `path`, including nonstandard profile roots and elevated runs).
Each directory or file encountered during the single-pass walk is then
classified by the **first matching rule** in this strict order:

1. **Pre-walk no-recall gate, universal invoking-user isolation, and mount/skip boundaries (before opening or matching):**
   - **Fail-closed no-recall before ALL path work:**
     - On macOS, install process-wide `setiopolicy_np` disabling dataless
       materialization on the calling thread **before** root resolution, L4
       cache-key lookup, redirected-root checks, TCC probes, secondary probes,
       or worker startup. If policy installation fails (or is unavailable in a
       fallback backend), **refuse to walk** (`no_recall_policy_unavailable`,
       exit 2) without performing path-based probes that could resolve dataless
       intermediates.
     - On Windows, resolve Known Folders with `KF_FLAG_DONT_VERIFY`, inspect
       parent/ancestor attributes via `FindFirstFileExW` before opening or
       enumerating any root or redirected subtree, and reject/skip uncertain,
       offline, recall, or cloud-reparse paths without touching them.
     - Reject remote, auto-mounted, or cloud-provider roots when local
       no-recall access cannot be verified; fail closed when the JS fallback
       lacks verified no-recall primitives.
   - **Universal invoking-user account isolation (ALL scopes, ALL profile locations, elevated runs):**
     - Resolve the invoking user identity from trusted OS state (`getuid()`, or
       `SUDO_UID` when running under `sudo` on Unix; invoking Windows token
       user SID via `GetTokenInformation(TokenUser)` on Windows). If running as
       `root` (uid 0) with `SUDO_UID` unset on `volume` scope or any multi-user
       / foreign path, refuse with `EXIT.GUARDRAIL` (2) and tell the operator
       to run as themselves.
     - Resolve the invoking user's home/profile root AND **all other user
       account profile roots** from trusted OS account databases (`getpwent` /
       `getpwuid` on Linux, Open Directory / `getpwent` on macOS,
       `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList` plus
       `FOLDERID_Public` on Windows) rather than relying only on hard-coded
       `/home/*`, `/Users/*`, or `C:\Users\*` prefixes.
     - **On `--scope path` (explicit path) or `--scope home`:** Before
       traversal and before emitting any `space_progress.currentDir`, verify
       the target root is owned by the invoking user and is neither inside
       another account's resolved profile root (standard or nonstandard) nor
       inside `/Users/Shared` or `FOLDERID_Public`. Refuse foreign or
       uncertain-owner targets immediately with `EXIT.GUARDRAIL` (2).
     - **On `--scope volume` (including elevated runs):** Classify personal
       categories, `developer`, `caches`, and `trash` **only** for the invoking
       user's verified profile and invoking-user-owned trees. Any other
       resolved account profile root (standard or nonstandard, on any mount),
       `/Users/Shared`, `FOLDERID_Public`, or foreign-user-owned directory is
       **never** classified into personal/Developer/Cache/Trash buckets, emits
       **zero** `currentDir` progress paths, zero subgroups, and zero actions,
       and stays strictly inside `system_data` (already accounted for within
       `volume.usedBytes`; see Section 3.7).
     - The exact same invoking-user ownership check is enforced in the
       independent Developer project picker and in both apply engines (JS and
       Rust), even under elevation.
   - **Symlinks and non-Known-Folder reparse points:** Price only the link
     inode itself; never recurse into its target.
   - **macOS privacy containers and isolated TCC probe:** Skip `~/Library/Mail`,
     `~/Library/Messages`, `~/Library/Safari`, `~/Library/Calendars`,
     `~/Library/Contacts`, `~/Library/Reminders`, `~/Library/HomeKit`,
     `~/Library/Cookies`, and `~/Library/IdentityServices` without opening them
     (`privacy_containers_excluded`). Probe `~/Desktop`, `~/Documents`,
     `~/Downloads`, and `~/Pictures` via an isolated cancel-aware probe
     (Section 3.2) so an OS consent dialog cannot stall cancellation.
   - **Mount identity, virtual, automount, network, WSL, and snapshot boundaries:**
     - Identify mount boundaries by **mount identity** (`mount_id` via `statx`
       / `/proc/self/mountinfo` on Linux, `statfs` + `VisitedDirs` on macOS,
       Win32 volume GUID + reparse checks on Windows), not `st_dev` alone, so
       **same-device bind mounts** are detected and skipped cleanly.
     - Skip `/proc`, `/sys`, `/dev`, `/run`, `/snap/*` squashfs mounts, `autofs`
       mounts (identified from mount table / `AT_NO_AUTOMOUNT` without
       triggering automount), nested `tmpfs`/`proc`/`sysfs`/`overlay` mounts
       (while walking the root filesystem when the container root itself is
       `overlay`), nested network/virtual mounts (`nfs`, `nfs4`, `smb`, `cifs`,
       `9p`, `drvfs`), WSL `/mnt/c` and other `drvfs` Windows mounts (with a
       visible note), and snapshot trees (ZFS `.zfs`, Snapper `.snapshots`,
       Timeshift snapshot trees, and btrfs subvolumes with `parent_uuid` set).
       Record these deliberate boundaries in `coverage.scopeExclusions` (not
       `incompleteReasons`).
     - Skip foreign mounts and same-device bind mounts under `$HOME`, increment
       `coverage.crossDeviceSkippedDirs`, and surface a visible `"not on this
       disk"` / bind-mount note (with explicit carve-outs only for non-snapshot
       read-write btrfs subvolumes on the same filesystem UUID and the macOS
       APFS Data volume).
   - **Cycle and alias dedupe (`VisitedDirs`):** Dedicated `(dev, ino)`
     directory table catches mount aliases and macOS firmlinks. If its cap is
     reached, stop descending into unverified subtrees and record `cycle_cap`
     in `coverage.incompleteReasons` (`complete: false`) rather than risking an
     infinite loop.
2. **`trash` (canonical Trash roots for the invoking user):**
   Home trash (`~/.Trash`, `$XDG_DATA_HOME/Trash`, invoking user's Recycle Bin
   on the home drive) plus external volume trash roots when on the targeted
   volume (Sections 3.2 to 3.4). Everything under a trash root, including a
   deleted video or `node_modules`, belongs to `trash` and enters Trash confirm
   only.
3. **Sealed bundles (BEFORE personal folders, caches, catalog, or extension matching; preserved when scan starts inside a bundle):**
   Before walking, check whether the scan target itself starts inside a sealed
   bundle; during walking, seal every matching bundle root atomically and run
   **zero** catalog, cache, or extension rules inside:
   - macOS: `*.app`, `*.framework` -> `apps`; `*.photoslibrary` -> `photos`
   - Linux: Flatpak app and runtime trees (`~/.local/share/flatpak`,
     `/var/lib/flatpak`) and Snap roots (`~/snap`, `/var/lib/snapd/snaps`) ->
     `apps`
   - Windows: `Program Files`, `Program Files (x86)`, and `WindowsApps` ->
     `apps`
     An Electron `node_modules` inside `~/Applications/Foo.app/Contents/Resources/app/node_modules`,
     a downloaded `.app` inside `~/Downloads`, a Flatpak tree, `WindowsApps`,
     or an explicit `sweep space ~/Applications/Foo.app/Contents/Resources/app`
     stays inside its sealed bundle (`info_only`) and contributes **zero**
     actionable bytes.
4. **Known personal folders (OS-resolved, longest-prefix match, including redirected roots; BEFORE caches and catalog matching; always `info_only`):**
   - `downloads`: OS Downloads directory
   - `photos`: OS Pictures directory (`*.photoslibrary` already sealed in
     Rule 3)
   - `videos`: OS Movies/Videos directory
   - `music`: OS Music directory
   - `documents`: OS Documents and Desktop directories (guarding against any
     XDG entry resolving to `$HOME` itself)
     Everything inside a known personal folder (including redirected XDG /
     Known-Folder roots) stays **`info_only`** and contributes **zero**
     actionable Developer or Cache bytes, even if it contains a directory named
     `node_modules`, `target`, `.next`, or `.cache` alongside a project
     manifest. This rule is shared identically by the classifier and both apply
     engines under `policyProfile: "space_handoff"`.
5. **`caches` (verified compiled allowlist leaves and OS cache containers, strictly outside sealed bundles and personal roots):**
   - Exact canonical realpath match against a resolved per-OS allowlist leaf
     (verified same-user ownership, neither ancestor nor descendant of any
     personal root or sealed bundle, and excluding general-purpose temp
     directories) -> `caches` with `actionability: "allowlisted_cache"` (or
     `"owner_tool_copy_only"` for copy-only entries like `pnpm/store` or
     root-owned system package caches).
   - Guard against redirected cache env vars: if resolved `XDG_CACHE_HOME`,
     `npm_config_cache`, `CARGO_HOME`, `PNPM_HOME`, or `GRADLE_USER_HOME`
     equals, is an ancestor of, or is a descendant of a personal folder (or
     conflicts with a redirected personal root), that personal folder wins
     (Rule 4) and is never queued.
   - Other directories inside `$XDG_CACHE_HOME` / `~/.cache`,
     `~/Library/Caches`, or `%LOCALAPPDATA%` cache containers (including
     Windows `%LOCALAPPDATA%\Temp`) stay `caches` with `actionability:
     "info_only"`. A copied `cacache`, `~/Documents/.cache`, or a directory
     merely named `Cache` does not match the allowlist and stays in its
     enclosing folder.
6. **`developer` (eligible catalog artifacts, recognized projects, and toolchains, strictly outside sealed bundles and personal roots):**
   - **Eligible catalog artifacts:** Directories matched by Sweep's catalog
     (`node_modules`, `target` with sibling `Cargo.toml` or `CACHEDIR.TAG`,
     `.next`, `.turbo`, `.venv`, and peers) strictly outside sealed bundles,
     protected personal roots (including redirected roots), and system/tool
     homes that pass the **positive artifact eligibility check** and contain
     **no protected personal subtree or sealed bundle** -> `developer`,
     eligible for Developer review (`space_handoff`).
   - **Recognized project roots (source, `.git`, and project media):** Inside a
     recognized project root (with a project manifest or `.git`) located
     outside protected personal folders and sealed bundles, non-artifact source
     files, `.git`, and project media count under `developer` in an `info_only`
     subgroup (`Source & git history`) and are never queued; extension fallback
     does not run inside a recognized project.
   - **Developer toolchains and SDK homes:** `~/.rustup`, `~/.cargo` (minus
     `registry/cache`), `~/.nvm`, `~/.fnm`, `~/.volta`, `~/.pyenv`, `~/.rbenv`,
     `~/.sdkman`, `~/.asdf`, `~/.mise`, `~/go`, `~/.m2`, `~/.gradle` (minus
     `caches`), `~/.android`, `~/.docker`, `~/.local/share/containers`,
     `~/Library/Developer` (minus allowlisted cache leaves), `~/.vscode`,
     `~/.cursor`, `~/.local/share/JetBrains` -> `developer`, `info_only` (with
     copy-only owner commands where relevant).
7. **Remaining `apps` trees (`info_only`):**
   Non-sealed app data and install locations: macOS `~/Library/Application
   Support` (excluding allowlisted cache leaves like `Code/CachedData`),
   `~/Library/Containers`, `~/Library/Group Containers`; Linux
   `~/.var/app/*/data` and `config`, `*.AppImage`; Windows
   `%LOCALAPPDATA%\Programs`, `%LOCALAPPDATA%\Packages`, `ProgramData`
   (non-cache).
8. **Compiled extension table fallback (outside known folders, sealed bundles, and recognized projects):**
   Classify remaining files by static lowercase ASCII extension table into
   `photos`, `videos`, `music`, or `documents`. **Zero MIME content reads in
   v1.**
9. **`other` (`info_only`):** Everything remaining inside the walked
   invoking-user scope (VM disk images, ISO files, game data, unrecognized
   blobs).
10. **`system_data` (Unclassified volume usage, `info_only`):** Computed
    post-walk at `home` or `volume` scope **only** when accounting domains are
    proved comparable (Section 3.7); otherwise marked `bytesKnown: false` with
    totals unset.

#### Authoritative category-overlap table (shared identically by classifier, UI, and both apply engines)

This single table governs classification, Space UI review, and both JS and Rust
apply boundaries under `policyProfile: "space_handoff"`, replacing any ad-hoc
`isPersonalRootTarget` check:

| Where the file or directory is                                                                                                                                     | Category                           | Action and apply boundary                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Video, audio, or PDF inside a recognized project root (outside personal known folders and sealed bundles)                                                          | `developer` (`info_only` subgroup) | Never queued. Extension fallback does not run inside the project.                                                                                                      |
| Any file or directory (media, `.cache`, or catalog-named `node_modules`/`target`/`.next`) inside Pictures, Movies/Videos, Music, Documents, Downloads, or Desktop  | That known folder (longest prefix) | Never queued (`info_only`). Protected personal roots (including redirected XDG / Known-Folder roots) win over catalog and cache rules in classifier and apply engines. |
| Eligible catalog artifact (`node_modules`, `target`, `.next`, peers) inside a project outside personal roots, sealed bundles, system prefixes, and tool homes      | `developer`                        | Eligible for Developer review (`space_handoff`) only when positive artifact eligibility holds and no protected personal subtree or sealed bundle is inside or above.   |
| Any file or catalog artifact inside a sealed bundle (`.app`, `.framework`, `*.photoslibrary`, Flatpak, Snap, Program Files, WindowsApps), incl. scan inside bundle | The bundle (`apps` or `photos`)    | Never queued (`info_only`). Sealed bundles block catalog, cache, and extension rules (Rule 3).                                                                         |
| Realpath equals a resolved compiled allowlist leaf (same user, neither ancestor nor descendant of a personal root or sealed bundle, not a generic temp directory)  | `caches`                           | Eligible for Cache review (`allowlisted_cache`, instance-bound) or `owner_tool_copy_only`. Copied `cacache`, `~/Documents/.cache`, or generic Temp stays `info_only`.  |
| Resolved `XDG_CACHE_HOME`, `npm_config_cache`, `CARGO_HOME`, `PNPM_HOME`, or `GRADLE_USER_HOME` equals, is ancestor of, or is descendant of a personal folder      | That personal folder               | Never queued (`info_only`). Display-only.                                                                                                                              |
| Anything under a verified invoking-user trash root, including a deleted video or `node_modules`                                                                    | `trash`                            | Trash confirm only (subject to platform Trash apply verification gate).                                                                                                |

### 3.2 macOS specifics

- **Fail-closed process-wide no-recall policy BEFORE all path work:**
  At startup on the calling thread, **before** resolving `targetDir`, computing
  the L4 cache key, checking redirected roots, probing TCC folders, probing
  `/Applications`, or spawning worker threads, call
  `setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
  IOPOL_SCOPE_PROCESS, IOPOL_MATERIALIZE_DATALESS_FILES_OFF)`. Never rely on
  per-worker `IOPOL_SCOPE_THREAD` alone. If policy installation fails (or is
  unavailable in the JS fallback), **refuse to walk** immediately
  (`no_recall_policy_unavailable`, exit 2) without running path-based cloud
  checks that could resolve and materialize dataless intermediate components.
  If any `read_dir` or `open` returns `EDEADLK` (macOS signal that a dataless
  directory would have to materialize), skip that subtree, record
  `cloud_placeholders_excluded` in `coverage.scopeExclusions`, and never retry.
- **No Spotlight in v1:**
  Phase 2 uses the filesystem walk and compiled UTI-aligned extension table on
  every OS. `mdls` and `mdfind` are not invoked in v1 so byte totals have zero
  Spotlight-daemon dependency and zero recall risk.
- **TCC privacy containers and isolated, cancel-aware TCC probe:**
  - Skip `~/Library/Mail`, `~/Library/Messages`, `~/Library/Safari`,
    `~/Library/Calendars`, `~/Library/Contacts`, `~/Library/Reminders`,
    `~/Library/HomeKit`, `~/Library/Cookies`, and `~/Library/IdentityServices`
    **without opening them** (`privacy_containers_excluded` in
    `coverage.scopeExclusions`).
  - Do **not** run a blocking synchronous TCC probe directly on the main
    calling thread where an OS permission dialog could hang and break the
    <100 ms cancellation acknowledgement budget. Instead, probe `~/Desktop`,
    `~/Documents`, `~/Downloads`, and `~/Pictures` (plus Photos / iCloud Drive
    roots) inside an **isolated, cancel-aware probe thread** (inheriting the
    process-wide no-recall policy) before the worker pool opens those roots,
    with the main thread actively watching `SIGINT`/`Esc` cancellation and a
    bounded wait state so the user can cancel cleanly if a modal dialog appears
    (in non-interactive / `--json` headless runs without Full Disk Access,
    bound or skip blocking prompts per probe policy and report unknown).
  - On `EPERM`, `EACCES`, or cancelled/dismissed prompt wait: set that
    category's `bytesKnown` to `false`, leave its `allocatedBytes` and
    `apparentBytes` unset (never report `0 GiB` for an unread folder), set
    `unknownReason: "tcc_or_permission"`, explain in the category insight that
    the folder was not read, name those unread folders in the `System data`
    sentence, add `tcc_or_permission` to `coverage.incompleteReasons`, and set
    `coverage.complete: false`.
- **Dataless cloud files (`UF_DATALESS` / `SF_DATALESS`):**
  For `~/Library/CloudStorage` and iCloud Drive files with the dataless flag
  set, keep `allocatedBytes = 0` (`allocatedKnown: true`), record
  `apparentBytes` from `lstat` metadata without opening the file, add
  `cloud_placeholders_excluded` to `coverage.scopeExclusions`, and display a
  visible info-only subgroup **`"Not stored on this disk"`** across 80, 100,
  and 120 columns (Section 6.3). Never describe dataless files as "sparse".
- **`~/Library` and `/Applications` routing:**
  - `~/Library/Caches` -> `caches` (allowlisted leaves reviewable; rest
    `info_only`).
  - `~/Library/Developer` -> allowlisted cache leaves (`Xcode/DerivedData`,
    `CoreSimulator/Caches`, `Xcode/UserData/Previews`) route to `caches` in
    Rule 5; remaining SDKs, DeviceSupport, Archives, and CoreSimulator data
    route to `developer` (`info_only`).
  - `~/Library/Application Support`, `~/Library/Containers`,
    `~/Library/Group Containers` -> `apps` (carving out explicitly allowlisted
    cache leaves like `Code/CachedData`).
  - `/Applications` and `~/Applications`: every `.app` and `.framework` is
    sealed atomically as `apps` in Rule 3 before catalog matching. On
    `--scope home`, `/Applications` on the same APFS Data volume is read-only
    probed (after process-wide no-recall setup) so installed apps are
    attributed to `apps`.
- **APFS Data volume, firmlinks, snapshots, and qualified purgeable estimate:**
  - Read `totalBytes`, `usedBytes`, and `availableBytes` from the **APFS Data
    volume** containing the home directory (`/System/Volumes/Data` via
    `statvfs(home)` / Data volume mount), never from the sealed read-only `/`
    system snapshot volume. On a standard Mac, `sweep space /` and
    `sweep space ~` must report the exact same volume total, used, and free
    figures.
  - When walking `--scope volume`, walk `/System/Volumes/Data` and skip
    `/System/Volumes/*` aliases via `VisitedDirs` so firmlinks (`/Users`,
    `/Applications`, `/Library`) are never counted twice.
  - **Qualified purgeable estimate (not an exact counter):**
    `NSURLVolumeAvailableCapacityForImportantUsageKey` is Apple's heuristic
    capacity estimate for important usage, not an exact purgeable byte count.
    Compute `estimatedPurgeableBytes = max(0, importantUsageCapacity -
    availableBytes)` **only** when both queries come from the exact same APFS
    Data volume; otherwise omit `estimatedPurgeableBytes`. Always label it
    explicitly as an **estimate** (e.g., `154.2 GiB free (~28.4 GiB est.
    purgeable)`), and keep it strictly off the headline used figure and out of
    `availableBytes`.
  - **Local APFS snapshots (`com.apple.TimeMachine.*`):** Query `snapshotCount`
    via `fs_snapshot_list` when permitted without root and report it as an
    independent fact. Because a snapshot count does **not** prove which
    snapshot blocks are included in Apple's `importantUsage` heuristic, Sweep
    never infers snapshot membership from `snapshotCount` and states candidly
    that local snapshots may hold freed blocks and may overlap with Apple's
    purgeable estimate.
  - **APFS CoW accounting:** Because APFS supports copy-on-write clones and v1
    does not compute physical extent deduplication, `accountingDomainComparable`
    is `false` (`cow_unproved_domain`) on APFS volumes; walked categories show
    exact attributed allocation while `system_data` reports `bytesKnown: false`
    (`incomparable_domain`) rather than an unproved residual (Section 3.7).
- **Trash roots:**
  Recognize `~/.Trash` on home scope and `<volume>/.Trashes/<uid>` on external
  or targeted volumes (owned by invoking uid).

### 3.3 Linux specifics

- **XDG User Directories (zero subprocess spawn; mount-identity aware):**
  Read `$XDG_CONFIG_HOME/user-dirs.dirs` (fallback `~/.config/user-dirs.dirs`)
  with a bounded 16 KiB `O_NOFOLLOW | O_NONBLOCK` read. Parse
  `XDG_PICTURES_DIR`, `XDG_VIDEOS_DIR`, `XDG_MUSIC_DIR`, `XDG_DOCUMENTS_DIR`,
  `XDG_DOWNLOAD_DIR`, `XDG_DESKTOP_DIR` (expanding `$HOME` and honoring
  localized names like `~/Bilder` or `~/Téléchargements`). Reject any entry
  that resolves to `$HOME` itself, traverses via `..`, or points to `/`. When
  an XDG known folder resolves cleanly outside `$HOME`, do **not** assume
  "outside `$HOME`" means "on another disk"; check its actual **mount identity**
  (`mount_id` / `st_dev` against the target volume):
  - If it sits on a **different mount/volume**: record it as **"on another
    disk"** (`other_volumes_excluded`) and do **not** silently replace it with
    an empty `~/Downloads`.
  - If it sits on the **same mount/volume** outside `$HOME`: on `--scope home`,
    record it as **"outside home scope"** (`other_volumes_excluded`) without
    falsely calling it `"on another disk"` and without substituting an empty
    `~/Downloads`; on `--scope volume`, verify invoking-user ownership and
    classify it into its personal category (protected by Rule 4).
    Fall back to `$HOME/{Pictures,Videos,Music,Documents,Downloads,Desktop}` only
    when the XDG entry is absent.
- **Flatpak, Snap, and AppImage (`apps`):**
  - `~/.local/share/flatpak`, `/var/lib/flatpak` (on volume scope, or probed
    read-only on home scope when on the same mount), `~/snap`, and
    `/var/lib/snapd/snaps` are **sealed** as `apps` in Rule 3 before catalog
    matching.
  - `~/.var/app/*/data` and `config` -> `apps`; `~/.var/app/*/cache` ->
    `caches` (`info_only` unless allowlisted).
  - `/snap/*` squashfs loop mounts are skipped by mount-table / `mount_id`
    check so compressed snap images are never double-counted.
  - `*.AppImage` files -> `apps`.
- **Walk boundaries (mount identity, bind mounts, snapshots, network FS, WSL):**
  - Parse `/proc/self/mountinfo` once (capped at 1 MiB) before walking and
    capture the target root's `mount_id` via `statx(..., STATX_MNT_ID)` (or
    `name_to_handle_at`).
  - **Same-device bind mounts and cross-device mounts:** Check each directory's
    `mount_id` (and mount-table mountpoint set), not `st_dev` alone, so
    **same-device bind mounts** are reliably identified and skipped without
    double-counting or escaping the root mount. Skipping a bind mount or
    foreign mount increments `coverage.crossDeviceSkippedDirs`, records
    `other_volumes_excluded` in `coverage.scopeExclusions`, and surfaces a
    visible `"not on this disk"` / bind-mount note.
  - **Snapshots:** Skip ZFS `.zfs`, Snapper `.snapshots`, Timeshift snapshot
    directories, and btrfs subvolumes whose `parent_uuid` is set (inode dedup
    does not collapse snapshots), recording `snapshot_trees_excluded` in
    `coverage.scopeExclusions`. Include another btrfs synthetic `st_dev`
    **only** for a non-snapshot read-write subvolume on the same filesystem
    UUID (and mark `accountingDomainComparable: false`, `cow_unproved_domain`
    because btrfs is CoW).
  - **Autofs and virtual mounts:** Never trigger `autofs` (identify `autofs`
    mountpoints from `mountinfo` and pass `AT_NO_AUTOMOUNT` / avoid `stat` on
    automount triggers). Skip nested `tmpfs`, `proc`, `sysfs`, `devtmpfs`,
    `cgroup2`, and nested `overlay` mounts (while still walking the root
    filesystem when the container root itself is `overlay`), recording
    `virtual_or_autofs_excluded` in `coverage.scopeExclusions`.
  - **Network and virtual filesystems (`nfs`, `nfs4`, `smb`, `cifs`, `9p`, `drvfs`), skipped vs measured:**
    - **Nested inside a local `home` or `volume` walk:** Always **skip** via
      mount-table / `mount_id` boundary (`other_volumes_excluded` or
      `wsl_windows_drives_excluded`). Never cross from a local walk onto a
      network share.
    - **Explicitly targeted root (e.g., `sweep space /mnt/nas` or a network
      home on Linux):** Refuse `autofs` triggers with `EXIT.GUARDRAIL` (2). For
      an already-mounted non-autofs network root, allow read-only measurement
      only; when `st_blocks` is missing or reported as zero for non-empty
      files, show apparent bytes, add `allocated_unavailable` to
      `coverage.accountingCaveats`, set `accountingDomainComparable: false`
      (`system_data.bytesKnown: false`), exempt from Section 4.2 local-SSD wall
      targets, and disable destructive review actions (since G3 local
      handle-relative containment does not hold on network/FUSE mounts).
  - **WSL:** Under WSL, exclude `/mnt/c` and other `drvfs` Windows drive mounts
    from a home or `/` report (`wsl_windows_drives_excluded` in
    `coverage.scopeExclusions`) and show a clear note that Windows drives are
    not included.
  - **Separate `/home` volume:** When `/home` is its own mounted non-CoW
    filesystem, `System data`'s sentence names other accounts, unread
    directories, and filesystem metadata; it does **not** say `"OS files"`.
- **Caches (`~/.cache` and system package caches):**
  - `$XDG_CACHE_HOME` (default `~/.cache`) -> `caches`, with compiled
    allowlist leaves tagged `allowlisted_cache` and unknown subdirs tagged
    `info_only`.
  - System package caches (`/var/cache/pacman/pkg`, `/var/cache/apt/archives`,
    `/var/cache/dnf`, `/var/cache/libdnf5`, `/var/cache/zypp`): when readable
    by the current user without elevation on the same mount, measure them and
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
    Trash root and volume identity, capture an explicit confirmed snapshot of
    verified Trash entries (with inode identities), remove only entries in that
    confirmed snapshot, and skip any replacement or new arrival created after
    confirmation.

### 3.4 Windows specifics

- **Fail-closed no-recall enumeration and root/ancestor verification:**
  - Resolve Known Folders strictly with **`SHGetKnownFolderPath(...,
    KF_FLAG_DONT_VERIFY, ...)`** so Windows never verifies, creates, or touches
    a redirected or cloud-backed folder target during lookup.
  - Before enumerating any initial scan target, redirected Known Folder, L4
    cache-key root, or secondary probe (`Program Files`, `ProgramData`),
    inspect ancestor and root directory-entry attributes via parent-directory
    `FindFirstFileExW` enumeration and reject/skip any component carrying
    `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (`0x00400000`),
    `FILE_ATTRIBUTE_RECALL_ON_OPEN` (`0x00040000`), `FILE_ATTRIBUTE_OFFLINE`
    (`0x00001000`), or cloud/uncertain reparse tags (`IO_REPARSE_TAG_CLOUD*`,
    unrecognized reparse points) **before** calling `FindFirstFileExW` inside
    that directory, before calling `CreateFileW`, and before any identity or
    size query.
  - Enumerate verified local directories using `FindFirstFileExW`
    (`FindExInfoBasic` and `FIND_FIRST_EX_LARGE_FETCH`) so logical size
    (`nFileSizeHigh`/`nFileSizeLow`) and attributes (`dwFileAttributes`) come
    directly from directory enumeration without opening files (avoiding both
    cloud hydration and Windows Defender on-open scans).
  - **Never call `GetCompressedFileSizeW` on placeholders or unchecked paths**
    (it opens the file and triggers OneDrive Files On-Demand hydration).
  - **Partially resident vs offline placeholders (`FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`):**
    Because Windows `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` can be set on
    **partially hydrated** files that hold real local clusters on disk, a
    blanket `allocatedBytes = 0` is unsupported and would falsely inflate
    `System data`. Therefore, for any entry with
    `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`, `FILE_ATTRIBUTE_RECALL_ON_OPEN`,
    `FILE_ATTRIBUTE_OFFLINE`, or uncertain cloud reparse tags:
    - do **not** open the file and do **not** descend into dataless reparse
      subtrees,
    - record `apparentBytes` from `FindFirstFileExW` enumeration metadata,
    - set **`allocatedKnown: false`** (omit `allocatedBytes` on the subgroup),
      mark the affected category `bytesKnown: false` with `unknownReason:
      "placeholder_allocation_unknown"` (retaining `apparentBytes`), add
      `cloud_placeholders_excluded` to `coverage.scopeExclusions` and
      `placeholder_allocation_unknown` to `coverage.accountingCaveats`, and set
      `accountingDomainComparable: false` so unknown placeholder allocations
      never inflate `System data`,
    - display the visible info-only subgroup **`"Not stored on this disk"`**
      across 80, 100, and 120 columns (Section 6.3; never label placeholders
      "sparse").
  - For verified local non-placeholder files where allocated size differs from
    apparent size (NTFS compressed or sparse flag set in `dwFileAttributes`) or
    when querying hardlink identity, open the handle strictly with
    `FILE_FLAG_OPEN_NO_RECALL | FILE_FLAG_OPEN_REPARSE_POINT |
    FILE_FLAG_BACKUP_SEMANTICS` and query
    `GetFileInformationByHandleEx(FileStandardInfo)` /
    `GetFileInformationByHandle`.
  - **Fail-closed JS fallback:** On Windows, if native `sweep-engine` is
    unavailable or lacks `"spaceReport": true`, the JS fallback refuses to run
    (`no_recall_policy_unavailable`, exit 2).
- **Known Folders, junctions, long paths, and profile isolation:**
  - Query `SHGetKnownFolderPath(..., KF_FLAG_DONT_VERIFY, ...)` via
    `windows-sys` for `FOLDERID_Pictures`, `FOLDERID_Videos`, `FOLDERID_Music`,
    `FOLDERID_Documents`, `FOLDERID_Desktop`, `FOLDERID_Downloads`,
    `FOLDERID_LocalAppData`, `FOLDERID_RoamingAppData`, `FOLDERID_ProgramFiles`,
    `FOLDERID_ProgramFilesX86`, `FOLDERID_ProgramData`, and `FOLDERID_Public`.
  - Walk a verified local non-cloud target path returned by
    `SHGetKnownFolderPath` even when the profile-relative directory name is a
    junction; do **not** follow any other reparse point or junction
    (`FILE_ATTRIBUTE_REPARSE_POINT`).
  - Seal `Program Files`, `Program Files (x86)`, and `WindowsApps` atomically
    as `apps` in Rule 3 before catalog matching.
  - Enable extended-length / long paths (`\\?\` prefix handling and application
    manifest `longPathAware`) so paths deeper than 260 characters are walked
    and accounted accurately.
  - Resolve all local/domain profile paths from
    `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList` plus
    `FOLDERID_Public` and compare against the invoking token user SID so
    nonstandard profile roots (e.g. `D:\Profiles\Other`) and elevated runs obey
    Section 3.1 account isolation across every scope.
  - If a Known Folder lives on a different volume GUID than the scan root,
    record it separately as `"on another disk"` (`other_volumes_excluded`)
    without contaminating same-volume `System data` math.
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

1. **Attributed allocation (`allocatedBytes`):** Sum of per-inode on-disk block
   allocations (`st_blocks * 512` on Unix; NTFS `AllocationSize` on Windows for
   verified local non-placeholder files; `0` for macOS `UF_DATALESS` files;
   **unknown / omitted** for Windows partially resident
   `RECALL_ON_DATA_ACCESS` placeholders) across walked unique inodes. On
   CoW-capable filesystems, attributed allocation is explicitly not deduplicated
   across cloned extents.
2. **Volume free/used counters (`volume.totalBytes`, `volume.usedBytes`, `volume.availableBytes`):**
   OS volume accounting (`statvfs` on the APFS Data / mounted volume;
   `GetDiskFreeSpaceExW` on Windows). Kept separate from APFS container
   headroom, `snapshotCount`, and `estimatedPurgeableBytes`.
3. **Reclaim estimates (`spaceAction.estimatedBytes`):** Qualified estimate
   (`"up to N GiB"`) of what removing eligible items may free, noting that
   shared clones, hardlinks, or local snapshots can keep blocks allocated until
   all references and snapshots expire.

| Phenomenon                                          | How `sweep space` handles it                                                                                                                                                                                                                                                                                                                                                                                                                               | Displayed and JSON semantics                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Allocated vs apparent**                           | Attributed allocation leads on local filesystems; `apparentBytes` is accumulated in parallel and never subtracted from allocated volume usage. On network/virtual FS where `st_blocks` is missing or always zero, show apparent bytes and add `allocated_unavailable` to `coverage.accountingCaveats`.                                                                                                                                                     | Headline and bar use `allocatedBytes` when known. JSON includes both integer byte fields whenever `bytesKnown` is `true`, and omits unknown byte fields when `bytesKnown` is `false`. `--metric apparent` switches display only and never fabricates an allocated residual.                                                                                                        |
| **Sparse files**                                    | Allocated blocks report only physically written extents (a 10.00 GiB sparse VM image with 0 allocated blocks reports `0 B` allocated, `10.00 GiB` apparent).                                                                                                                                                                                                                                                                                               | Subgroup detail shows `0 B on disk (10.00 GiB logical)` when `apparent > allocated * 2` and `apparent >= 64 MiB`. Never confuse sparse files with cloud dataless files.                                                                                                                                                                                                            |
| **Cloud dataless / placeholders**                   | Detected from metadata (`UF_DATALESS`/`SF_DATALESS` on macOS, `FindFirstFileExW` attributes on Windows) without opening. macOS `UF_DATALESS` records `allocatedBytes = 0` (`allocatedKnown: true`); Windows `RECALL_ON_DATA_ACCESS` / `RECALL_ON_OPEN` / `OFFLINE` records `allocatedKnown: false` (omits `allocatedBytes`, sets `placeholder_allocation_unknown`) because `RECALL_ON_DATA_ACCESS` can be partially local. Always records `apparentBytes`. | Shown in visible info-only subgroup `"Not stored on this disk"` at 80, 100, and 120 columns. Never labeled sparse. Unknown placeholder allocations set `accountingDomainComparable: false` so they never inflate `System data`.                                                                                                                                                    |
| **Small-file block overhead**                       | `st_blocks * 512` captures 4 KiB cluster rounding (1,000,000 x 128 B files = 3.81 GiB on 4 KiB ext4 blocks, not 122.07 MiB).                                                                                                                                                                                                                                                                                                                               | Prevents phantom "unaccounted space" inflation in `System data`.                                                                                                                                                                                                                                                                                                                   |
| **Hardlinks (`nlink > 1`) under parallel workers**  | Separate `SeenHardlinks` map keyed by `(dev, ino)` (or Windows volume serial + file index) stores the **winning category priority** (from Section 3.1 waterfall) and a deterministic tie-breaker (lowest canonical relative-path hash on equal priority). When parallel workers visit a higher-priority link later, atomically transfer the inode's bytes from the previous owner to the new owner so totals are 100% independent of worker arrival order. | `fileCount` counts unique attributed inodes; `nameCount` (`coverage.scannedNames`) counts directory entries separately. If `maxDedupIdentities` is hit (for example in a pnpm/Bun store), set `hardlink_dedup_cap` in `incompleteReasons` **only** (never `clone_or_compression_overlap`), set affected `bytesKnown: false`, and disable review.                                   |
| **CoW clones / reflinks (APFS, Btrfs, XFS, ReFS)**  | Cloned files have distinct inodes and each reports full `st_blocks`. Shared extents can overlap even when `sum(classified) <= volume.usedBytes`, and missing/unreadable entries and clone overlap can occur together. Sweep v1 does not perform extent-level dedupe (and makes no APFS Time Machine hardlink claim, as APFS Time Machine uses snapshots and clones).                                                                                       | On CoW-capable volumes, set `accountingDomainComparable: false`, add `cow_unproved_domain` to `accountingCaveats`, and mark `system_data` `bytesKnown: false` (`incomparable_domain`, totals unset) even when `sum(classified) <= volume.usedBytes`. If `sum(classified) > volume.usedBytes` without a hardlink cap, also add `clone_or_compression_overlap` (`invalid_residual`). |
| **Filesystem compression (APFS, Btrfs, ZFS, NTFS)** | `st_blocks * 512` and NTFS `AllocationSize` natively report compressed on-disk bytes.                                                                                                                                                                                                                                                                                                                                                                      | Reconciles with on-disk allocation on non-CoW NTFS; on CoW filesystems still governed by the CoW comparability rule above.                                                                                                                                                                                                                                                         |

### 3.7 Computing "System data" (Unclassified volume usage) honestly

`system_data` represents **Unclassified volume usage**: bytes reported as used
by the volume that were not attributed to the invoking user's other ten
categories. Sweep enforces a **positive comparability rule** and refuses to
fabricate a residual whenever the accounting domains cannot be proved
comparable:

- **Positive comparability rule (`volume.accountingDomainComparable === true`):**
  `accountingDomainComparable` is `true` **only** when **all** of the following
  hold:
  1. `scope` is `"volume"` or `"home"`,
  2. `volume.bytesBasis` is `"statvfs"` or `"GetDiskFreeSpaceEx"` from the exact
     same mounted local filesystem as the walked root,
  3. attributed allocation is available (not `allocated_unavailable`) and
     `metric` is `"allocated"` (never subtract apparent bytes from allocated
     volume usage),
  4. the filesystem is **not** a CoW / reflink-capable volume without proved
     extent-level dedupe (so APFS, Btrfs, ZFS, ReFS, and XFS with reflink
     enabled set `accountingDomainComparable: false` and add
     `cow_unproved_domain` to `coverage.accountingCaveats` in v1; see the
     below-capacity clone overlap outcome below),
  5. no partially resident cloud placeholder had unknown local allocation
     (`placeholder_allocation_unknown` is absent),
  6. no quota, reserved-block, or thin-provisioning mismatch makes
     `volume.usedBytes` incomparable to walked file allocation, and
  7. no `hardlink_dedup_cap`, `cycle_cap`, `queue_cap`, or `unreadable_entries`
     truncated attribution.
- **Residual math and no-double-count rule for other accounts:**
  When `accountingDomainComparable === true`:
  ```text
  classified_invoking_same_dev = sum(cat.allocatedBytes for cat != "system_data" on volume_dev)
  raw_residual                 = volume.usedBytes - classified_invoking_same_dev
  ```
  - **No double counting of other accounts:** On `--scope volume`,
    `volume.usedBytes` **already includes** all other accounts' disk
    allocation. Therefore, other accounts' bytes are already inside
    `raw_residual` (`volume.usedBytes - classified_invoking_same_dev`) and are
    **never** added on top of `raw_residual`. On a non-CoW multi-user volume,
    `classified_invoking_same_dev + system_data.allocatedBytes ==
    volume.usedBytes` holds exactly.
  - If `raw_residual >= 0` and no unread permission/TCC gap invalidated it:
    `system_data.allocatedBytes = raw_residual`, `system_data.bytesKnown = true`.
  - If `raw_residual >= 0` but `tcc_or_permission` or `permission_denied` left
    invoking-user folders unread: set `system_data.bytesKnown = false`, omit
    `system_data.allocatedBytes` / `apparentBytes`, set `unknownReason:
    "tcc_or_permission"`, and name the unread folders in the `System data`
    sentence.
  - If `raw_residual < 0` (overlap exceeded volume used): add
    `clone_or_compression_overlap` to `coverage.accountingCaveats`, set
    `system_data.bytesKnown = false`, leave `allocatedBytes` and
    `apparentBytes` unset, and set `unknownReason: "invalid_residual"`.
- **Mandated outcome for CoW and below-capacity clone overlap:**
  Whenever `accountingDomainComparable === false` (including a **below-capacity
  CoW clone overlap** where `sum(classified) <= volume.usedBytes` on APFS,
  Btrfs, ZFS, ReFS, or reflink-XFS), Sweep **must not** emit a guessed
  nonnegative residual. Instead:
  - Walked categories keep their attributed `allocatedBytes`,
  - `volume.accountingDomainComparable` is `false`,
  - `coverage.accountingCaveats` includes `cow_unproved_domain` (and
    `clone_or_compression_overlap` if `sum(classified) > volume.usedBytes`),
  - `system_data` is emitted with `bytesKnown: false`, `allocatedBytes` and
    `apparentBytes` **unset**, and `unknownReason: "incomparable_domain"` (or
    `"invalid_residual"` when over capacity).
- **Same-volume OS-shared probes on `home` scope:**
  On `scope === "home"`, Sweep performs a bounded read-only probe (after
  no-recall setup) of standard OS-shared app and system-cache trees on the
  **same mount** (macOS `/Applications`; Linux `/var/lib/flatpak`,
  `/var/lib/snapd/snaps`, `/var/cache/{pacman,apt,dnf}`; Windows `Program
  Files`, `Program Files (x86)`, `ProgramData`) so installed apps are
  attributed to `apps` rather than left unclassified.
- **Honest `System data` sentences (plain sentences, no em dashes):**
  - Standard non-CoW root volume: `"Unclassified volume usage: OS files, other accounts, and filesystem metadata."`
  - Separate non-CoW `/home` volume on Linux: `"Unclassified volume usage: other accounts, unread directories, and filesystem metadata."` (Never says `"OS files"`.)
  - When unread TCC folders exist on macOS: `"Unclassified volume usage is unknown. Unread folders: Documents, Desktop."`
  - On CoW volumes (such as APFS, Btrfs, ZFS, ReFS): `"Unclassified volume usage is unknown on this volume because copy-on-write clones or snapshots can share blocks."` (When `snapshotCount > 0` on macOS, append `"Local snapshots detected: N."` without claiming whether their blocks sit inside `estimatedPurgeableBytes`.)
  - When other users were observed on `--scope volume` (non-CoW comparable): `"Unclassified volume usage, including other user accounts and shared folders."`
  - When residual is invalid (`raw_residual < 0`) or incomparable due to placeholders/network FS/quotas: `"Unclassified volume usage is unknown because allocation cannot be compared to volume used."`
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
- **Exact proxy invocation shape (for reproducing historical proxy bounds):**
  ```text
  cargo build --release --manifest-path crates/Cargo.toml -p sweep-engine-cli
  printf '{"patterns":["bucket_0","bucket_1",...,"bucket_9"],"exact":false,"profile":"balanced"}\n' \
    | /usr/bin/time -v target/release/sweep-engine scan <temp-corpus-dir>
  ```
  (Note: the standalone replayable fixture generator and cross-OS benchmark
  script `scripts/bench-space.ts` are **deferred to Phase 2** alongside the
  real `sweep-engine space` implementation; this specification PR edits only
  `.plans/space-report.md`.)
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
   the **fixture generator and benchmark command** (`scripts/bench-space.ts`)
   and qualify the real `sweep-engine space` pipeline across cold and warm
   Linux, macOS, and Windows runs before locking regression thresholds.
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
| Cached instant paint (L4 hit)                                      | **< 50 ms**                           | **< 50 ms**                           | Aggregate-only `space-cache.json` read after no-recall key lookup    |
| Time to first live event (`space_started`)                         | **< 20 ms**                           | **< 20 ms**                           | Emitted after no-recall setup, root validation, and volume stat      |
| Live progress heartbeat                                            | Every **80 ms** or **16k files**      | Every **120 ms** or **16k files**     | Coalesced atomic snapshot, bounded channel (max 4 in-flight frames)  |
| Peak Rust engine RSS (coordinated budget ceiling)                  | **<= 48 MiB** (typical 8 to 24 MiB)   | **<= 20 MiB** (typical 4 to 12 MiB)   | Accounts for hash-table slack, worker buffers, and transport         |
| Cancellation acknowledgement (`SIGINT` / `Esc`)                    | **< 100 ms** ack (separate from exit) | **< 100 ms** ack (separate from exit) | Prompt UI/CLI ack; worker exit waits on any kernel-blocked syscall   |
| Local SSD wall-time qualification                                  | Qualified in Phase 2/3 bench harness  | Qualified in Phase 2/3 bench harness  | Separate discovery, first data, complete coverage, true cold vs warm |

#### Coordinated `SpaceLimits` and explicit cap behavior

| Retained resource                                    | `balanced` cap (est. RAM incl. slack) | `low-memory` cap (est. RAM incl. slack) | Exact behavior when cap is reached                                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------: | --------------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resumable directory frames & queued path bytes       |          16,384 dirs / 4 MiB (~6 MiB) |             2,048 dirs / 1 MiB (~2 MiB) | Pause sibling fan-out via resumable directory cursors (drain depth-first); if frames still overflow, skip excess and set `queue_cap` in `incompleteReasons` (`complete: false`, disable review).    |
| Open directory FDs across all workers                |                            64 FDs max |                              16 FDs max | Close parent cursor or serialize worker dir open; never exhaust `RLIMIT_NOFILE`.                                                                                                                    |
| Cycle/alias table (`VisitedDirs`, dedicated)         |           131,072 dir inodes (~6 MiB) |            32,768 dir inodes (~1.5 MiB) | Never shares space with hardlinks. On cap, refuse further descent into unverified subtrees, set `cycle_cap` in `incompleteReasons` (`complete: false`), disable review.                             |
| Hardlink dedup table (`SeenHardlinks`, dedicated)    |         262,144 file inodes (~16 MiB) |             65,536 file inodes (~4 MiB) | Remaining multi-link files count as upper bound; set `hardlink_dedup_cap` in `incompleteReasons` **only** (never `clone_or_compression_overlap`), set affected `bytesKnown: false`, disable review. |
| Max dirents per single directory (`MAX_DIR_ENTRIES`) |                             4,000,000 |                               4,000,000 | Stop reading runaway dir; mark `unreadable_entries` in `incompleteReasons`, `complete: false`, disable review.                                                                                      |
| Top-K heavy subgroups per category                   |                64 in-memory (16 wire) |                  32 in-memory (16 wire) | Evict smallest subgroup; totals in category accumulators stay exact.                                                                                                                                |
| Serialized event queue & JS host retention           |           4 pending frames (~256 KiB) |             2 pending frames (~128 KiB) | Drop superseded `space_progress` frames under slow consumer; never drop `space_started` or `space_completed`.                                                                                       |

### 4.3 Streaming, cancellation, and L4 cached instant start

- **Streaming partial results:** Workers accumulate lock-free per-worker
  category counters and merge into an atomic snapshot every 80 ms (`balanced`)
  or 120 ms (`low-memory`), emitting `space_progress`. While scanning, the bar
  grows left-to-right and the headline updates with a `~` / `SCANNING` mark;
  the instant `space_completed` lands, motion stops completely. When
  `coverage.complete` is `false` (any `incompleteReasons` present), the card
  displays a clear partial mark (`~` and `Partial scan`) and **disables every
  review action**, matching the stale-cache safety rule. Deliberate
  `scopeExclusions` alone do not mark the card incomplete.
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
      salt over `(canonicalTarget, device, inode, scope, platform)` computed
      **after** the native no-recall gate on macOS/Windows) so even the cache
      key leaks no path and triggers no cloud hydration,
    - `createdAt`, `scope`, `engine`, `metric`,
    - aggregate `volume` numeric totals (`totalBytes`, `usedBytes`,
      `availableBytes`, `estimatedPurgeableBytes?`, `snapshotCount?`,
      `bytesBasis`, `accountingDomainComparable`; **no `mountPoint` or `fsType`
      path**),
    - `coverage` counts, `complete`, and enum `incompleteReasons` /
      `scopeExclusions` / `accountingCaveats`,
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
2. **No personal filenames in reports, and no paths in history, journals, receipts, or cache:**
   - Unredacted live runs include the invoking user's requested `targetDir`
     (and ephemeral `space_progress.currentDir` while scanning invoking-user
     trees) in live stdout/UI output so the user sees what is being scanned;
     `currentDir` is never emitted for foreign or uncertain account paths.
   - Personal subgroups (`photos`, `videos`, `music`, `documents`, `downloads`,
     `apps`, `system_data`, `other`) emit **type totals only** (never
     filenames), even when `--redact` is **not** set.
   - `sweep space` never writes to `history.jsonl`.
   - `space-cache.json` uses the path-free `SpaceCacheSnapshot` format (Section
     4.3) with zero `targetDir`, zero `currentDir`, zero mount labels, and zero
     project names.
   - Trash `.trashinfo` original paths (`Path=`) are display-only in the
     ephemeral Trash confirmation UI (sanitized) and are **never** persisted to
     journals, receipts, history, or caches.
   - Other accounts' resolved profile directories (standard or nonstandard),
     `/Users/Shared`, and `FOLDERID_Public` contribute zero paths, zero
     progress `currentDir` entries, zero subgroups, and zero actions.
3. **Closed allowlist-driven redacted transport (`--redact`) across every dispatch sink:**
   Extends [docs/users/privacy.md](../docs/users/privacy.md) using **typed
   field allowlisting and closed static message templates** (never brittle
   post-hoc regex replacement). Every output and dispatch sink (CLI `--json`,
   CLI `--json-stream` NDJSON, CLI human stdout, CLI stderr, TUI `SpaceView`,
   native-child fallback diagnostics, and any alternate programmatic caller)
   flows through the **same** typed redaction serializer and obeys the **same**
   action-disabling gates:
   - `targetDir` -> `"<home>"`, `"<volume>"`, or `"<target>"`.
   - `volume.mountPoint` -> `"<volume-1>"`; `volume.fsType` -> closed OS FS
     enum token or `"<unknown>"`.
   - `space_progress.currentDir` -> omitted completely.
   - `space_warning` and stderr/error diagnostics -> fixed typed enum codes and
     static template strings only (never raw OS error strings containing paths,
     never native-child paths or argv dumps).
   - **Closed redacted shape for all free-text fields and IDs:** Under
     `redacted: true`, `insight`, `reason`, `sentence`, and `buttonLabel` are
     rendered exclusively from a closed table of compiled static templates
     parameterized only by category ID, integer byte/count totals, and compiled
     allowlist display names (zero user-derived folder names, mount labels, or
     parent-folder strings). `spaceAction.id` and `spaceSubgroup.id` are
     restricted strictly to compiled static identifiers (e.g.,
     `action:developer_review`, `allowlist:<id>`, `bucket:build_artifacts`,
     `type:heic`) or sequential opaque placeholders (`group-1`, `group-2`).
   - Compiled copy-only owner commands are emitted from static allowlist
     templates (never containing usernames or paths).
   - Every review and apply action is disabled on any `redacted: true` payload
     across all sinks.
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
  space (including optional qualified `~N GiB est. purgeable` suffix on macOS)
  stays on the dim line. No extra Developer sentence above the bar.
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
- **Non-CoW vs CoW volume rendering:** The primary mocks below illustrate a
  comparable non-CoW Linux ext4 home volume where `System data 56.5 GiB` is a
  proved residual. On a CoW volume (such as macOS APFS), `System data` renders
  `Unknown` (`bytesKnown: false`), the dim line may append a qualified
  estimate (`154.2 GiB free (~28.4 GiB est. purgeable)`), and focusing `System
  data` explains that CoW clones and snapshots can share blocks.
- **Dataless / cloud-placeholder visibility across all three widths:** When a
  category contains cloud placeholders (`"Not stored on this disk"` subgroup),
  it is surfaced visibly on the default card at every standard width so
  `Photos` or `Documents` never appear empty:
  - At **120 columns**: shown directly in the right breakdown margin
    (`Not stored on this disk  18.2 GiB logical`, adding `(on-disk unknown)`
    for Windows `RECALL_ON_DATA_ACCESS`).
  - At **100 columns**: shown in the inline `"In <Category>:"` breakdown block
    directly beneath the 3-column legend.
  - At **80 columns**: included directly in the focused category's footer
    sentence (e.g., `"Photos: 44.1 GiB (+18.2 GiB not stored on this disk). Personal files are info-only."`, or `"Photos: on-disk unknown (18.2 GiB cloud placeholders). Personal files are info-only."`), with full subgroup details on `Enter`.

#### 120 columns x 30 rows (max line width <= 119 cells)

```text
◆ sweep  ~ (home, ext4 512 GiB)                                                                      154.2 GiB free

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
◆ sweep  ~ (home, ext4 512 GiB)                                                     154.2 GiB free

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
- Incomplete or stale state (`coverage.complete === false` due to
  `incompleteReasons`, or `cached === true`): prefix the headline with `~`,
  display `Partial scan` or `Cached Xh ago` on the right status text, and
  disable every review action button until a fresh complete scan finishes.
  Deliberate `scopeExclusions` (such as ordinary cloud placeholders or another
  mounted volume) display their explanatory subgroup/note without marking the
  entire scan incomplete.

#### Focused category sentence and single action (plain copy, no em dashes)

- **Actionable categories (when complete, fresh, unredacted, and `bytesKnown: true`):**
  - `Developer`: `"Developer has 31.4 GiB of build output across 112 projects."`
    `[ c Review Developer ]` (always quotes eligible artifact bytes strictly
    outside protected personal folders and sealed bundles).
  - `Caches`: `"Caches are using 34.2 GiB. Apps rebuild allowlisted caches when they need them."`
    `[ c Review Caches ]`
  - `Trash`: `"Trash holds up to 19.4 GiB of items in Trash. Emptying is permanent and local snapshots may still hold blocks."`
    `[ c Review Trash ]` (omits button on Windows while Windows Trash stays
    reporting-only).
- **Info-only categories:**
  - `Photos` (and other personal categories): `"Photos: 44.1 GiB. Personal files are info-only. Sweep never queues or removes them."` (No action button; appends `(+18.2 GiB not stored on this disk)` at 80 cols when cloud placeholders are present.)
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

| Phase        | PR scope                                                   | Prerequisites                    | Deliverables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Apply authority change?                            |
| ------------ | ---------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Phase 0a** | Guardrail authority hardening (**own PR**)                 | None                             | Prefix-block `/etc`, `/sys`, `/proc`, `/dev`, `/boot`, `/bin`, `/sbin`, `/lib`, `/lib64`, and `C:\Windows` in `assertSafeCwd` (JS + Rust), keeping `/var` and `/usr` exact-match so `/var/www` and `/usr/local` stay valid; harden `SYSTEM_TOOL_DIRS`; harden Windows PATH-only executable resolution; add JS + Rust regression tests.                                                                                                                                                                                                                                                                    | **Yes, authority-only PR** (Rule 5)                |
| **Phase 0b** | Product direction and decision log                         | Owner approval of plan           | Apply the proposed edits to `.docs/product-direction.md` and `.docs/decision-log.md` (including the cache direct-delete exception and generic Temp exclusion).                                                                                                                                                                                                                                                                                                                                                                                                                                            | None (docs only)                                   |
| **Phase 1**  | Protocol, discriminated schemas, read-only guard, L4 cache | Phase 0a                         | Add Draft 2020-12 discriminated-union `space-report.schema.json`, `space-event.schema.json`, aggregate-only `SpaceCacheSnapshot` schema, optional additive `policyProfile: "standard" \| "space_handoff"` on `ScanPlan`, TS types (`packages/protocol`), Rust serde types (`crates/sweep-types`), `sweep schema` exports, `assertSafeReadOnlyRoot` (JS + Rust), and closed typed redaction serializer contract across all sinks.                                                                                                                                                                          | None (read-only contract + additive schema)        |
| **Phase 2**  | Rust `sweep-engine space` and bench harness                | Phase 1                          | Single-pass LIFO space walker with resumable cursors in `crates/sweep-fs`; process-wide macOS `setiopolicy_np` BEFORE all path/L4 work + isolated cancel-aware TCC probe + APFS Data volume + qualified `estimatedPurgeableBytes`; Windows `KF_FLAG_DONT_VERIFY` + enumeration-first root/ancestor check + unknown allocation for `RECALL_ON_DATA_ACCESS` + long paths; Linux `mount_id` bind-mount + XDG mount-identity + snapshot/autofs/WSL/network boundaries; universal invoking-user isolation across all scopes; sealed bundles & personal roots winning before catalog; `scripts/bench-space.ts`. | None (read-only)                                   |
| **Phase 3**  | JS engine parity (fail-closed), CLI `sweep space`, L4      | Phase 2                          | Linux-only fail-closed JS fallback `packages/core/src/space-scanner.ts` (refuses on macOS/Windows and unverified mounts), CLI `sweep space [path]` (`--json`, `--json-stream`, `--redact`, `--metric`, `--no-cache`, zero destructive flags, no `--si`), `packages/display` storage card renderer, path-free `space-cache.json` (L4), shell completions.                                                                                                                                                                                                                                                  | None (read-only)                                   |
| **Phase 4a** | Developer `space_handoff` apply authority (**own PR**)     | **Phase 0a, Phase 1, G3**        | Implement full `policyProfile: "space_handoff"` authority across review, saved plans (`loadPlan` / `sweep apply --plan`), committed confirmation contract, and **both** JS and Rust apply engines with **G3** handle-relative containment, Rust capability `"spaceHandoffApply": true`, fail-closed refusal on older/unverified backends (no silent fallback), invoking-user ownership checks (even under elevation), positive artifact eligibility, and protected personal roots & sealed bundles strictly winning (both _within_ and _containing_ a protected root); full adversarial tests.            | **Yes, authority-only PR** (Rule 5, S3 + G3 gates) |
| **Phase 4b** | TUI `SpaceView` and independent Developer handoff UI       | **Phase 3, Phase 4a** (needs G3) | Dithered dot-matrix `StackBar` v2, Direction R + `disk*` tokens in `theme.ts`, `SpaceView.tsx` at 80/100/120 cols + narrow/short fallbacks + visible `"Not stored on this disk"` at all widths, `sweep ui --view space` + `w` / `Ctrl+K` switcher, independent invoking-user project picker into fresh `ProjectsView` scan (`policyProfile: "space_handoff"`, empty queue, zero report paths passed, live trusted review state).                                                                                                                                                                          | None (UI only; reuses Phase 4a boundary)           |
| **Phase 5a** | Cache apply authority (**own PR**)                         | **Phase 1, G3 containment**      | Compiled per-OS cache allowlist (`packages/core/src/cache-allowlist.ts` + Rust parity, excluding generic Windows Temp), instance-bound confirmation records (`allowlistId`, invoking user, canonical path, root identity, volume) including wildcard profiles, apply-time trusted-config re-derivation refusing replaced or newly discovered instances, ancestor/descendant personal-root & sealed-bundle exclusion, G3 no-follow/no-cross-mount handle removal, active-process blocking + unknown-state display-only, restart exclusion, journals, copy-only owner table, destructive fixture tests.     | **Yes, authority-only PR** (Rule 5, G3 gate)       |
| **Phase 5b** | Cache review overlay and TUI wiring                        | Phase 4b, Phase 5a               | `CacheReviewOverlay.tsx` (`Comes back on its own` / `Check first`, `s` selects only idle safe regenerable instances, `c` opens instance-bound committed permanent-delete confirm, copy-only command display; generic Temp never selectable) wired to Phase 5a authority.                                                                                                                                                                                                                                                                                                                                  | None (UI only)                                     |
| **Phase 6a** | Trash apply authority (**own PR**)                         | **Phase 1, G3 containment**      | Platform Trash discovery (home + external roots: macOS `.Trashes/<uid>`, Linux sticky non-symlink `.Trash/<uid>` or `.Trash-<uid>`, Windows per-drive bin), verified invoking user + pinned volume identity re-stat + confirmed entry-snapshot removal, `.trashinfo` paths excluded from journals/receipts, Windows per-item verified deletion (or reporting-only gate until verified), destructive fixture tests.                                                                                                                                                                                        | **Yes, authority-only PR** (Rule 5, G3 gate)       |
| **Phase 6b** | Separate Trash confirm overlay and TUI wiring              | Phase 4b, Phase 6a               | Dedicated `TrashConfirmOverlay.tsx` (permanent-delete warning, `"up to N GiB"`, named volume/drive, snapshot caveat, never bundled with other queues) wired to Phase 6a authority.                                                                                                                                                                                                                                                                                                                                                                                                                        | None (UI only)                                     |
| **Phase 7**  | Website card and user docs                                 | Phase 4b                         | Interactive `SpaceCard` on `apps/docs` landing page (single typed fixture + arithmetic unit tests, 150 ms pointer hover / 0 ms keyboard focus / reduced motion snap), `docs/users/space.md` (with binary GiB vs Finder decimal GB note), updates to `docs/users/privacy.md`, `docs/users/safety.md`, and `docs/users/commands.md`.                                                                                                                                                                                                                                                                        | None (docs and web only)                           |

### 7.2 Verification and test matrix

1. **Per-category, per-OS synthetic fixtures (`packages/test-fixtures/`):**
   - **Linux:** custom `XDG_CONFIG_HOME/user-dirs.dirs` (localized names,
     adversarial `XDG_DESKTOP_DIR="$HOME/"`, XDG folder on another mount ->
     `"on another disk"`, AND XDG folder outside `$HOME` on the **same mount**
     -> `"outside home scope"` on `home` scope / classified on `volume` scope),
     **same-device bind mount** (`mount_id` detection, not missed by `st_dev`),
     nested vs explicit network mount (`nfs`/`smb`/`9p` skipped when nested;
     explicit root uses `allocated_unavailable` and disables destructive
     review), `~/.cache` with allowlisted + non-allowlisted dirs + redirected
     `XDG_CACHE_HOME` pointing to `~/Documents`, FreeDesktop Trash (home +
     sticky `.Trash/<uid>` + non-sticky fallback `.Trash-<uid>`), sealed
     Flatpak/Snap trees containing `node_modules` (0 actionable bytes,
     including when scan starts inside the bundle), `~/Projects` with eligible
     artifacts and source/media, artifacts _inside_ `~/Documents`/`~/Downloads`
     (0 actionable bytes), sparse `.img`, cross-category hardlink web under
     parallel workers, snapshot trees (`.zfs`, `.snapshots`), unreadable `chmod
     000` dir, ANSI-escape filename.
   - **macOS (unit + hosted macOS CI release gates):** `.app` and `.framework`
     bundles containing Electron `node_modules` and `.png`/`.wav` assets (0
     actionable bytes, including when scan starts inside `Foo.app/Contents/
     Resources/app`), `*.photoslibrary` sealed as `photos`, skipped privacy
     containers (verify zero `open`/`read_dir` calls on Mail/Messages/Safari),
     APFS Data volume parity (`sweep space /` == `sweep space ~`), qualified
     `estimatedPurgeableBytes = max(0, importantUsageCapacity - availableBytes)`
     with independent `snapshotCount` (never inferring snapshot membership),
     **native macOS TCC qualification** (not only injected `EPERM`: test prompt
     dismissal, cancellation while a probe is pending within <100 ms ack,
     protected Photos library, and iCloud Drive roots -> `bytesKnown: false`,
     totals unset, `tcc_or_permission`), and **native File Provider no-recall
     test** asserting **both** zero file data hydration AND zero cloud provider
     directory enumeration fetches (via provider callback/telemetry check)
     across host validation, L4 cache-key lookup, redirected roots, and the
     walk, plus JS fallback fail-closed refusal (`no_recall_policy_unavailable`).
   - **Windows (unit + hosted Windows CI release gates):** Known Folders via
     `KF_FLAG_DONT_VERIFY` (including a profile-relative junction resolved via
     `SHGetKnownFolderPath`), non-Known-Folder junction (never followed),
     sealed `Program Files` / `WindowsApps` containing `node_modules` (0
     actionable bytes, including scan inside bundle), long paths deeper than
     260 characters, generic `%LOCALAPPDATA%\Temp` strictly `info_only` (never
     selectable, rejected if forged into a `CacheCleanPlan`), **partially
     resident `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` placeholder fixture**
     verifying `allocatedKnown: false` (never blanket `0 B`),
     `placeholder_allocation_unknown`, `accountingDomainComparable: false`, and
     visible `"Not stored on this disk"` subgroup at 80/100/120 cols, **native
     OneDrive / Cloud Filter no-recall test** asserting **both** zero local
     allocation gain (zero hydration) AND zero provider directory enumeration
     fetches (`CF_CALLBACK_TYPE_FETCH_DATA` / `CF_CALLBACK_TYPE_FETCH_PLACEHOLDERS`
     = 0) across host validation, L4 key lookup, redirected Known Folders, and
     the walk, plus JS fallback fail-closed refusal and per-drive Recycle Bin
     query.
2. **Account isolation fixtures (ALL scopes, nonstandard profiles, elevated runs):**
   - Explicit foreign path (`sweep space /home/other/proj`, `sweep space
     /srv/users/other/proj`, `sweep space D:\Profiles\Other\proj`) -> refused
     with `EXIT.GUARDRAIL` (2) before traversal and with **zero** foreign paths
     emitted in `space_progress.currentDir`.
   - Nonstandard / redirected profile roots discovered from OS account database
     (`getpwent` / Windows `ProfileList`) plus `/Users/Shared` and
     `FOLDERID_Public` on `--scope volume` -> zero paths, zero subgroups, zero
     actions.
   - Elevated runs (`sudo` with `SUDO_UID` set, `root` with `SUDO_UID` unset ->
     exit 2, Windows admin token) verified across scanner, independent
     Developer project picker, and both JS and Rust apply engines.
3. **Accounting domain, CoW, no-double-count, and coverage-model tests:**
   - **Below-capacity CoW clone overlap fixture** (where `sum(classified) <=
     volume.usedBytes` on a CoW volume) asserting the mandated outcome:
     `volume.accountingDomainComparable === false`, `cow_unproved_domain` in
     `accountingCaveats`, `system_data.bytesKnown === false`,
     `system_data.unknownReason === "incomparable_domain"`, and `allocatedBytes`
     / `apparentBytes` omitted on `system_data`.
   - Above-capacity overlap (`invalid_residual` + `clone_or_compression_overlap`).
   - **Multi-user volume no-double-count fixture** on a non-CoW volume
     asserting `classified_invoking_same_dev + system_data.allocatedBytes ==
     volume.usedBytes` (other accounts never added a second time).
   - Hardlinks spanning multiple categories under parallel workers (identical
     deterministic attribution across repeated runs), `hardlink_dedup_cap`
     (asserting `clone_or_compression_overlap` is NOT emitted), separate `/home`
     volume wording, quota/reserved-block cases, and network FS zero `st_blocks`
     (`allocated_unavailable`).
   - **Scope exclusions vs incomplete coverage:** ordinary `scopeExclusions`
     (`cloud_placeholders_excluded`, `other_volumes_excluded`,
     `privacy_containers_excluded`) keep `coverage.complete === true` and allow
     independently validated local review actions; any `incompleteReasons`
     (`tcc_or_permission`, `hardlink_dedup_cap`, `cycle_cap`, `queue_cap`,
     `permission_denied`) sets `coverage.complete === false` and disables all
     review actions.
4. **Protocol schema, guardrail, and authority tests (BOTH JS and Rust engines):**
   - Draft 2020-12 schema validation tests asserting rejection of:
     - mismatched `spaceAction` pairs (`category: "developer"` + `intent:
       "trash_review"`, `allowlistIds` on `developer_review`/`trash_review`,
       `statusLabel` on `developer_review`, any action on a personal category),
     - personal categories with non-`info_only` `actionability` or subgroups,
     - `bytesKnown: false` with `allocatedBytes` present or `unknownReason`
       missing, and `allocatedKnown: false` with `allocatedBytes` present,
     - `complete: true` with non-empty `incompleteReasons`.
   - Prove `assertSafeCwd` refuses `~`, `/`, `C:\`, `C:\Windows\System32`,
     `/etc/ssh`, `/bin/sh`, `/System/Library` while allowing `/var/www/app` and
     `/usr/local/src/app`.
   - Prove `SpaceReport` JSON is rejected by `loadPlan` and `sweep apply --plan`.
   - Test full **report -> UI -> saved-plan -> apply** Developer `space_handoff`
     path in both engines with:
     - forged report hints, custom patterns,
     - a candidate **within** a protected personal root (e.g.
       `~/Documents/proj/node_modules`) and **within** a redirected personal
       root,
     - a candidate **containing** a protected personal root or sealed bundle
       (mixed subtree),
     - a scan root started **inside** a sealed bundle or redirected personal
       root,
     - a **no-silent-fallback test** proving that if the native engine lacks
       `"spaceHandoffApply": true` or G3 containment, `space_handoff` apply
       refuses (`EXIT.GUARDRAIL`) instead of falling back to ordinary/older
       apply authority.
   - Prove Cache apply rejects generic Windows `%LOCALAPPDATA%\Temp`, personal
     paths, non-allowlisted paths, redirected env conflicts, symlink swaps,
     mount-boundary swaps, process-state transitions (idle -> active or unknown
     process state), AND **wildcard profile swaps or newly discovered profile
     instances** added between review and apply.
   - Prove Trash apply rejects drive remapping, volume device-ID drift, symlink-
     swapped Trash roots, non-sticky `.Trash` parents, and files arriving after
     confirmation (new arrivals remain untouched; `.trashinfo` original paths
     never appear in journals or receipts).
5. **Closed redaction and privacy tests across every dispatch sink:**
   - Run distinctive sentinel usernames, folder names, mount labels, and paths
     through `--json --redact`, `--json-stream --redact`, human stdout
     `--redact`, stderr (including cancellation and native-child fallback
     diagnostics), TUI redacted state, alternate programmatic callers, and
     `space-cache.json`, asserting zero sentinel leakage in every field
     including `insight`, `reason`, `sentence`, `buttonLabel`, `spaceAction.id`,
     and `spaceSubgroup.id`, and asserting actions stay disabled on redacted
     payloads.
6. **Engine parity, TUI, Web, and benchmark qualification:**
   - Normalized JS-vs-Rust `SpaceReport` diff on shared Linux fixtures verifying
     identical category assignments, allocated/apparent totals, hardlink
     ownership, `bytesKnown` states, and `system_data` behavior.
   - PTY tests at `80x24`, `100x28`, `120x30`, `70x24`, `80x16`, `NO_COLOR=1`,
     and `SWEEP_REDUCED_MOTION=1` measuring every rendered line in terminal
     cells (`<= width - 1`), verifying 3-col legend at 80/100/120, visible
     `"Not stored on this disk"` placeholder indicator at 80/100/120, `Esc`
     unwinding without quitting, `Space`/`a`/`s` no-op on overview, `c` review
     disabled on incomplete/stale/redacted cards, and separate Trash confirm.
   - Web tests for `SpaceCard` arithmetic derivation, focus restore on modal
     close, 150 ms pointer hover vs 0 ms keyboard focus, reduced-motion snap,
     320 px mobile viewport, 200% zoom, and >= 3:1 swatch contrast in light and
     dark themes.
   - Published benchmark harness (`scripts/bench-space.ts`, delivered in Phase 2) run over generated wide/deep trees, unique hardlink webs, slow
     consumers (backpressure), and blocked I/O on Linux (true cold + warm),
     macOS, and Windows before locking regression gates.

### 7.3 Open questions for the owner

Reviewers converged on Questions 1, 4, and 5, and surfaced an explicit safety
tradeoff on Questions 2 and 3. Revision 3 implements the stricter safety
boundary by default for Questions 2 and 3 and presents the differences below
for owner confirmation:

1. **`sweep ui ~` invocation (reviewers converged):**
   - **Recommended (owner to confirm):** Keep refusing `sweep ui ~`; ship
     `sweep space` and `sweep ui --view space` as the only entrypoints. Bare
     `sweep ui <path>` already means project cleanup review guarded by
     `assertSafeCwd`, so keeping home-wide space walks explicit avoids merging
     a guardrail and a full-home walk into the same command. Consider aliasing
     later only after the space view is qualified and proven unable to
     construct a `ScanPlan`.
2. **Developer artifacts vs protected personal folders (reviewer divergence; rev 3 enforces stricter rule):**
   - **Difference surfaced in reviews:** Review 2 suggested allowing catalog
     artifacts (`node_modules`, `target`, `.next`) found inside `Documents`,
     `Desktop`, or `Downloads` to count under `Developer` as reviewable.
     Review 1 and the re-check noted that a matching directory name and project
     marker do not guarantee an absence of authored files inside that subtree,
     and that allowing deletion inside personal folders conflicts with the
     owner's information-only personal-folder boundary.
   - **Default in rev 3 (owner to confirm):** Protected personal folders
     (`Pictures`, `Movies/Videos`, `Music`, `Documents`, `Downloads`, `Desktop`,
     including redirected roots) and sealed bundles **always win (`info_only`,
     zero actionable bytes)** in both the Space classifier and both apply
     engines under `policyProfile: "space_handoff"`. Inside recognized project
     roots _outside_ personal folders and sealed bundles, source files, `.git`,
     and project media count under `Developer` as an `info_only` subgroup, and
     review sentences quote eligible artifact bytes only.
3. **Cache deletion, generic Windows Temp, and Windows Trash (reviewer divergence on Temp; rev 3 enforces stricter rule):**
   - **Difference surfaced in reviews:** P-S11 requested marking Windows
     `%LOCALAPPDATA%\Temp` as `Check first` (opt-in, never bulk-selected).
     C-B2 and the re-check noted that general-purpose Temp can hold the only
     copy of an unlocked user file, so opt-in and locked-file skips do not
     establish regenerability under the verified-cache-only rule.
   - **Default in rev 3 (owner to confirm):**
     - Delete verified `"Comes back on its own"` allowlisted cache leaves
       directly after an instance-bound permanent-delete confirmation (no Trash
       toggle; record this cache-specific exception in `.docs/decision-log.md`).
     - Keep `"Check first"` allowlisted leaves (Gradle, Playwright, Hugging
       Face) opt-in per instance, and keep all owner-tool commands copy-only
       (never `sudo`).
     - **Exclude generic Windows `%LOCALAPPDATA%\Temp` (and any generic temp
       dir) from the deletion allowlist** so it stays strictly `info_only`
       (only audited application-owned cache leaves satisfying restart
       exclusion may be added).
     - Keep Windows Trash reporting-only until verified per-item deletion lands
       (unless the owner later logs an explicit single-drive live-bin
       decision-log exception).
4. **macOS Spotlight (`mdfind`) (reviewers converged):**
   - **Recommended (owner to confirm):** No Spotlight in v1. Ship the
     filesystem walk and compiled extension table across all OSes. Revisit
     optional insight-only enrichment only after native no-recall tests pass,
     off by default and never altering byte totals.
5. **Binary units (`GiB`/`MiB`) vs `--si` (reviewers converged):**
   - **Recommended (owner to confirm):** Binary `GiB`/`MiB` only across CLI,
     TUI, and website; JSON in integer bytes; no `--si` flag. Add one sentence
     in `docs/users/space.md` explaining macOS Finder's decimal GB display.

---

## 8. Review resolution

Honest per-finding ledger across all three reviews on PR #143:

- **Review 1 (Correctness, `dede206`)**: `C-B1` to `C-N1`
- **Review 2 (Platform, `dede206`)**: `P-B1` to `P-N18`
- **Review 3 (Re-check `6087673281`, `0dc7a7b`)**: `R-B1` to `R-N1`

No item is marked `Resolved` unless the specification text in this revision
fully addresses it without contradiction. Implementation deliverables that
cannot exist in a plan-only PR, and features deliberately scoped out of v1, are
explicitly marked `Deferred` with their reasons below.

| ID    | Review      | Severity   | Finding summary                                                                                                                                      | Status       | Plan section(s)                         | Resolution or deferral reason                                                                                                                                                                                                                                          |
| ----- | ----------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-B1  | Correctness | Blocker    | Keep report data out of Developer apply path; enforce positive artifact eligibility & mixed-subtree blocks                                           | **Resolved** | §§1.2, 2.1, 2.2, 3.1, 7.1 (4a/4b), 7.2  | Discriminated `spaceAction` union; independent picker; `policyProfile: "space_handoff"` through `ProjectsView`, saved plans, and both engines with G3 gate and no silent fallback; personal roots always win.                                                          |
| C-B2  | Correctness | Blocker    | Bounded cache leaves, apply-time identity/scope/owner-activity rechecks, copy-only owner commands, no generic Temp deletion                          | **Resolved** | §§1.2, 1.3, 2.1, 7.1 (5a), 7.2          | Generic Windows Temp removed from deletion allowlist (`info_only`); confirmation bound per exact reviewed instance (incl. wildcards); apply-time re-derivation, G3 handles, active/unknown blocks.                                                                     |
| C-B3  | Correctness | Blocker    | Bind Trash confirmation to verified user, volume identity, and confirmed item set; redesign Windows path                                             | **Resolved** | §§1.2, 3.2-3.4, 7.1 (6a), 7.2           | User, volume, and entry-snapshot binding; `.trashinfo` paths excluded from apply/journals; Windows Trash explicitly gated reporting-only until verified per-item deletion lands.                                                                                       |
| C-B4  | Correctness | Blocker    | No-recall policy before first FS op (macOS `setiopolicy_np`, Windows enumeration); drop MIME reads in v1                                             | **Resolved** | §§2.4, 3.1, 3.2, 3.4, 3.5, 7.2          | Process-wide `setiopolicy_np` and `KF_FLAG_DONT_VERIFY` + enumeration-first ancestor check precede all path/L4 work; JS fallback fails closed; MIME dropped; native hydration + enumeration tests specified.                                                           |
| C-B5  | Correctness | Blocker    | Path-free L4 cache; disable actions on stale/incomplete/redacted; closed redacted shape across all sinks                                             | **Resolved** | §§2.1, 2.2, 4.3, 5, 7.1 (1/3), 7.2      | Aggregate-only `SpaceCacheSnapshot`; closed static templates for `insight`/`reason`/`sentence`/`buttonLabel` and IDs under `--redact`; all dispatch sinks gated; §5 heading reconciled with live `targetDir`.                                                          |
| C-B6  | Correctness | Blocker    | Split authority changes from UI under Rule 5; make S3 & G3 explicit prerequisites                                                                    | **Resolved** | §7.1 (0a/0b, 4a/4b, 5a/5b, 6a/6b)       | Phase 0, 4, 5, and 6 split into authority-only PRs and follow-up docs/UI PRs; G3 containment + full apply/saved-plan/consent contract explicitly required in Phase 4a before 4b UI.                                                                                    |
| C-S1  | Correctness | Should-fix | Separate accounting domains; Unclassified volume usage residual; positive comparability rule; deterministic hardlinks                                | **Resolved** | §§1.1, 2.2, 3.6, 3.7, 7.2               | Positive comparability rule requires non-CoW proved domain; below-capacity CoW overlap fixture mandates `accountingDomainComparable: false` and `system_data` unknown; multi-user no-double-count specified.                                                           |
| C-S2  | Correctness | Should-fix | Publish replayable fixture generator & bench command; qualify real `sweep-engine space` pipeline cross-OS                                            | **Deferred** | §§4.1, 4.2, 7.1 (Phase 2), 7.2          | **Deferred to Phase 2:** Exact proxy invocation/options are now documented in §4.1 and proxy runs are labeled honestly, but the executable `scripts/bench-space.ts` harness and real-pipeline runs ship in Phase 2 (plan-only PR edits only `.plans/space-report.md`). |
| C-S3  | Correctness | Should-fix | Coordinated memory budget; split cycle state from hardlinks; resumable cursors; separate cancel ack/exit                                             | **Resolved** | §§2.4, 4.2, 4.3, 7.2                    | `VisitedDirs` separated from `SeenHardlinks`; coordinated caps; resumable directory cursors; cancel ack (<100 ms) tracked separately from worker exit.                                                                                                                 |
| C-N1  | Correctness | Nit        | Cite UX §3 and §5 committed-dialog rules; change "Already deleted" to "In Trash"                                                                     | **Resolved** | §§1.2, 2.2, 6.4                         | Both UX principles cited explicitly; schema and UI use `"In Trash"`.                                                                                                                                                                                                   |
| P-B1  | Platform    | Blocker    | Seal bundles (`.app`, `.framework`, `.photoslibrary`, Flatpak, Snap, Program Files, WindowsApps) early                                               | **Resolved** | §§1.1, 3.1 (Rule 3), 3.2-3.4, 7.2       | Rule 3 precedes personal folders, caches, catalog, and extension rules, including when the scan target starts inside a sealed bundle; zero actionable bytes tested.                                                                                                    |
| P-B2  | Platform    | Blocker    | macOS privacy containers skipped; non-blocking TCC probe; `bytesKnown: false` (unset total) on `EPERM`                                               | **Resolved** | §§2.2, 3.1, 3.2, 3.7, 6.3, 7.2          | Privacy containers never opened; TCC probe isolated in cancel-aware worker (never blocks main thread <100 ms ack); native dismissal/cancellation/Photos/iCloud qualification test specified for Phase 2 CI.                                                            |
| P-B3  | Platform    | Blocker    | Windows: no `GetCompressedFileSizeW` on placeholders; `FindFirstFileEx` + `FILE_FLAG_OPEN_NO_RECALL`; single-drive Trash                             | **Resolved** | §§3.4, 7.2                              | `KF_FLAG_DONT_VERIFY` + enumeration-first ancestor checks before opening; unknown allocation for `RECALL_ON_DATA_ACCESS`; native hydration + enumeration-fetch tests specified; Windows Trash report-only.                                                             |
| P-B4  | Platform    | Blocker    | Account isolation across all scopes, nonstandard profiles, and elevated runs; refuse root without `SUDO_UID`                                         | **Resolved** | §§2.3, 3.1 (Rule 1), 3.4, 3.7, 5, 7.2   | Applies to `home`, `volume`, and explicit `path` using OS account databases (`getpwent`/Open Directory/`ProfileList`), enforced before emitting `currentDir`, in Developer picker, and in both apply engines.                                                          |
| P-B5  | Platform    | Blocker    | APFS Data volume parity; qualified `estimatedPurgeableBytes`; no snapshot membership inference from count                                            | **Resolved** | §§2.2, 3.2, 3.7, 7.2                    | Data volume read for `/` and `~`; `estimatedPurgeableBytes` explicitly qualified as estimate or omitted; `snapshotsIncludedInPurgeable` removed; `snapshotCount` reported independently.                                                                               |
| P-B6  | Platform    | Blocker    | Ignore `ownerCommand` on input; compiled `argv` per `allowlistId` with no shell; `pacman`/`apt`/`dnf` copy-only                                      | **Resolved** | §§1.2, 1.3, 2.2, 7.1 (Phase 5a)         | No `ownerCommand` field in schema; all v1 owner commands are copy-only; future execution strictly via compiled `argv` without shell; package managers copy-only permanently.                                                                                           |
| P-S7  | Platform    | Should-fix | Waterfall-ordered parallel hardlink ownership; `hardlink_dedup_cap` only; drop APFS Time Machine claim; RAM budget                                   | **Resolved** | §§3.6, 4.2, 7.2                         | Winning category + tie-breaker stored on inode identity with atomic transfer; dedicated coordinated map cap; APFS Time Machine hardlink claim removed.                                                                                                                 |
| P-S8  | Platform    | Should-fix | Authoritative category-overlap table matching apply guard; artifact-only `estimatedBytes`                                                            | **Resolved** | §§1.2, 2.2, 3.1, 7.2, 7.3               | Single conflict-free 7-row overlap table: protected personal roots and sealed bundles strictly win over catalog/cache rules in classifier and both apply engines; divergence noted in §7.3.                                                                            |
| P-S9  | Platform    | Should-fix | Walk boundaries: mount identity (`mount_id`), snapshots, autofs, nested vs explicit network mounts, WSL, XDG mount check                             | **Resolved** | §§3.1, 3.3, 3.4, 3.6, 3.7, 7.2          | `mount_id` + `mountinfo` detects same-device bind mounts; XDG checks actual mount identity (not just "outside home"); nested network mounts skipped while explicit Linux network roots measure read-only.                                                              |
| P-S10 | Platform    | Should-fix | External trash roots per OS/uid; volume re-stat at confirm & apply; "up to N GiB" + snapshot caveat                                                  | **Resolved** | §§1.2, 3.2-3.4, 6.3, 7.2                | External trash roots verified per OS/uid; volume identity re-statted at confirm and apply; "up to" and snapshot caveats included.                                                                                                                                      |
| P-S11 | Platform    | Should-fix | Windows `%LOCALAPPDATA%\Temp` bulk safety                                                                                                            | **Resolved** | §§1.2, 1.3, 7.2, 7.3                    | Superseded by stricter R-B3 / C-B2 rule: generic `%LOCALAPPDATA%\Temp` is excluded from the deletion allowlist altogether and stays `info_only` (tradeoff documented in §7.3).                                                                                         |
| P-S12 | Platform    | Should-fix | Visible `"Not stored on this disk"` subgroup across widths; unknown allocation for partially resident placeholders                                   | **Resolved** | §§2.2, 3.2, 3.4, 3.6, 6.3, 7.2          | Subgroup shown at 80, 100, and 120 columns; Windows `RECALL_ON_DATA_ACCESS` emits `allocatedKnown: false` (`placeholder_allocation_unknown`) instead of blanket `0 B`.                                                                                                 |
| P-S13 | Platform    | Should-fix | Direction R (`costInstall`/`costCache`/`costCustom`) + `disk*` tokens; >= 3:1 on `meterTrack` incl. `other`                                          | **Resolved** | §§6.1, 7.2                              | Zero reuse of chartreuse/warning/danger/info; minimum contrast 3.67:1 dark and 4.20:1 light.                                                                                                                                                                           |
| P-S14 | Platform    | Should-fix | Card grammar (1 number, 1 sentence, 1 action), `c` review / `Enter` details, 3-col legend, `Esc` unwind, widths <= `width - 1`                       | **Resolved** | §§1.2, 2.1, 4.3, 6.2, 6.3, 7.2          | All grammar rules met; 80/100/120 mock lines verified strictly `<= width - 1`; `NO_COLOR` clarity; no em dashes in copy.                                                                                                                                               |
| P-S15 | Platform    | Should-fix | Label §4.1 as syscall-rate bound; binary GiB/MiB reconciliation; partial card disables review                                                        | **Resolved** | §§2.1, 4.1, 4.3, 6.3                    | Proxy runs labeled clearly; binary units only; `coverage.complete: false` disables review actions (fixed latency gates deferred to Phase 2/3 per C-S2).                                                                                                                |
| P-S16 | Platform    | Should-fix | Make `statusLabel` optional (unset for Developer); personal subgroups are type totals with no filenames                                              | **Resolved** | §§2.2, 5, 6.3                           | `developer_review` schema variant omits `statusLabel`; personal subgroups emit type totals only.                                                                                                                                                                       |
| P-N17 | Platform    | Nit        | Remove absent `F03`/`F07` IDs; spell OS prefix-block list (`/etc`..`C:\Windows`), keep `/var` & `/usr`                                               | **Resolved** | §§1.2, 7.1 (Phase 0a), 7.2              | Exact prefix list spelled out; absent audit IDs removed.                                                                                                                                                                                                               |
| P-N18 | Platform    | Nit        | Website pointer hover 150 ms; keyboard focus instant (0 ms); reduced motion snaps immediately                                                        | **Resolved** | §§6.4, 7.2                              | Motion rules explicitly specified and tested.                                                                                                                                                                                                                          |
| R-B1  | Re-check    | Blocker    | Resolve personal-folder conflict in favor of info-only boundary; test candidate within & containing protected root + inside bundle                   | **Resolved** | §§1.2, 3.1, 6.3, 7.2, 7.3               | Rule 3 (sealed bundles) and Rule 4 (protected personal roots, incl. redirected) precede caches and catalog in classifier and apply engines; tests cover within, containing, and scan-inside-bundle.                                                                    |
| R-B2  | Re-check    | Blocker    | Discriminated `spaceAction` schema; trusted live review state; `space_handoff` through `ProjectsView`/saved plans/both engines + G3                  | **Resolved** | §§1.2, 2.1, 2.2, 2.4, 7.1 (4a/4b), 7.2  | Draft 2020-12 `oneOf` discriminated unions on `spaceAction` & `spaceCategory`; `policyProfile: "space_handoff"` + `"spaceHandoffApply": true` + G3 gate in Phase 4a; no-silent-fallback test required.                                                                 |
| R-B3  | Re-check    | Blocker    | Remove generic Windows Temp from deletion allowlist; bind cache confirmation per exact reviewed instance (incl. wildcards)                           | **Resolved** | §§1.2, 1.3, 2.1, 7.1 (5a), 7.2, 7.3     | `%LOCALAPPDATA%\Temp` excluded from deletion allowlist (`info_only`); cache confirmation pins `(allowlistId, user, canonicalPath, rootIdentity, volume)` per concrete instance and refuses swaps/new profiles.                                                         |
| R-B4  | Re-check    | Blocker    | Fail-closed no-recall gate before all path/L4 work, caller thread, redirected roots, JS fallback; test hydration & enumeration fetches               | **Resolved** | §§2.4, 3.1, 3.2, 3.4, 4.3, 7.1, 7.2     | Process-wide `setiopolicy_np`, `KF_FLAG_DONT_VERIFY` + enumeration-first ancestor checks precede host/L4/root work; JS fallback refuses on macOS/Windows; native hydration + enumeration-fetch tests gated.                                                            |
| R-B5  | Re-check    | Blocker    | Universal account isolation across explicit paths, nonstandard profiles, and elevated runs before progress paths & apply                             | **Resolved** | §§2.1, 2.3, 3.1, 3.4, 5, 7.2            | OS account databases (`getpwent`/Open Directory/`ProfileList`) enforced across `home`/`volume`/`path`, before `currentDir`, in Developer picker, and in both apply engines; explicit/nonstandard/elevated tests.                                                       |
| R-S1  | Re-check    | Should-fix | Positive comparability rule & below-capacity CoW outcome; no-double-count other accounts; qualified purgeable estimate; Windows partial placeholders | **Resolved** | §§2.2, 3.2, 3.4, 3.6, 3.7, 6.3, 7.2     | CoW volumes set `accountingDomainComparable: false` (`system_data` unknown); no-double-count rule & fixture; `estimatedPurgeableBytes` estimate; `allocatedKnown: false` for `RECALL_ON_DATA_ACCESS`.                                                                  |
| R-S2  | Re-check    | Should-fix | Separate deliberate `scopeExclusions` from `incompleteReasons` action gating; fix "always includes both" byte-field wording                          | **Resolved** | §§2.1, 2.2, 3.2-3.4, 3.6, 4.3, 6.3, 7.2 | `coverage` split into `incompleteReasons` (sets `complete: false`, disables review), `scopeExclusions` (normal boundaries, allows validated local reviews), and `accountingCaveats`; byte-field wording fixed.                                                         |
| R-N1  | Re-check    | Nit        | Reconcile §2.1 "never mutates the filesystem" with §4.3 L4 cache write                                                                               | **Resolved** | §2.1                                    | §2.1 now states the command leaves the scanned tree untouched and describes the `<configDir>/space-cache.json` aggregate-cache write explicitly.                                                                                                                       |
| Q1-Q5 | All three   | Open Qs    | Present owner questions honestly without overclaiming consensus on personal-folder exceptions and generic Temp                                       | **Resolved** | §§1.5, 2.1, 3.2, 6.4, 7.3               | Q1/Q4/Q5 reflect reviewer convergence; Q2 and Q3 explicitly document reviewer differences and default to the stricter safety boundaries pending owner sign-off.                                                                                                        |

### Explicitly deferred items (tracked with rationale)

1. **Executable fixture generator and cross-OS benchmark qualification (`C-S2` / `scripts/bench-space.ts`):**
   Deferred to **Phase 2** alongside `sweep-engine space`, because this PR is a
   design-plan-only document change (`.plans/space-report.md` only). Fixed
   wall-time regression thresholds remain deferred until the real single-pass
   classifier is benchmarked cold and warm across Linux, macOS, and Windows.
2. **Executing owner-tool commands (`C-B2` / `P-B6`):**
   Deferred out of v1. All owner-tool commands (`brew cleanup`, `pnpm store
   prune`, `pacman`, `apt`, `dnf`, `yay`/`paru`, `xcrun simctl`) are copy-only
   in v1; any future execution requires a compiled `argv` table with no shell
   and keeps system package managers copy-only permanently.
3. **Windows Recycle Bin emptying (`C-B3` / `P-B3`):**
   Deferred to reporting-only until verified per-item `$Recycle.Bin\<SID>`
   deletion is implemented and qualified on Windows CI (or the owner explicitly
   approves a separate decision-log entry for a single-drive live-bin
   confirmation contract).
4. **Generic Windows `%LOCALAPPDATA%\Temp` cleanup (`R-B3` / `C-B2`):**
   Excluded from the v1 deletion allowlist (`info_only`) because general-purpose
   temp directories can hold the only copy of an unlocked file; only audited
   application-owned cache leaves meeting the restart-exclusion rule may be
   added later.
5. **Exact CoW physical extent deduplication (`C-S1` / `R-S1`):**
   Deferred out of v1 (requires root or per-file extent maps such as `FIEMAP`
   or APFS clone extent APIs). CoW volumes report attributed allocation per
   category and explicitly mark `system_data` unknown
   (`accountingDomainComparable: false`, `cow_unproved_domain`).
6. **MIME content probes and macOS Spotlight `mdfind` (`C-B4` / `Q4`):**
   Dropped/deferred from v1 to guarantee strict metadata-only access and zero
   cloud recall risk.
7. **Native macOS (TCC / File Provider) and Windows (Cloud Filter) CI test execution (`P-B2` / `P-B3` / `R-B4`):**
   Specified as mandatory release gates in Section 7.2; execution occurs on
   hosted macOS and Windows runners during Phases 2 through 6.
