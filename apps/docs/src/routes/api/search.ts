import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/search")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const query = new URL(request.url).searchParams.get("query");
        if ((query?.length ?? 0) > 200)
          return new Response("Search query too long", { status: 400 });
        const { search } = await import("../../lib/search.server");
        const response = await search.GET(request);
        response.headers.set("Cache-Control", "public, max-age=60, s-maxage=300");
        response.headers.set("X-Robots-Tag", "noindex");
        return response;
      },
    },
  },
});
