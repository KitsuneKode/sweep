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
# Global (recommended)
npm install -g @kitsunekode/sweep
bun add -g @kitsunekode/sweep

# One-shot, no install
npx @kitsunekode/sweep .
bunx @kitsunekode/sweep .
```

**Requirements:** Node.js ≥ 18 or Bun (any recent version).

---

## Usage

```
sweep [path] [options]
```

`path` defaults to `.` (current directory).

### Options

| Flag              | Short | Description                                        |
| ----------------- | ----- | -------------------------------------------------- |
| `--dry-run`       | `-n`  | Preview what would be deleted — no changes made    |
| `--yes`           | `-y`  | Skip confirmation prompt (CI / scripts)            |
| `--force-large`   |       | Allow deletion over `maxSizeGB` (requires `--yes`) |
| `--pattern <p>`   | `-p`  | Add extra pattern, repeatable                      |
| `--ignore <p>`    | `-i`  | Ignore paths matching this substring, repeatable   |
| `--depth <n>`     |       | Max recursion depth (`-1` = unlimited, default)    |
| `--config <path>` |       | Explicit config file path                          |
| `--no-color`      |       | Disable color output                               |

### Examples

```bash
# Clean current directory
sweep

# Clean a specific project
sweep ~/projects/myapp

# Preview what would be deleted (exact sizes, no changes)
sweep --dry-run

# Monorepo — finds all node_modules recursively
sweep ~/projects/monorepo

# CI: no prompt, no color
sweep --yes

# Add extra patterns on top of defaults
sweep -p .output -p .cache

# Ignore a vendor directory
sweep -i packages/vendor

# Only scan 2 levels deep
sweep --depth 2
```

---

## Default patterns

These are deleted automatically:

| Pattern         | What it is                        |
| --------------- | --------------------------------- |
| `node_modules`  | npm/yarn/pnpm/bun dependencies    |
| `dist`          | compiled output                   |
| `build`         | compiled output (alt name)        |
| `out`           | Next.js / generic output          |
| `.next`         | Next.js cache + build             |
| `.nuxt`         | Nuxt build                        |
| `.svelte-kit`   | SvelteKit build                   |
| `.turbo`        | Turborepo cache                   |
| `.vite`         | Vite cache                        |
| `.parcel-cache` | Parcel cache                      |
| `target`        | Rust / Java / Maven build output  |
| `coverage`      | test coverage reports             |
| `.nyc_output`   | nyc/Istanbul coverage data        |
| `*.tsbuildinfo` | TypeScript incremental build info |

`.cache` is **intentionally excluded** — it's too broad and dangerous in home directories.

---

## Config file

Create `.sweeprc` in your repo root (JSON format):

```json
{
  "patterns": [".custom-output"],
  "ignore": ["packages/vendor-patched"],
  "maxSizeGB": 10,
  "depth": -1
}
```

All fields are optional. `patterns` and `ignore` are **merged** with defaults — not replaced. To suppress a default pattern, add it to `ignore`:

```json
{ "ignore": ["dist"] }
```

### Config lookup order

```
CLI flags
  └─ .sweeprc  (walks up from CWD to repo root)
      └─ ~/.config/sweep/config.json  (global user defaults)
          └─ built-in defaults
```

Arrays (`patterns`, `ignore`) are merged + deduplicated across all layers.  
Scalars (`maxSizeGB`, `depth`) use the highest-priority source that defines them.

---

## Safety guardrails

sweep refuses to operate on system and home directories — hard-coded, not configurable:

- `/`, `/home`, `/usr`, `/usr/local`, `/etc`, `/opt`, `/var`
- `/bin`, `/sbin`, `/lib`, `/lib64`, `/boot`, `/sys`, `/proc`, `/dev`
- Your home directory (`os.homedir()`) — the root, not subdirectories
- Any path fewer than 2 segments below the filesystem root (e.g. `/tmp`)

Additional protections:

- **Path traversal**: paths containing `..` or null bytes are rejected immediately
- **Symlinks**: detected with `lstatSync`, removed with `unlinkSync` (never followed, never recursed)
- **Size limit**: if estimated total exceeds `maxSizeGB` (default 10 GB), sweep aborts and requires `--force-large --yes` to proceed
- **Pattern safety**: patterns starting with `/`, containing `..`, or containing null bytes are rejected

---

## Exit codes

| Code | Meaning                          |
| ---- | -------------------------------- |
| `0`  | Success (or dry-run completed)   |
| `1`  | User aborted at prompt           |
| `2`  | Guardrail violation              |
| `3`  | Config parse error               |
| `4`  | Filesystem error during deletion |

---

## CI usage

```bash
# Preview in CI logs
sweep --yes --dry-run

# Actual cleanup
sweep --yes

# Clean entire projects folder non-interactively
sweep --yes ~/Projects
```

In non-TTY environments (pipes, CI), color and spinner are automatically disabled. Output switches to prefixed plain text:

```
sweep: scanning /home/runner/work/myapp
sweep: found 4 items (~846 MB)
sweep: deleted node_modules (/home/runner/work/myapp/node_modules)
sweep: done — 846.4 MB freed in 2.3s
```

---

## License

MIT
