---
"@kitsunekode/sweep": patch
---

Harden scan target guardrails and tool-home classification across both the JS and Rust engines:

- Prefix-block deep OS subtrees (`/etc`, `/sys`, `/proc`, `/dev` except `/dev/shm`, `/boot`, `/bin`, `/sbin`, `/lib`, `/lib64`, macOS `/private/etc`, and Windows `<Drive>:\Windows`) as scan targets while keeping `/run`, `/usr`, and `/var` exact-match so `/run/media/...`, `/run/user/<uid>/gvfs`, `/var/www`, and `/usr/local/src` stay usable; normalize Windows `\\?\` verbatim prefixes before lexical checks; add `Windows` to `SYSTEM_TOOL_DIRS` and scope Unix OS roots to non-drive/non-UNC paths so `C:\dev\...` stays cleanable.
- Expand `HOME_TOOL_DIRS` and `SYSTEM_TOOL_DIRS` to protect additional toolchain, version-manager, conda, editor, agent, package-manager, and app homes (such as `~/.npm-global`, `~/.asdf`, `~/.mise`, `~/go/pkg`, `~/scoop`, `~/.var/app`, `~/snap`, `~/miniconda3`, `~/anaconda3`, `~/.conda`, `~/.vscode-insiders`, `~/.vscode-oss`, `~/.windsurf`, `~/.claude`, `~/.codex` with `~/.codex/worktrees` carved out, `~/.t3/userdata`, `~/Applications`, and `/home/linuxbrew/.linuxbrew`).
- Surface a non-blocking `cloud-sync` reason and scan notice for candidates under cloud-synced folders (`~/Dropbox`, `~/OneDrive`, `~/OneDrive - <Org>`, `~/Google Drive`, `~/My Drive`, and macOS `~/Library/CloudStorage/*`) without changing their risk tier or default selection.
- Restrict `.app` bundle detection to macOS folders containing `Contents/Info.plist` so ordinary project directories named `*.app` are no longer misclassified as tool homes.
