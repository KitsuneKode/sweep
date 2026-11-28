---
"@kitsunekode/sweep": patch
---

Polish human-readable CLI output to match Direction C+ semantics and fix CLI formatting regressions:

- **`sweep doctor`**: Replace ragged tab-separated TTY output with a one-line summary banner, grouped sections (`ENVIRONMENT & SAFETY`, `CONFIGURATION`, `RUNTIME & ENGINE`), status glyphs (`✓`, `!`, `✗`) with color only as a second cue, aligned columns, and middle-truncated paths within terminal width. `--json` output and exit codes remain unchanged.
- **`sweep scan`, `clean --dry-run`, `status`, `inspect --plan`, `stats`, `init --dry-run`, `--help`, and `printError`**: Align columns and tabular numbers consistently across sections, show guarded totals separately on the scan headline, indent TTY JSON previews for `init --dry-run`, group `--help` options (`SELECTION & FILTERS`, `SAFETY & MODE`, `OUTPUT & DISPLAY`), and route Commander usage errors through the shared error formatter.
- **Fixes (B14–B16)**: Indent multiline continuations in `printError`; emit `[caution]` instead of `[warning]` and keep transient spinner noise off piped `stdout`; fix sub-hour `idle 1h` clamping (`now` / `<1h`), American `"Colors:"` spelling in `ui --help`, and singular/plural wording across CLI output.
- **Color capability**: Add dynamic `NO_COLOR`, `FORCE_COLOR`, non-TTY (plain text with explicit status words), 16-color, 256-color, and truecolor Direction C+ palette support in `@kitsunekode/sweep-display`.
