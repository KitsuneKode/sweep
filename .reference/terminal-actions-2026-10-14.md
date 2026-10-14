# Terminal interaction references

Reviewed for Sweep's folder → selection → review flow, 2026-10-14.

- [OpenTUI](https://github.com/anomalyco/opentui): existing native terminal layout,
  keyboard, input and mouse APIs. Implementation was checked against installed
  0.2.16 declarations; newer skill examples are not assumed to exist locally.
- [Awesome OpenTUI](https://github.com/msmps/awesome-opentui): surveyed the project
  list as an interaction reference. No listed application's source or runtime
  was audited, and no performance claim is borrowed from it.
- [Prior pinned fff source review](fff-discovery-2026-10-08.md): retain one
  generation-owned index, publish bounded pages, distinguish discovery from
  sizing and keep maintenance off the interaction path. Search-index freshness
  is not deletion authorization.

The command palette borrows the familiar searchable-action interaction, using
Sweep's existing guarded handlers. It does not add a browser component library
to OpenTUI. Folder browsing is explicit and immediate; cursor movement does not
select, browse or apply. Scrolling is cursor-coupled, so the next action remains
on screen. Motion is reserved for running work and can be paused; folders,
confirmation targets and selection controls do not animate between positions.
