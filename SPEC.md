# sweep — Technical Specification

**Version**: 0.1.0  
**Status**: In Development

---

## Problem

Every JS/TS/Rust/Java project accumulates gigabytes of regeneratable build artifacts —
`node_modules`, `dist`, `.next`, `target`, etc. Cleaning these is manual, project-specific,
and easy to get wrong (deleting the wrong thing, missing nested monorepo packages,
or accidentally running in the wrong directory).

Existing solutions:

- `rm -rf node_modules dist` — manual, no safety net, no monorepo awareness
- `npx rimraf` — single pattern, no config, no guardrails
- `cargo clean` — language-specific

**sweep** is the universal version: recursive, safe, configurable, globally installable.

---

## Goals

1. **Safe by default** — hard guardrails that prevent destroying system or home directories
2. **Monorepo-first** — recursive scan finds `packages/*/node_modules` automatically
3. **Universal** — works in any project, any language (JS, Rust, Java, Python, etc.)
4. **Zero-config** — sensible defaults work for 90% of projects out of the box
5. **Composable** — `sweep -y` in CI, `sweep --dry-run` for inspection, config file for project-specific rules
6. **Fast** — single bundle, no startup overhead, parallel FS ops where safe

---

## Non-Goals

- Not a general-purpose `rm` replacement
- Not a disk analyzer (no interactive TUI, no treemap)
- Not a file watcher / auto-cleaner
- Not responsible for cleaning git history or Docker images

---

## User Stories

### US1: Developer cleaning before git commit

```bash
cd ~/projects/myapp
sweep
# → Shows: 3 items, ~847 MB. Delete? [y/N]
# → y
# → ✓ Cleaned 3 items, 847.2 MB freed (1.2s)
```

### US2: Monorepo cleanup

```bash
sweep ~/projects/monorepo
# Finds: packages/web/node_modules, packages/api/node_modules, packages/shared/dist
# Shows summary, asks for confirmation
```

### US3: CI pipeline (no prompt)

```bash
sweep --yes --dry-run   # preview in CI logs
sweep --yes             # actual cleanup in CI
```

### US4: Inspect before deleting

```bash
sweep --dry-run
# Shows full list of what would be deleted, with paths and estimated sizes
# Exits with code 0, no changes made
```

### US5: Project-specific ignores

```json
// .sweeprc.json in repo root
{
  "ignore": ["packages/vendor-patched"],
  "patterns": [".custom-output"]
}
```

```bash
sweep  # respects .sweeprc.json automatically
```

### US6: Global install, used everywhere

```bash
npm install -g sweep-clean   # or: bun add -g sweep-clean
sweep ~/Projects             # clean an entire projects folder
```

---

## CLI Specification

### Synopsis

```
sweep [path] [options]
```

`path` defaults to `.` (current working directory).

### Options

| Flag            | Short | Type     | Default | Description                          |
| --------------- | ----- | -------- | ------- | ------------------------------------ |
| `--dry-run`     | `-n`  | bool     | false   | Preview only, no deletion            |
| `--yes`         | `-y`  | bool     | false   | Skip confirmation prompt             |
| `--force-large` | —     | bool     | false   | Allow exceeding `maxSizeGB`          |
| `--pattern`     | `-p`  | string[] | []      | Additional patterns (repeatable)     |
| `--ignore`      | `-i`  | string[] | []      | Ignore patterns (repeatable)         |
| `--depth`       | —     | number   | -1      | Max recursion depth (-1 = unlimited) |
| `--config`      | —     | string   | —       | Explicit config file path            |
| `--no-color`    | —     | bool     | false   | Disable color output                 |
| `--version`     | `-V`  | —        | —       | Print version                        |
| `--help`        | `-h`  | —        | —       | Print help                           |

### Behavior Flow

```
1. Parse CLI args
2. Resolve targetDir (absolute path)
3. Assert guardrails on targetDir
4. Load + merge config (global ← project ← CLI flags)
5. Validate patterns (guardrail check)
6. Scan targetDir recursively
   - Collect matching entries
   - Compute fast size estimate
7. Print scan summary (colored, aligned)
8. If entries.length === 0: exit 0 ("Nothing to clean")
9. Assert size guardrail (< maxSizeGB or --force-large)
10. If --dry-run: print notice, exit 0
11. If !--yes: show confirmation prompt [y/N]
    - 'n' or empty → "Aborted." → exit 1
12. Delete each entry with progress output
13. Print final summary (items deleted, bytes freed, duration)
14. Exit 0 (or 4 if any deletions failed)
```

---

## Output Format

### Scan Summary (TTY)

```
 sweep — artifact cleanup

Scanned 47 directories in /home/user/projects/myapp

  ✗ node_modules    (/home/user/projects/myapp/node_modules)              ~412 MB
  ✗ node_modules    (/home/user/projects/myapp/packages/web/node_modules) ~231 MB
  ✗ dist            (/home/user/projects/myapp/packages/api/dist)         ~14 MB
  ✗ .next           (/home/user/projects/myapp/apps/web/.next)            ~189 MB

  4 items, ~846 MB estimated

Delete 4 items (~846 MB)? [y/N]
```

### After Deletion

```
✓ Cleaned 4 items, 846.4 MB freed (2.3s)
```

### Dry Run

```
[Scan summary as above]

Dry run — no files deleted.
```

### CI / Non-TTY (no color, no spinner)

```
sweep: scanning /home/user/projects/myapp
sweep: found 4 items (~846 MB)
sweep: deleted node_modules (/home/user/projects/myapp/node_modules)
sweep: deleted node_modules (/home/user/projects/myapp/packages/web/node_modules)
sweep: deleted dist (/home/user/projects/myapp/packages/api/dist)
sweep: deleted .next (/home/user/projects/myapp/apps/web/.next)
sweep: done — 846.4 MB freed in 2.3s
```

---

## Config File Specification

### Locations (in priority order)

1. Path from `--config` flag
2. `.sweeprc.json` — found by walking up from CWD (stops at FS root)
3. `~/.config/sweep/config.json` — global user defaults

### Schema

```typescript
interface SweepRcFile {
  patterns?: string[]; // additional patterns (merged with defaults)
  ignore?: string[]; // paths containing these strings are skipped
  maxSizeGB?: number; // default: 10
  depth?: number; // default: -1 (unlimited)
}
```

All fields are optional. Missing fields fall back to the next config layer.

### Pattern Merging

`patterns` and `ignore` arrays are **merged across all config layers**, not replaced.
If your project config adds `[".custom"]` and the global config adds `[".localdev"]`,
the effective patterns list includes defaults + `.custom` + `.localdev`.

To effectively remove a default pattern, use the `ignore` field:

```json
{ "ignore": ["dist"] } // won't delete anything named "dist"
```

---

## Guardrails Specification

### Hard-Blocked Paths

The following `targetDir` values are rejected with exit code 2:

- `/` (filesystem root)
- `/home` (home parent)
- `/usr`, `/etc`, `/opt`, `/var`, `/bin`, `/sbin`, `/lib`, `/lib64`
- `/boot`, `/sys`, `/proc`
- `os.homedir()` (e.g., `/home/alice`) — home root itself is blocked

Any path that resolves to fewer than 2 path segments below root is blocked.

### Symlink Handling

- Use `lstatSync` (not `statSync`) for all directory entry checks
- Symlinks that match patterns: delete with `unlinkSync` (removes link entry only)
- Never call `rmSync({ recursive: true })` on a symlink
- Never follow symlinks during recursive scan

### Size Limit

- Default: 10 GB
- If estimated total exceeds limit: print error, suggest `--force-large`, exit 2
- `--force-large` must be combined with `--yes` (no interactive bypass for large deletes)

### Pattern Safety

Patterns must:

- Not start with `/`
- Not contain `..`
- Be non-empty strings

---

## Distribution

### Package

- Name: `@kitsunekode/sweep`
- Binary: `sweep`
- Format: Single bundled ESM file (`dist/sweep.js`) with `#!/usr/bin/env node` shebang
- Included in npm package: `dist/` only

### Install Methods

```bash
# Global (recommended)
npm install -g @kitsunekode/sweep
bun add -g @kitsunekode/sweep

# One-shot (no install)
npx @kitsunekode/sweep .
bunx @kitsunekode/sweep .
```

### Runtime Requirements

- Node.js ≥ 18.0.0
- OR Bun (any recent version)
- No native dependencies

---

## Versioning

Follows [Semantic Versioning](https://semver.org/):

- PATCH: bug fixes, guardrail tweaks
- MINOR: new flags, new default patterns, new config fields
- MAJOR: breaking config schema changes, renamed binary

---

## Security Considerations

1. **Path injection**: All paths are resolved with `path.resolve()` before any check
2. **Glob injection via config**: patterns are validated before use
3. **Arbitrary file deletion**: guardrails are checked before ANY deletion, not just the first
4. The tool never reads file contents — only paths and metadata
5. `--config` flag path is also checked for `..` traversal before reading
