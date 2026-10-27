---
"@kitsunekode/sweep": patch
---

0.5.0 cannot be installed from npm, and its native engines were published
without the execute bit, so they never ran. Install 0.5.1 instead. The package
is now published from its packed tarball, so the registry's install metadata
is exactly the manifest that was checked, and engine binaries are made
executable and checked before they are published.
