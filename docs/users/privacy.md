---
title: Privacy and sharing
description: Keep local plans and diagnostics useful without exposing private paths.
---

Sweep scans the local target you choose. A plan or report can contain absolute
paths, project names, artifact names and timestamps. Cleanup history is stored
in the Sweep config directory and records operation outcomes.

## Share a useful bug report

Include your Sweep version, OS and architecture, runtime version, selected
engine, exact error text and a small reproducible directory shape. A synthetic
fixture is preferable to a copy of private project data.

Before posting JSON or a screenshot, replace usernames and sensitive project
paths. Do not post a saved plan as a public "cleanup recipe": it carries
machine-specific paths and selections. Recreate a read-only example instead.

## Keep automation isolated

Set `SWEEP_CONFIG_DIR` to an owned directory when a job should not use personal
configuration or history. Review its contents before sharing it. Saved plans
are explicit files under your control; protect them like other operational data.

A future shareable summary should use relative or redacted names and explicit
opt-in export. Public links or uploads are not implemented by these docs.
