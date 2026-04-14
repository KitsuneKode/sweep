# sweep — Agent Guide

> Artifact cleanup CLI. Deletes build output, node_modules, caches from project trees safely.
> Think `cargo clean` — but universal, language-agnostic, monorepo-aware.

## Quick Start for Agents

```bash
bun install          # install deps
bun run dev          # run from src (no build step)
bun run build        # bundle → dist/sweep.js
bun test             # run tests
bun run lint         # biome check + oxlint
bun run fmt          # biome format --write
bun run typecheck    # tsc --noEmit (type check only)
```

First time setup:

```bash
git init
bun install
bun run prepare     # sets up husky hooks
```

---

## Architecture

```
src/
├── index.ts      CLI entry — parse args, orchestrate flow
├── config.ts     Load + merge: defaults ← global ← project ← CLI flags
├── guardrails.ts Safety checks — blocked paths, size limits, symlinks
├── scanner.ts    Recursive scan — find matching patterns, collect results
├── display.ts    All UI output — colors, summaries, spinner, prompts
├── cleaner.ts    Delete with progress, return stats
└── types.ts      All shared TypeScript types (source of truth)

scripts/
└── build.ts      Bun build script → dist/sweep.js (single bundle)

tests/
├── guardrails.test.ts
├── scanner.test.ts
└── config.test.ts
```

---

## Design Decisions (Non-Negotiable)

These were settled in the design session. Don't revisit without a strong reason.

| Decision         | Choice                               | Reason                                          |
| ---------------- | ------------------------------------ | ----------------------------------------------- |
| Runtime          | Node 18+ / Bun                       | Widest install surface                          |
| Bundle format    | Single ESM file via `bun build`      | Fast global install, zero extra files           |
| Colors           | `picocolors`                         | ~300 bytes, zero deps, auto-respects `NO_COLOR` |
| CLI framework    | `commander`                          | Ergonomic, well tree-shaken by Bun              |
| Default behavior | Deletes immediately (no magic timer) | `--dry-run` is explicit opt-in                  |
| Confirmation     | Interactive `[y/N]` prompt           | Skip with `--yes`/`-y`                          |
| Config lookup    | Walk up from CWD                     | Monorepo-safe (finds config in repo root)       |
| Recursion        | Unlimited by default (`depth: -1`)   | Monorepo killer feature                         |
| Size display     | Fast estimate (top-level stat only)  | Exact on `--dry-run` only                       |
| CI detection     | `process.stdout.isTTY`               | Disable spinner + color in pipes                |

---

## Config Resolution Order (High → Low Priority)

```
CLI flags
  └─ .sweeprc.json  (walk up from CWD, stops at FS root)
      └─ ~/.config/sweep/config.json  (global user defaults)
          └─ built-in defaults  (src/config.ts DEFAULT_CONFIG)
```

Arrays (`patterns`, `ignore`) are **merged + deduplicated** across layers, not replaced.
Scalar values (`maxSizeGB`, `depth`) use the highest-priority source that defines them.

---

## Config Schema

`.sweeprc.json` or `~/.config/sweep/config.json`:

```jsonc
{
  "patterns": ["custom-build-output"], // merged WITH defaults, not replacing
  "ignore": ["packages/vendor"], // paths to never delete
  "maxSizeGB": 10, // abort + require --force-large above this
  "depth": -1, // -1 = unlimited recursion
}
```

---

## Default Patterns

```
node_modules/    .next/          dist/         build/
.turbo/          .parcel-cache/  target/       out/
.nuxt/           .svelte-kit/    coverage/     .nyc_output/
*.tsbuildinfo    .vite/
```

`.cache/` is intentionally excluded — too broad, dangerous in home directories.

---

## Guardrail Rules (Hard-Coded, Not Configurable)

1. **Blocked roots**: Never operate if `targetDir` resolves to `/`, `/home`, `/usr`, `/etc`,
   `/opt`, `/var`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/boot`, `/sys`, `/proc`,
   or `os.homedir()` itself. Must be ≥2 path segments below root.
2. **No path traversal**: Reject paths containing `..`
3. **No symlink follow**: Use `lstatSync` — if entry is a symlink, call `unlinkSync`
   (removes the link entry), never `rmSync` with `recursive: true` on a symlink
4. **Size limit**: If estimated total exceeds `maxSizeGB` (default 10 GB), throw
   `GuardrailError` unless `--force-large` is passed alongside `--yes`
5. **Pattern safety**: Patterns must not start with `/` or contain `..`

---

## CLI Interface

```
sweep [path] [options]

Arguments:
  path                  Directory to sweep (default: ".")

Options:
  -n, --dry-run         Preview what would be deleted, no changes made
  -y, --yes             Skip confirmation prompt (required in scripts/CI)
  --force-large         Allow deletion over maxSizeGB (use with --yes)
  -p, --pattern <p>     Add extra pattern, repeatable: -p .output -p .cache
  -i, --ignore <p>      Add ignore pattern, repeatable
  --depth <n>           Max recursion depth (-1 = unlimited, default)
  --config <path>       Explicit config file path
  --no-color            Disable color output
  -V, --version         Output version number
  -h, --help            Show help
```

### Examples

```bash
sweep                        # clean CWD
sweep ~/projects/myapp       # clean specific directory
sweep --dry-run              # preview only
sweep -y                     # no prompt (CI use)
sweep -p .output -p .cache   # extra patterns
sweep --depth 2              # only 2 levels deep
```

---

## Exit Codes

| Code | Meaning                          |
| ---- | -------------------------------- |
| 0    | Success (or dry-run completed)   |
| 1    | User aborted at prompt           |
| 2    | Guardrail violation              |
| 3    | Config parse error               |
| 4    | Filesystem error during deletion |

---

## Implementation Status

| File                | Status       | Notes                                                |
| ------------------- | ------------ | ---------------------------------------------------- |
| `src/types.ts`      | **complete** | All types defined                                    |
| `src/config.ts`     | **complete** | 4-layer merge, walk-up logic, tested                 |
| `src/guardrails.ts` | **complete** | Blocked paths, traversal, size limit, tested         |
| `src/scanner.ts`    | **complete** | Recursive walk, `du -sb` size estimation, exact mode |
| `src/display.ts`    | **complete** | TTY/CI split, exact vs estimated labels              |
| `src/cleaner.ts`    | **complete** | symlink-safe delete, per-entry error collection      |
| `src/index.ts`      | **complete** | Full orchestration, `--dry-run` uses exact sizes     |
| `scripts/build.ts`  | **complete** | Ready to use                                         |
| `tests/`            | **complete** | 53 tests passing across 3 files                      |
| Tooling             | **complete** | biome, oxlint, husky, commitlint, lint-staged        |

---

## Key Implementation Notes

### Size Estimation Strategy

**Fast path** (used by default for confirmation prompt):

- Call `fs.statSync` on each matched entry (not recursive)
- Directory `stat.size` is not content size — it's just the directory entry size
- To get a usable estimate on Linux: shell out to `du -sb <path>` via `child_process.execSync`
  and fall back to `stat.size` on error or non-Linux platforms
- Show estimate as "~X GB" to signal it's approximate

**Exact path** (only with `--dry-run`):

- Recurse into each matched directory and sum all file stats
- Can be slow on large `node_modules` — show spinner while computing

### Glob Pattern Matching

Current implementation in `scanner.ts` uses a simple regex approach for `*.ext` patterns.
For production, consider replacing with `micromatch` (lightweight, fast, correct glob semantics).
Decision deferred — the simple approach covers all current default patterns.

### Spinner / TTY Detection

```typescript
if (!process.stdout.isTTY) {
  // CI/pipe: no spinner, no color, simple text output
}
```

Always check `isTTY` before writing `\r` escape sequences. picocolors handles `NO_COLOR`
automatically but does not handle `isTTY` — you must check it manually for spinner frames.

### Config Walk-Up Logic

Walk from `startDir` toward `/`, checking for `.sweeprc.json` at each level.
Stop walking when you hit:

- The filesystem root (`parse(dir).root`)
- A directory you don't have read access to
- A directory that is a blocked root (see Guardrail Rules)

Use the **first** `.sweeprc.json` found (closest to CWD wins).

---

## Tooling Configuration Notes

- **biome**: handles formatting + import sorting. Configured to NOT duplicate oxlint rules.
- **oxlint**: additional lint rules biome doesn't cover. Check `biome.json` + oxlint config
  to ensure no duplicate warnings.
- **commitlint**: conventional commits (`feat:`, `fix:`, `chore:` etc.)
- **lint-staged**: runs biome check + oxlint on staged `.ts` files only (not typecheck — too slow)
- **husky**: `pre-commit` → lint-staged, `commit-msg` → commitlint

---

## Publishing to npm

Package name is `@kitsunekode/sweep`. Binary is `sweep`.

1. Bump version in `package.json`
2. `bun run build`
3. Verify: `node dist/sweep.js --version`
4. `npm publish --access public`

Install after publish:

```bash
npm install -g @kitsunekode/sweep
bunx @kitsunekode/sweep --dry-run
```

---

## Things to Add (Future)

- `--output json` flag for machine-readable output (CI integration)
- Homebrew tap formula
- GitHub Actions release workflow (auto-publish on tag)
- `sweep init` subcommand to scaffold `.sweeprc.json`
- Progress bar during delete (instead of per-item spinner)
- `--include-cache` flag to opt into `.cache/` deletion with extra confirmation
- Windows compatibility audit (path separators, blocked roots, `du` unavailable)
