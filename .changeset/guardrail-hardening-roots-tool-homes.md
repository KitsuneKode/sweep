---
"@kitsunekode/sweep": patch
---

Harden scan target guardrails and tool-home classification across both the JS and Rust engines:

- Prefix-block deep OS subtrees (`/etc`, `/sys`, `/proc`, `/dev`, `/boot`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/run`, macOS `/private/etc`, and Windows `<Drive>:\Windows`) as scan targets while keeping `/usr` and `/var` exact-match, normalize Windows `\\?\` verbatim prefixes before lexical checks, and add `Windows` and Unix OS roots to `SYSTEM_TOOL_DIRS`.
- Expand `HOME_TOOL_DIRS` and `SYSTEM_TOOL_DIRS` to protect additional toolchain, version-manager, conda, editor, agent, package-manager, and cloud-sync homes (such as `~/.npm-global`, `~/.asdf`, `~/.mise`, `~/scoop`, `~/.var/app`, `~/snap`, `~/miniconda3`, `~/anaconda3`, `~/.conda`, `~/.vscode-insiders`, `~/.vscode-oss`, `~/.windsurf`, `~/.claude`, `~/.codex`, `~/Applications`, `~/Dropbox`, `~/OneDrive`, and `/home/linuxbrew/.linuxbrew`).
- Restrict `.app` bundle detection to macOS folders containing `Contents/Info.plist` so ordinary project directories named `*.app` are no longer misclassified as tool homes.
