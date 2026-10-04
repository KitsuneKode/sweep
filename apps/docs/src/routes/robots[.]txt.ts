import { createFileRoute } from "@tanstack/react-router";
import { robots } from "../lib/site";
export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(robots(__DOCS_SITE_URL__), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=300",
          },
        }),
    },
  },
});
