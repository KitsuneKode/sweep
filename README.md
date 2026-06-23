# sweep

> Safe, recursive artifact cleanup for any project tree.

`sweep` deletes build artifacts — `node_modules`, `dist`, `.next`, `target`, and more — recursively across monorepos, with hard safety guardrails so you never accidentally wipe the wrong directory.

Think `cargo clean`, but language-agnostic and monorepo-aware.

```
 sweep — artifact cleanup

Scanned 47 dirs in /home/you/projects/myapp

  ✗ node_modules    (/home/you/projects/myapp/node_modules)              ~412 MB
  ✗ node_modules    (/home/you/projects/myapp/packages/web/node_modules) ~231 MB
  ✗ dist            (/home/you/projects/myapp/packages/api/dist)         ~14 MB
  ✗ .next           (/home/you/projects/myapp/apps/web/.next)            ~189 MB

  4 items, ~846 MB estimated

Delete 4 items (~846 MB)? [y/N] y
✓ Cleaned 4 items, 846.4 MB freed (2.3s)
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

**Requirements:** Node.js ≥ 18 or Bun.

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

OpenTUI-powered terminal picker for reviewing monorepo scans before delete.

- **Scope grouping** — artifacts grouped by directory (`project root`, `apps/cli/`, `packages/web/`, …)
- **Risk markers** — `·` safe, `?` caution, `!` dangerous, `×` blocked
- **Keyboard** — filter, toggle rows, bulk select (`s` safe, `a` all, `u` clear), Enter to apply
- **Rescan** — toggle default patterns and add custom ones without leaving the UI

Requires a TTY and `@opentui/core`.

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

Hard-blocked targets (not configurable): `/`, `/home`, `/usr`, your home directory root, and other system paths. Also:

- Path traversal (`..`, null bytes) rejected
- Symlinks removed, never followed
- `maxSizeGB` guardrail (default 10 GB) — use `--force-large --yes` to override
- Unsafe patterns rejected at parse time

---

## Exit codes

| Code | Meaning                          |
| ---- | -------------------------------- |
| `0`  | Success                          |
| `1`  | User aborted / doctor warnings   |
| `2`  | Guardrail violation              |
| `3`  | Config parse or validation error |
| `4`  | Filesystem error during deletion |

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
