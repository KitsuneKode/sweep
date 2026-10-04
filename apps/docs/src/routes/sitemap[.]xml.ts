import { createFileRoute } from "@tanstack/react-router";
import { sitemap } from "../lib/site";
import { source } from "../lib/source";
export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () =>
        __DOCS_SITE_URL__
          ? new Response(
              sitemap(["/", ...source.getPages().map((page) => page.url)], __DOCS_SITE_URL__),
              {
                headers: {
                  "Content-Type": "application/xml; charset=utf-8",
                  "Cache-Control": "public, max-age=300",
                },
              },
            )
          : new Response("Configure DOCS_SITE_URL before indexing this preview.", {
              status: 404,
              headers: { "X-Robots-Tag": "noindex" },
            }),
    },
  },
});
