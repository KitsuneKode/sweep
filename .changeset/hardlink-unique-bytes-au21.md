---
"@kitsunekode/sweep": patch
---

Surface unique-inode freed byte estimates alongside apparent sizes for hardlinked package stores (pnpm/Bun) across both JS and Rust engines:

- Add bounded `(dev, ino)` + `nlink` tracking (`HardlinkTracker`) to both the JS scanner and the Rust `sweep-fs` engine, emitting optional `uniqueBytes` per candidate and `uniqueTotalBytes` on `ScanPlan.summary` / `scan_completed` (with older-engine compatibility stripping on native apply).
- Exclude hardlinked store files whose remaining links live outside scanned candidates (`seen < nlink`) while counting cross-candidate hardlinks once when all links are inside the scan (`seen >= nlink`).
- Show honest `about X freed (Y apparent · shared hardlinks)` totals in scan reports (including disk projection), `sweep status` (`uniqueReclaimableBytes`), and `sweep ui` totals whenever shared hardlinks reduce freed space, and document why copy-on-write reflinks cannot be detected cheaply in `docs/users/safety.md`.
