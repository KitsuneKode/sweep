# Sweep docs foundation

Private TanStack Start + Fumadocs workspace. The content lives in the repository's
`docs/` directory. Docs pages use the neutral Fumadocs baseline. The home page is
its own design: `src/components/landing/` with `src/landing.css`, linked only from
`routes/index.tsx`. Its claims mirror `docs/users/*` and `packages/core`; keep
`landing/content.ts` in step when behaviour changes.

Interactive controls (slider, radio group, tabs, copy field) come from the
[Fluid Functionalism](https://www.fluidfunctionalism.com) shadcn registry,
configured in `components.json`. Update one with
`bunx --bun shadcn@latest add https://www.fluidfunctionalism.com/r/base/<name>.json --diff`.
Fonts are self-hosted from `@fontsource-variable/*`: Bricolage Grotesque (display),
Hanken Grotesk (text) and Martian Mono (terminal fragments and code).

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
- No third-party fonts, runtime MDX execution or cleanup API is added.
- Vercel Web Analytics and Speed Insights are the only measurement: cookieless,
  first-party (`/_vercel/insights`, `/_vercel/speed-insights`), no-ops outside
  Vercel. Pageviews record the path and route pattern, never query strings.
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
`dist/server`. `vite preview` is for local review.

The site is hosted on Vercel at <https://sweep.kitsunekode.in> (project root
`apps/docs`, settings in `vercel.json`). When `VERCEL` is set, the Nitro plugin
emits `.vercel/output`: prerendered pages and hashed assets as static files
(assets `immutable`), with one Node function for search, robots, sitemap,
benchmark data and real 404s. Local builds keep `dist/`. `DOCS_SITE_URL` is set
only for the Production environment, so preview deployments stay `noindex`.
Vercel's automatic Turborepo build is bypassed on purpose: `turbo` needs Cargo
for workspace discovery, which the build image does not have.

Before publishing, check the chosen domain's canonical URLs, sitemap and robots;
search, deep links and 404 status; mobile/keyboard navigation; and rendered page
content without JavaScript. Styling, social artwork and deployment are yours to
choose; this scaffold does not publish anything.
