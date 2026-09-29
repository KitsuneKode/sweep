---
"@kitsunekode/sweep": minor
---

Add `--trash` (reversible cleanup: candidates move to `.sweep-trash-<ts>/` inside the target instead of being deleted — atomic renames, original paths preserved, trash dirs auto-ignored by future scans), `sweep stats` (cleanup history + lifetime reclaimed total, JSONL at `~/.config/sweep/history.jsonl`, `SWEEP_CONFIG_DIR` to override), `sweep inspect --plan` (read-only plan provenance: counts, kinds, risk tiers, selected bytes), `sweep completions` for bash/zsh/fish, and a `curl | sh` installer script for standalone binaries (now including linux-arm64). Also: `clean --json` no longer mixes scan display text into stdout.
