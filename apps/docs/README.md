# Sweep docs foundation

Private TanStack Start + Fumadocs workspace. The content lives in the repository's
`docs/` directory. This app uses the neutral Fumadocs baseline; add your visual
identity in `src/styles.css` and the shared layout options when ready.

From the repository root:

```sh
bun install --frozen-lockfile
bun run docs:dev
bun run docs:check
bun run docs:build
bun run docs:preview
```

Development and preview bind to `127.0.0.1:3000`. Node 22.12+ is required by the
website toolchain; the CLI's runtime requirements are separate. Root Turbo
commands also require Cargo for workspace discovery.

## Content and performance

- Only `docs/` is compiled. Internal `.docs/` and `.plans/` stay out of the site.
- Every public Markdown page and the home page are prerendered, with two build
  workers. A failed page fails the build.
- Async content imports split page bodies into chunks. Navigation loads the
  requested page; search indexing stays on the server.
- Fumadocs provides navigation, search, code copying, themes and the table of
  contents. Markdown `.md` links map to site routes without rewriting the source.
- No analytics, third-party fonts, runtime MDX execution or cleanup API is added.
- The CLI build/publish filters exclude this app. Its dependencies and assets
  never belong in the npm package or standalone binary.

## SEO and hosting

Set `DOCS_SITE_URL` to the chosen public HTTPS origin **before building**:

```sh
DOCS_SITE_URL=https://your-docs-domain.example bun run docs:build
```

This generates canonical/OG URLs, an indexable robots response and a sitemap.
Leave it unset for local and hosted previews: pages emit `noindex, nofollow`,
robots disallows crawling, and the sitemap returns 404. The URL is validated and
included in Turbo's cache key; no domain is inferred from request headers.

Production output includes prerendered HTML in `dist/client` and the SSR entry in
`dist/server`. `vite preview` is for local review. Select and qualify a hosting
adapter before deployment; do not deploy just the static directory while retaining
server search routes. Serve hashed assets with immutable cache headers, HTML with
revalidation, and compressed responses at the host. Do not apply an SPA fallback
that turns missing pages into status 200.

Before publishing, check the chosen domain's canonical URLs, sitemap and robots;
search, deep links and 404 status; mobile/keyboard navigation; and rendered page
content without JavaScript. Styling, social artwork and deployment are yours to
choose; this scaffold does not publish anything.
