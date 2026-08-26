# sweep

> Safe, recursive artifact cleanup for any project tree.

`sweep` deletes build artifacts — `node_modules`, `dist`, `.next`, `target`, and more — recursively across monorepos, with hard safety guardrails so you never accidentally wipe the wrong directory.

Think [`npkill`](https://github.com/voidcosmos/npkill), but monorepo-aware, risk-tiered, scriptable, and with a live TUI that boots instantly and streams results as it scans.

```
 ◆ sweep                                    12 found · 8 selected · 2.2 GB
 ╭─ scopes ────────────────╮ ╭─ artifacts ──────────────────────────────╮
 │  RECLAIM                │ │ ▌● node_modules              1.4 GB  ✓  │
 │  ██████████░░░░░░ 68%   │ │  ○ .turbo                     12 MB  ✓  │
 │  2.2GB of 3.2GB         │ │  ! coverage                  240 MB  !  │
 │ › all scopes  12  3.2G  │ │  ⊘ .git                              ⊘  │
 ╰─────────────────────────╯ ╰─ node_modules · directory · /path ───────╯
 NORMAL  j/k move · space toggle · s/a/u select · enter apply · ? help
```

---

## Install

```bash
npm install -g @kitsunekode/sweep
bun add -g @kitsunekode/sweep

# One-shot
npx @kitsunekode/sweep .
bunx @kitsunekode/sweep .
```

**Platforms:** Linux, macOS, Windows (Node.js ≥ 18 or Bun). Standalone binaries are
attached to GitHub releases for systems without a Node runtime.

---

## Quick start

```bash
sweep init              # scaffold .sweeprc (optional — defaults work out of the box)
sweep --dry-run         # preview what would be deleted
sweep                   # scan, confirm, delete
sweep ui .              # interactive TUI for monorepos
sweep doctor --json     # config + environment + dry-scan report
```

---

## Commands

| Command                     | Description                                      |
| --------------------------- | ------------------------------------------------ |
| `sweep` / `sweep clean`     | Default cleanup flow with prompt and guardrails  |
| `sweep scan`                | Scan only — list candidates, no deletion         |
| `sweep plan`                | Emit a saved-plan JSON document                  |
| `sweep ui`                  | OpenTUI interactive picker (TTY required)        |
| `sweep apply --plan <path>` | Apply a saved JSON plan                          |
| `sweep init`                | Create a starter `.sweeprc`                      |
| `sweep doctor`              | Validate config, check tooling, dry-scan preview |

`path` defaults to `.` on all path-taking commands.

### Common flags

| Flag                     | Short | Description                                        |
| ------------------------ | ----- | -------------------------------------------------- |
| `--dry-run`              | `-n`  | Preview deletions — no changes                     |
| `--yes`                  | `-y`  | Skip confirmation (CI / scripts)                   |
| `--force-large`          |       | Allow deletion over `maxSizeGB` (requires `--yes`) |
| `--pattern <p>`          | `-p`  | Add extra pattern (repeatable)                     |
| `--ignore <p>`           | `-i`  | Ignore path/name match (repeatable)                |
| `--disabled-pattern <p>` |       | Disable a default pattern for this run             |
| `--select <mode>`        |       | `default`, `safe`, `all`, or `none`                |
| `--include-dangerous`    |       | Include dangerous custom matches                   |
| `--depth <n>`            |       | Max recursion depth (`-1` = unlimited)             |
| `--config <path>`        |       | Explicit config file                               |
| `--engine <backend>`     |       | `js` (default), `rust`, or `auto`                  |
| `--no-color`             |       | Disable color output                               |

`scan` adds `--json` and `--json-stream`. `apply` adds `--json`. `doctor` adds `--json`.

### Examples

```bash
sweep clean ~/projects/myapp
sweep --dry-run -p .cache -p .output
sweep scan . --json > sweep-plan.json
sweep apply --plan sweep-plan.json --yes
sweep init --force
sweep doctor .
```

---

## Interactive UI (`sweep ui`)

The TUI boots **immediately** and fills in live as the scan streams — no spinner
phase. Review, filter, and delete without leaving the terminal.

### The screen

- **Scope tree** — artifacts grouped by directory; `h`/`l` (or clicking the
  header) collapses/expands groups, `w`/`e` folds/unfolds all
- **Risk glyphs** — `✓` safe · `!` caution · `✗` dangerous · `⊘` blocked (hard-locked)
- **Reclaim meter** — live selected-vs-total bytes with percentage
- **Statusline** — mode chip (`SCANNING`, `NORMAL`, …), contextual hints, active filters

### Keys

Arrows work everywhere; letter keys are speed aliases.

| Key                                | Action                             | Notes                                     |
| ---------------------------------- | ---------------------------------- | ----------------------------------------- |
| `↑↓` / `j k`                       | move cursor                        |                                           |
| `g` / `G` or `Home/End`            | first / last item                  |                                           |
| `Ctrl-U` / `Ctrl-D` or `PgUp/PgDn` | half page                          |                                           |
| `Space`                            | toggle selection                   | blocked items never toggle                |
| `s` / `a` / `u`                    | select safe · safe+caution · clear | bulk never touches dangerous              |
| `Enter`                            | apply deletion                     | red confirm when risky items are selected |
| `h` / `l` (or click header)        | collapse / expand group            | tree-style triage                         |
| `w` / `e`                          | collapse all · expand all          |                                           |
| `o`                                | sort size ↔ name                   | size-desc default                         |
| `/` then type                      | filter artifacts                   | matches name/path/kind/risk               |
| `Tab` / `Shift+Tab`                | cycle panes                        | artifacts ↔ scopes ↔ filter               |
| `1–4`                              | risk filter                        | all / safe / caution / dangerous          |
| `p`                                | pattern editor                     | toggle defaults, add customs — then `r`   |
| `r`                                | rescan from disk                   | honors pattern edits; safe mid-scan       |
| `t`                                | theme                              | dark · light · auto                       |
| `Esc`                              | **walk back one layer**            | never quits — see below                   |
| `q`                                | quit                               | explicit only                             |

**Esc philosophy:** pressing `Esc` unwinds exactly one thing per press — closes
the help modal, leaves the filter, clears the risk filter, clears scope,
clears text, expands groups. It can never exit the process or lose your
selection to a mis-press.

### Mouse

Scroll, hover, click-to-focus rows, click again to toggle, click group headers
to fold/unfold, drag the scrollbar.

---

## Config (`.sweeprc`)

Run `sweep init` to scaffold a starter file, or create `.sweeprc` manually (JSON):

```json
{
  "patterns": [".custom-output"],
  "ignore": ["packages/vendor-patched"],
  "maxSizeGB": 10,
  "depth": -1
}
```

All fields are optional. `patterns` and `ignore` merge with defaults — they do not replace them.

Disable a default pattern:

```json
{ "disabledPatterns": ["dist"] }
```

**Lookup order:** CLI flags → `.sweeprc` (walks up from target) → `~/.config/sweep/config.json` → built-in defaults.

---

## Default patterns

| Pattern                            | What it is                     |
| ---------------------------------- | ------------------------------ |
| `node_modules`                     | npm/yarn/pnpm/bun dependencies |
| `dist`, `build`, `out`             | compiled output                |
| `.next`, `.nuxt`, `.svelte-kit`    | framework build dirs           |
| `.turbo`, `.vite`, `.parcel-cache` | tool caches                    |
| `target`                           | Rust / Java / Maven output     |
| `coverage`, `.nyc_output`          | test coverage                  |
| `*.tsbuildinfo`                    | TypeScript incremental info    |

`.cache` is intentionally excluded — too broad for home directories.

---

## Safety

**Nothing is ever deleted on its own.** Scan, plan, and the TUI are read-only;
deletion requires `Enter` on a non-empty selection, and risky selections get a
red confirmation naming exactly what goes.

Layered guarantees:

1. **Hard-blocked targets** (not configurable): `/`, `/home`, `/usr`, your home
   root, Windows system roots, and anything inside `.git`/`.svn`/`.hg`.
2. **Tiered selection**: blocked items cannot be selected at all; dangerous
   items only via deliberate per-item toggle + red confirm; bulk `a` covers
   safe and caution tiers exclusively.
3. **Path revalidation** immediately before each deletion — changed symlinks,
   vanished paths, or anything escaping the target directory aborts that path
   without touching the rest.
4. **Size guardrail** — totals over `maxSizeGB` refuse to run without
   `--force-large --yes`.
5. **Symlinks are removed, never followed.** Path traversal (`..`, null bytes)
   rejected; unsafe patterns rejected at parse time.
6. **Partial-failure honesty** — the final report lists every path that failed
   and why; exit code reflects it.

---

## Exit codes

| Code | Meaning                          |
| ---- | -------------------------------- |
| `0`  | Success                          |
| `1`  | User aborted                     |
| `2`  | Guardrail violation              |
| `3`  | Config parse or validation error |
| `4`  | Filesystem error during deletion |
| `5`  | Doctor warnings                  |

---

## CI

```bash
sweep --yes --dry-run    # preview in logs
sweep --yes              # non-interactive cleanup
sweep doctor --json      # machine-readable health check
```

Non-TTY environments disable color and spinners automatically.

---

## License

MIT
