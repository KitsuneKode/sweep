# Clove storage scanner (consulted 2026-11-18)

Clove 3.4 (clove.kshv.me, github.com/keshav-exe/clove, MIT) is a native macOS
app for what coding agents load (skills, instruction files, MCP servers,
hooks) with a Storage and a Worktrees section. Notes below come from the site,
changelog, README screenshots and the 18.6 s demo video in
x.com/kshvbgde/status/2120782192385355974 ("storage scanner so good you'll
want to fill your disk.", 100k views).

## Storage screen, frame by frame

| Phase   | What is on screen                                                                                                                                                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scan    | Total counts up (37 → 357.8 GB "of 512 GB used"); "Calculating" + dim mono path; dithered bar grows left to right, one colour per category; footer spinner "Looking for things you can clear"                                                   |
| Settled | Bar stops moving. Legend in three columns: Apps, Developer, Photos, Movies, Documents, Music, System data, Caches, Trash, each with size                                                                                                        |
| Point   | Hovering a legend row dims every other segment and puts one sentence under the total: "Movies 44.1 GB · Screen recordings take 24.6 GB, most from this autumn." / "Developer 36.3 GB · Old simulators take 17.2 GB. Build output takes 8.1 GB." |
| Suggest | Footer: one sentence + one button. "Caches are using 46.8 GB. Apps rebuild them when they need them." [Clear caches]                                                                                                                            |
| Clear   | "Clearing caches" + live path; the segment dissolves into particles at its right edge; total counts down                                                                                                                                        |
| Next    | "The Trash is holding 31.4 GB of things you've already deleted." [Empty Trash], same dissolve                                                                                                                                                   |
| Receipt | "✓ Freed 31.4 GB. 231.2 GB available" replaces the subtitle; footer "Nothing else is worth clearing right now."                                                                                                                                 |

## Principles stated in its copy

- "A closed notch never scans, polls, or animates"; "the bar stops animating once it settles".
- Nothing is hard-deleted: Trash first, "Recently cleared" restores; caches of open apps and the OS are excluded; each delete is re-checked when it runs; links are not followed.
- Rows carry "Comes back on its own" or "Check first", a size, and one line of explanation.
- Cleanup (agent skills): one large number ("5,749 tokens your agents load every session"), a 30 / 90 / 180 day segmented control, "Biggest savings" and "How Clove decides" side by side, one button ("Move 47 to Trash · Undo puts it back").
- Worktrees (3.3+): worktrees agents leave behind, marked safe or not, drawn as a commit graph.

## What transfers to a terminal

Dithered bar (Kitty pixels, braille fallback), dimming the unlit parts,
the one-sentence insight, a single next action, the receipt in the header,
and motion only while work runs. Particles become dots going out from the
segment's edge, driven by real outcomes.
