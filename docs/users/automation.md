---
title: Automation and streaming JSON
description: Consume progressive scan events and apply reviewed plans with explicit failure handling.
---

Use the same validated scan and apply paths as the interactive UI. Start with
read-only output and keep deletion as a separate, deliberate step.

## A complete JSON plan

```sh
sweep scan . --json > sweep-plan.json
sweep inspect --plan sweep-plan.json
sweep apply --plan sweep-plan.json --dry-run
```

`scan --json` and `plan` produce a saved plan; `--json-stream` produces lifecycle
events instead. You cannot combine both output modes. A failed command can leave
a partial redirected file, so check the exit status before passing it to apply.

For a POSIX-shell job, publish a plan file only when scanning succeeded:

```sh
if sweep plan . > sweep-plan.pending.json; then
  mv sweep-plan.pending.json sweep-plan.json
else
  rm -f sweep-plan.pending.json
  exit 1
fi
```

These filenames belong to this example. Choose owned output paths in your job;
do not overwrite another process's plan file. Keep the target fixed, inspect the
saved selection, then use `--yes` only in automation that deliberately authorizes
that selection. A plan is not a substitute for safe path ownership.

## Progressive events

```sh
sweep scan . --json-stream
```

Each stdout line is one JSON event. Human errors are written separately.
The scan starts with `scan_started`, then emits `scan_progress`, `candidate_found`
and `candidate_updated`. A successful scan ends with `scan_completed`.

A consumer should:

1. Render a discovered candidate before its final size arrives.
2. Update by stable candidate ID instead of appending a duplicate row.
3. Keep pending or approximate sizes visible; do not invent zero-byte certainty.
4. Coalesce screen updates and render only visible rows.
5. Treat a nonzero exit or missing completion marker as incomplete.
6. Keep cleanup disabled until a complete plan is separately validated.

Event prefixes are useful feedback, not authorization to delete. Do not run
cleanup as each `candidate_found` arrives. Bound your own buffers and frame sizes;
Sweep's internal protocol limits do not automatically protect another consumer.
When piping through shell tools, ensure your script checks Sweep's exit status,
not only the last process in the pipeline.

Sweep pauses streaming producers when stdout reaches its high-water mark. The
Rust pipe also pauses, allowing native workers to slow through their bounded
channel. A consumer that stops draining for 30 seconds causes an explicit failure;
a closed pipe or an oversized queued payload also fails. Check both the final
completion event and Sweep's exit status before trusting a stream.

## Reports and interruption

```sh
sweep apply --plan sweep-plan.json --dry-run --json
```

For an authorized real apply, remove `--dry-run` and deliberately choose whether
confirmation should be interactive or skipped. Retain the final report and check
per-candidate outcomes. Parent deletions can cover nested selections; covered is
not a second independent deletion. Unattempted candidates were not scheduled.

If an apply loses its final report, the result can be unknown. Re-scan disk before
retrying. Preserve errors instead of converting a partial result into a success.

## Shell completions

Print the script for your shell:

```sh
sweep completions bash
sweep completions zsh
sweep completions fish
```

Save it to the completion directory your shell already loads. For zsh, ensure the
chosen directory is on `fpath`; create it before redirecting. Completions suggest
commands, but installed `--help` remains authoritative for available options.
