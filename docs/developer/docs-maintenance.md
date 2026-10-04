---
title: Documentation maintenance
description: Maintain the public guides and the TanStack Start/Fumadocs app.
---

Public content lives in repository-level `docs/`, with user and developer
sections, `title`/`description` frontmatter and ordered `meta.json` navigation.
This follows KitsuneSnipe's useful split between public guides and internal
engineering notes. Sweep's internal decisions remain in `.docs/`; active execution
plans remain in `.plans/`.

The pages use ordinary Markdown so they can be read from a checkout today and
compiled by the private `apps/docs` Fumadocs content source. Local app builds do
not publish or deploy the website.

## Writing rules

Lead with the user's task, show a safe example, then explain relevant limits.
Use `scan`, `inspect` or dry-run before destructive commands. Say when a capability
is an upcoming source change, a configured target, or a verified release.
Keep runtime requirements explicit and never call apparent sizes physical savings.

Commands come from the CLI registry, config from the resolver, shortcuts from
key routing and benchmarks from recorded results. Code wins when prose disagrees.
Update a page in the same change that alters its behavior.

## Checks

```sh
bun run check:docs
bun run check
```

The public navigation/frontmatter check is included in `check:docs`. Keep relative
Markdown links working in the checkout. The site maps those content links to its
route slugs; its smoke checks validate generated pages, search and SEO.
Do not publish internal audit files or absolute machine paths as website content.

## Site boundary

The private `apps/docs` workspace uses TanStack Start and Fumadocs, loading
this `docs/` directory as a content collection. Keep its dependencies and generated
outputs out of the npm CLI and standalone binary. Consult current upstream setup
instructions when changing the app; library APIs change.

The site should support accessible keyboard search, readable light/dark themes,
copyable commands, mobile navigation and version/status labels. Ship text and
small static visuals first; lazy-load terminal demos and charts. Never run a scan,
read user filesystem paths or perform cleanup from a website route.

```sh
bun run docs:dev
bun run docs:check
bun run docs:build
bun run --cwd apps/docs smoke
```

The app starts from Fumadocs' neutral framework styling. Leave custom typography,
colors and social artwork to the project's visual design work. Content is
prerendered; page bodies load on demand. `DOCS_SITE_URL` controls canonical/OG
URLs, robots and sitemap at build time. Unset builds remain unindexable previews.
Qualify keyboard/mobile navigation and the chosen host before deployment.
