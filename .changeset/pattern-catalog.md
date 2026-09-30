---
"@kitsunekode/sweep": minor
---

Rework the pattern catalog around a strict trust boundary and add a real pattern editor to the TUI:

- Defaults now ship only machine-created, ecosystem-canonical names (`node_modules`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.vite`, `.parcel-cache`, `.nyc_output`, `target`, `*.tsbuildinfo`). Generic names that can hold authored files — `dist`, `build`, `out`, `coverage`, `.venv`, `__pycache__`, `Pods`, `.gradle`, `.dart_tool`, `cmake-build-*`, and more — are still curated in the catalog but ship **opt-in**. The same catalog is mirrored in the Rust engine's `default_patterns()`.
- Opt-in and custom matches now land in the `dangerous` risk tier on both engines: enabling a pattern consents to _scanning_ for it, never to selecting it — they are never pre-selected and never enter bulk selection. Candidate `reasons` distinguish `default-pattern`, `opt-in-pattern`, and `custom-pattern`.
- The `p` pane is a grouped, searchable, windowed pattern editor: `/` filters the catalog, `a` adds a custom pattern (validated by the same rules config files use), `d` removes customs (catalog entries can only toggle off), `space`/`enter` toggles, and keystrokes are fully isolated from artifact-list actions.
- `w` writes the current toggle set to the project `.sweeprc` as a minimal delta (`patterns` + `disabledPatterns` only); an existing file is never clobbered silently — `W` is the deliberate overwrite. The write refuses symlinked paths and uses exclusive temp-file creation + rename.
- The `?` help overlay is regrouped into move / queue / filter & view / patterns / app sections, and the statusline marks `rescan*` while edited patterns await a rescan.
- macOS blocked-root checks now fold case on both sides (a `/USERS/name` spelling can no longer walk past the home-directory guard on case-insensitive APFS), and the Rust engine resolves `..` in target paths the same way the JS engine does instead of diverging on it.
