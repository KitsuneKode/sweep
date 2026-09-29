# sweep

> Safe, recursive artifact cleanup for any project tree.

`sweep` deletes build artifacts — `node_modules`, `dist`, `.next`, `target`, and more — recursively across monorepos, with hard safety guardrails so you never accidentally wipe the wrong directory.

Think [`npkill`](https://github.com/voidcosmos/npkill), but monorepo-aware, risk-tiered, scriptable, and with a live TUI that boots instantly and streams results as it scans.

```
 ◆ sweep                              18 found · 10 queued · 5.8 GB
 ╭─ scopes ───────────────╮ ╭─ artifacts ────────────────────────────────╮
 │  ████████░░░░░ 62%     │ │      Name                       Size       │
 │  5.8GB of 9.3GB        │ │ ──────────────────────────────────────     │
 │ › all scopes    18 9.3G│ │ ▾ apps/web/   3 · 2.4GB · 3 queued       █ │
 │ ▸ apps/          6 3.6G│ │ ▌ ● node_modules              1.7 GB     █ │
 │ ▸ .worktrees/    3 858M│ │   ● .next                   610.4 MB     █ │
 │                        │ │ ▾ vendor/legacy/           1 · 2.1GB     █ │
 │                        │ │   ○ target                    2.1 GB     ░ │
 ╰────────────────────────╯ ╰────────────────────────────────────────────╯
  ✓ node_modules  1.7 GB  /home/user/projects/monorepo/apps/web
    NORMAL  ↑↓ move · space queue · enter apply · / filter · ? help
```

---

## Install

```bash
npm install -g @kitsunekode/sweep
bun add -g @kitsunekode/sweep

# One-shot
npx @kitsunekode/sweep .
bunx @kitsunekode/sweep .

# Standalone binary (no Node/Bun needed)
curl -fsSL https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.sh | sh
```

**Platforms:** Linux (x64, arm64), macOS (x64, arm64), Windows (x64) — Node.js ≥ 18
or Bun. Standalone binaries are attached to GitHub releases.

**Shell completions:**

```bash
sweep completions zsh  > ~/.zsh/completions/_sweep        # dir must be in $fpath
sweep completions bash > ~/.local/share/bash-completion/completions/sweep
sweep completions fish > ~/.config/fish/completions/sweep.fish
```

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

| Command                       | Description                                      |
| ----------------------------- | ------------------------------------------------ |
| `sweep` / `sweep clean`       | Default cleanup flow with prompt and guardrails  |
| `sweep scan`                  | Scan only — list candidates, no deletion         |
| `sweep plan`                  | Emit a saved-plan JSON document                  |
| `sweep ui`                    | OpenTUI interactive picker (TTY required)        |
| `sweep apply --plan <path>`   | Apply a saved JSON plan                          |
| `sweep inspect --plan <path>` | Show a plan's provenance and totals — no apply   |
| `sweep stats`                 | Cleanup history + total reclaimed space          |
| `sweep init`                  | Create a starter `.sweeprc`                      |
| `sweep doctor`                | Validate config, check tooling, dry-scan preview |
| `sweep completions <shell>`   | Print completion script for bash, zsh, or fish   |

`path` defaults to `.` on all path-taking commands.

### Common flags

| Flag                     | Short | Description                                        |
| ------------------------ | ----- | -------------------------------------------------- |
| `--dry-run`              | `-n`  | Preview deletions — no changes                     |
| `--trash`                |       | Move to `.sweep-trash-<ts>/` instead of deleting   |
| `--yes`                  | `-y`  | Skip confirmation (CI / scripts)                   |
| `--force-large`          |       | Allow deletion over `maxSizeGB` (requires `--yes`) |
| `--pattern <p>`          | `-p`  | Add extra pattern (repeatable)                     |
| `--ignore <p>`           | `-i`  | Ignore name, glob, or path prefix (repeatable)     |
| `--disabled-pattern <p>` |       | Disable a default pattern for this run             |
| `--select <mode>`        |       | `default`, `safe`, `all`, or `none`                |
| `--include-dangerous`    |       | Include dangerous custom matches                   |
| `--depth <n>`            |       | Max recursion depth (`-1` = unlimited)             |
| `--config <path>`        |       | Explicit config file                               |
| `--engine <backend>`     |       | `js` (default), `rust`, or `auto`                  |
| `--no-color`             |       | Disable color output                               |
| `--quiet`                | `-q`  | Suppress non-essential output                      |
| `--verbose`              |       | Per-candidate scan progress                        |

`--json` is global (structured output for `scan`, `apply`, `doctor`, and the
default `clean` flow). `scan` additionally offers `--json-stream` — newline-
delimited `ScanEvent`s while the scan runs.

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
- **Status mark** — one glyph per row: `●` queued / `○` idle / `⊘` blocked
  (hard-locked). Color carries the risk tier — safe is accent, caution amber,
  dangerous red
- **Group headers** — every group is headed `▾ apps/web/ · 3 · 2.4GB`, even
  single-item ones, so no orphan row reads as part of the group above it. The
  owning header sticks at the top while its group scrolls past
- **Reclaim meter** — live selected-vs-total bytes with percentage
- **Statusline** — mode chip (`SCANNING`, `NORMAL`, …), contextual hints,
  active filters; dead keys report why they did nothing
- **Scale** — the list is windowed: only visible rows render, so thousands of
  artifacts stay at single-digit-ms per keystroke. While a scan runs, rows
  hold discovery order so nothing moves under the cursor; the list re-sorts
  once when the scan completes

### Keys

Arrows work everywhere; letter keys are speed aliases.

| Key                                | Action                             | Notes                                     |
| ---------------------------------- | ---------------------------------- | ----------------------------------------- |
| `↑↓` / `j k`                       | move cursor                        |                                           |
| `g` / `G` or `Home/End`            | first / last item                  |                                           |
| `Ctrl-U` / `Ctrl-D` or `PgUp/PgDn` | page up / down                     | moves one viewport                        |
| `Space`                            | toggle selection                   | blocked items never toggle                |
| `s` / `a` / `u`                    | select safe · safe+caution · clear | bulk never touches dangerous              |
| `Enter`                            | apply deletion                     | **always confirms**; red banner on danger |
| `h` / `l` (or click header)        | collapse / expand group            | tree-style triage                         |
| `w` / `e`                          | collapse all · expand all          |                                           |
| `o`                                | sort size ↔ name                   | size-desc default                         |
| `/` then type                      | filter artifacts                   | matches name/path/kind/risk; `esc` clears |
| `Tab` / `Shift+Tab`                | cycle panes                        | artifacts ↔ scopes ↔ filter               |
| `1–4`                              | risk filter                        | all / safe / caution / dangerous          |
| `p`                                | pattern editor                     | toggle defaults, add customs — then `r`   |
| `r`                                | rescan from disk                   | honors pattern edits; safe mid-scan       |
| `t`                                | theme                              | dark · light · auto                       |
| `Esc`                              | **walk back one layer**            | never quits — see below                   |
| `q` / `Ctrl-C`                     | quit                               | `Ctrl-C` works even inside modals/search  |

**Esc philosophy:** pressing `Esc` unwinds exactly one thing per press — closes
the help modal, leaves the filter, clears the risk filter, clears scope,
clears text, expands groups. It can never exit the process or lose your
selection to a mis-press.

### Mouse

Wheel moves the cursor three rows per notch — the view follows it, so the
selection is never pointed at a row you can't see. Click focuses a row, click
again queues it, click a group header to fold it. The scrollbar lane is a
position indicator, not a drag target.

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
   and why; exit code reflects it. A scan that couldn't read part of the tree
   says so (`N skipped` in the TUI, counts in `scan --json`) instead of looking
   complete.
7. **Ctrl+C is safe** mid-apply — sweep stops scheduling new deletions, lets
   in-flight work finish, then reports exactly what was removed.

### Reversible cleanup (`--trash`)

```bash
sweep --trash                 # clean, but move instead of delete
sweep clean . --trash -y      # same, non-interactive
```

Instead of deleting, candidates are moved into `.sweep-trash-<timestamp>/`
inside the target — atomic renames on the same filesystem, with each entry's
original relative path preserved. Nothing is unrecoverable until you delete
the trash dir yourself (or run `sweep` on it). Trash dirs are excluded from
future scans automatically.

**History:** every apply appends to `~/.config/sweep/history.jsonl`
(`SWEEP_CONFIG_DIR` to override). `sweep stats` shows the lifetime total.

---

## Exit codes

| Code | Meaning                          |
| ---- | -------------------------------- |
| `0`  | Success                          |
| `1`  | User aborted                     |
| `2`  | Guardrail violation              |
| `3`  | Config parse or validation error |
| `4`  | Operation failed (scan/apply/IO) |
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
