# Public documentation and website

Status: in_progress
Scope: docs, distribution, ux
Created: 2026-10-03
Updated: 2026-10-03

## Done locally

- Public Markdown in `docs/`, with user/developer hubs, frontmatter and ordered
  navigation, inspired by KitsuneSnipe's public/internal separation.
- Safe first-run workflows, exact command/runtime requirements, focused deletion,
  streaming/partial-size feedback, configuration, troubleshooting and privacy.
- Public benchmark summary without machine-specific paths, plus explicit sample,
  shape, memory and sparse/allocated-storage boundaries.
- Root README points to public guides and fixes misleading safety/runtime/scale
  claims. Docs checks validate links, frontmatter and navigation.
- Package remains an allowlist of dist/README/license; docs are excluded. Local
  npm size approximately 492 KiB compressed. Standalone remains ~98 MiB raw.
- Streaming gzip archives with round-trip/checksum verification reduce Linux
  standalone download to ~41.7 MiB; workflow retains raw assets. Not published.

## Website implementation

Created a private `apps/docs` workspace using TanStack Start + Fumadocs, reading
repository `docs/` via a configured content collection. Do not couple CLI build,
pack or standalone compilation to the website. Fumadocs supports this framework
and Markdown/MDX content; consult the current setup at implementation time:
[Fumadocs TanStack](https://www.fumadocs.dev/docs/manual-installation/tanstack-start),
[Fumadocs content](https://www.fumadocs.dev/docs/mdx),
[TanStack prerendering](https://tanstack.com/start/latest/docs/framework/react/guide/static-prerendering).

Use a narrow readable text column, restrained terminal-inspired accent, light
and dark themes, clear focus rings, mobile navigation, copy-command feedback and
accessible search. Keep release status beside install commands. Homepage should
show scan → inspect → confirm → outcome with an owned synthetic example.

Build content/search at build time and prerender public pages where supported.
Lazy-load charts and a small terminal demo; avoid autoplay video and heavy
animation. Keep benchmark table text accessible without JavaScript. Route-local
errors should offer docs navigation and preserve the query. Do not expose a
server-side cleanup endpoint or ingest arbitrary local paths.

## Acceptance and publication

- Content routes and internal links resolve through the site's slug mapping.
- Frontmatter, unique metadata, canonical URLs and sitemap match the eventual
  chosen domain. Do not invent a live domain before it exists.
- Desktop/mobile keyboard navigation, search, copy states and error states pass.
- Website dependencies/assets are absent from npm and standalone artifacts.
- Current installed preview commands and documented version/status agree.
- Website build/typecheck and platform preview evidence pass before a requested
  deployment. No deploy or release authorization is implied by this plan.

## Foundation verification (2026-10-03)

The app uses the neutral Fumadocs baseline; custom visual styling is left to the
user. All 17 Markdown pages plus the homepage prerender, with route content
loaded through async imports and two build workers. Public docs are the only
content source. Search runs through a server-only module; routes expose no
filesystem or cleanup operations. Markdown links are mapped at render time.
Titles/descriptions, configured canonical/OG URLs, sitemap, preview noindex
robots and benchmark data are implemented. `DOCS_SITE_URL` is validated and
hashed in Turbo. CLI build graph excludes the docs workspace.

Local build/type/lint/unit and built-server smoke pass; smoke covers all content
routes, mapped links, search, missing-page 404s and preview/public SEO modes.
The in-app browser backend was unavailable, so keyboard, mobile, clipboard and
visual checks remain open. No hosting adapter/domain/deployment is selected.
Vite emits an upstream Fumadocs macro warning for an unused lazy raw-Markdown
filesystem helper; the app does not invoke that helper in the browser.

Actual-app follow-up in this pass: bounded stdout waits/listener cleanup,
JS/Rust streaming backpressure, Bun stdout false-return handling, and shared
standalone/npm EPIPE apply cancellation. Four slow-consumer CLI runs preserved
2,500 candidates plus sizing updates; closed JSON consumers exit 4. The
[recorded probe](codebase-audit-2026-10-01/cli-slow-consumer.json) is exploratory,
not p99 or total process-tree RSS evidence. React Doctor reports no app-code
findings; two sequential-loop warnings are in the intentionally bounded smoke
script. Its initial changed-files scan skipped the untracked app, so a full scan
was used. Required gates are rerun after the final changes.

Final local evidence is recorded in
[docs foundation and streaming](codebase-audit-2026-10-01/docs-foundation-and-streaming.json).
`bun run check` passed 643 tests / 48 tasks; Rust check passed 77 tests / 8 tasks.
The real standalone broken-pipe apply probe found that Bun `console.log` hid
stdout errors; non-TTY deletion progress now uses stream writes. Both engines
stopped scheduling, retained remaining candidates and wrote interrupted history
matching disk. The reproducible `scripts/smoke-apply-pipe.py` owns its fixture.
