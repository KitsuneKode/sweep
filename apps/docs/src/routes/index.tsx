import { createFileRoute } from "@tanstack/react-router";
import { Landing } from "../components/landing/landing";
import { homeJsonLd, pageHead } from "../lib/site";
import landingCss from "../landing.css?url";
export const Route = createFileRoute("/")({
  head: () => {
    const head = pageHead(
      "Clean node_modules, target and build artifacts safely",
      "Sweep is an open-source CLI that finds node_modules, Rust target, .next and other build output across your projects and removes only what you choose.",
      "/",
      __DOCS_SITE_URL__,
      {
        fullTitle: "Sweep: clean node_modules, target and build artifacts safely",
        jsonLd: homeJsonLd,
      },
    );
    return { ...head, links: [...head.links, { rel: "stylesheet", href: landingCss }] };
  },
  component: Landing,
});
