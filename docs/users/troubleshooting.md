---
title: Troubleshooting
description: Diagnose common install, scan, terminal UI, and apply errors.
---

Start with read-only diagnostics:

```sh
sweep doctor .
sweep doctor . --json
```

`doctor` does not modify the scan target. It checks configuration trust, target access, OpenTUI, the Rust engine, filesystem identity support, held apply locks, and a small scan preview. Exit `0` means no warnings, `5` means warnings, and another nonzero code means doctor itself failed.

## Install and startup

### `sweep ui` says OpenTUI is unavailable

`@opentui/core` is optional. CLI commands can install and run without it. Use one of these fixes:

- install or run through Bun
- use the standalone binary
- reinstall with optional dependencies enabled in your package manager

`bunx @kitsunekode/sweep ui .` is the quickest no-install check. Do not use `npx ... ui` as the documented UI path when the optional dependency is missing.

### Windows installer or executable is blocked

PowerShell execution policy can block `install.ps1`. Download and inspect it, then run it for one process:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

SmartScreen can warn because the executable is not broadly established. Verify the `.sha256` sidecar and release provenance before continuing. If corporate policy blocks user binaries, ask the machine owner which install location is allowed.

### Linux musl standalone binary does not start

Minimal musl systems can lack the standalone runtime libraries. On Alpine:

```sh
apk add libstdc++ libgcc
```

musl support is available from 0.5.4. If the machine is older than that release, upgrade rather than forcing a glibc asset onto musl.

## Engine selection

### Doctor reports the Rust engine is unavailable or untrusted

First run `sweep doctor .` and read the exact `rust_engine` or `rust_apply_safety` detail. Common causes are a missing optional native package, a musl or glibc detection failure, a spawn error, or an install directory that fails ownership checks.

`--engine auto` falls back to JavaScript and continues. `--engine rust` makes the problem a hard failure. Use `--engine js` temporarily if you want deterministic behavior while fixing the install.

### Homebrew installs the native engine but Sweep uses JavaScript

Homebrew prefixes commonly contain group-writable directories. Sweep does not trust an engine whose file or ancestor directories are writable by group or others. This is intentional. Tighten permissions only if you understand the effect on your package manager, or keep the JavaScript fallback.

Running with `sudo` is not the fix. Sweep accepts the invoking user from `SUDO_UID` for a real sudo invocation, but it does not require or request elevated privileges. Fix ownership and writability of the install location instead.

### `--engine rust` fails with `libc_unknown`

Sweep could not prove whether the system uses glibc or musl. It refuses to guess. Use `--engine js`, or install a standalone binary matched to the system. If this happens on a standard Linux installation, report it with the doctor JSON.

## Scan problems

### Scan finds nothing

Check that artifact names are enabled. Generic names such as `dist`, `build`, `out`, `coverage`, and `.venv` are opt-in. Run `sweep init .` or pass `--pattern dist` for one scan. Check `--ignore` rules and scan depth.

### Scan is incomplete or hits a resource allowance

A resource-limit failure exits `2` and cannot be applied. Narrow the scan target, exclude irrelevant trees, or use the default resource profile instead of `low-memory`. Depth-only pruning is incomplete coverage, not a hard resource failure, but it is still not a complete measurement.

`~` means approximate or partial size. `sweep status` reports `bytesPartial`, `partialByteCount`, and skipped directories. Do not compare a partial result with a complete disk-usage number as if they measure the same tree.

### A project is not marked idle even though it looks old

Sweep uses proven activity evidence, not only the artifact timestamp. If git metadata and bounded project files cannot be read or do not prove activity, the project shows `?` and is excluded from idle selection. Correct file ownership and permissions, scan the project root rather than a generated folder, and let the scan finish.

### A hardlinked store reports less space freed than apparent size

That is correct. pnpm and Bun can hardlink one store file into many artifacts. Sweep counts shared inodes once and reports `about X freed` when unique-inode bytes differ from apparent bytes. `shared hardlinks not fully counted` means some shared content could not be measured completely, so the exact freed amount is unknown.

## Apply and confirmation

### `sweep clean` exits after `Declined. Nothing deleted.`

The confirmation was answered with no, the prompt ended, or stdin closed. Nothing was removed. Exit `1` is an aborted operation, not a filesystem failure.

### Apply says another cleanup is running

CLI applies hold a cooperative lock. Wait for the active Sweep process to finish. Do not delete lock files based only on a missing or reused PID. Run `sweep recover --journal <path> --json` for the reported journal if you need evidence.

### Apply refuses a plan or artifact

The message names the guardrail. Common causes are a changed filesystem identity, git-tracked content, unknown tracked status, nested repositories, protected roots, symlink replacement, or an incomplete fresh size measurement. These refusals happen before removal for that request. Create a fresh scan and review the new state.

### `--yes` still refuses dangerous artifacts

That is intentional. `--yes` skips only the prompt. It does not authorize dangerous artifacts. Review the listed dangerous paths and pass `--allow-dangerous` only when they are intentionally included. Blocked paths cannot be authorized at all.

### Apply progress looks stuck on one artifact

A large directory can remain at `0 of 1` completed artifacts while its contents are being removed. Supported native Linux engines can show an entries-removed count inside the active artifact. That count is not a byte percentage. Cancellation remains available with Ctrl+C or Esc.

### The process or terminal was interrupted

Do not assume the operation completed or that nothing happened. Inspect the journal and disk:

```sh
sweep recover --journal <journal-path>
sweep scan .
```

Recovery never retries, restores, or releases a lock. Completed removals are not rolled back. A lost native apply report is an unknown outcome even if some paths are already gone. Scan again before creating a new plan.

## Configuration

### Config is ignored or rejected as unsafe

Automatically discovered `.sweeprc` files and global config must not be owned by another user or writable by unrelated users on POSIX systems. A file or directory writable by a non-primary group is rejected. Move config into an owner-controlled directory and reduce permissions. A missing operational config directory is okay because Sweep creates it with owner-only permissions when needed.

### `maxSizeGB` behavior looks inconsistent

There is no default ceiling. If config contains `maxSizeGB`, it remains active. `--max-size-gb <gib>` overrides it for one run. `--max-size-gb none` disables it for one run. `--force-large` requires `--yes` and overrides only the size ceiling, never path or identity checks. The terminal UI always confirms and offers a per-operation override.

## Terminal display

### Keys act differently in tmux or a terminal multiplexer

Many terminals and tmux configurations send Ctrl+Enter as plain Enter. Use `c` to review the queue. It is the portable binding.

### Colors look wrong or too bright

Pass `--theme auto`, `--theme dark`, or `--theme light`, or press `t` in the UI. `NO_COLOR` disables colored output where supported. Symbols and labels still distinguish states.

### Animation is distracting or costly

Press `m` in the UI, or start with:

```sh
SWEEP_REDUCED_MOTION=1 sweep ui .
```

## Reporting a bug

Run doctor and capture the exact command, terminal output, exit code, operating system, install method, and whether you used `--json` or a non-default engine. Do not attach private paths, file names, journals, or plan contents without reviewing them first.
