---
"@kitsunekode/sweep": minor
---

The terminal UI shows last scan's sizes as soon as each folder is found
(marked `~`), then replaces them with fresh measurements. Sizes come from
`size-cache.json` in the configuration directory, are only reused for the same
folder identity, and are never used by the CLI or by any removal.
