import { createFileRoute } from "@tanstack/react-router";
import results from "../../../../docs/benchmark-results.json";
export const Route = createFileRoute("/benchmark-results.json")({
  server: {
    handlers: {
      GET: () =>
        Response.json(results, {
          headers: { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" },
        }),
    },
  },
});
