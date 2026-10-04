import { createFileRoute, Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { layoutOptions } from "../lib/layout";
import { pageHead } from "../lib/site";
export const Route = createFileRoute("/")({
  head: () =>
    pageHead(
      "Artifact cleanup you can review",
      "Find build artifacts, inspect a plan, and remove only the items you choose.",
      "/",
      __DOCS_SITE_URL__,
    ),
  component: Home,
});
function Home() {
  return (
    <HomeLayout {...layoutOptions}>
      <div id="main-content" tabIndex={-1} className="mx-auto w-full max-w-3xl px-6 py-12">
        <h1>Sweep</h1>
        <p>Find build artifacts. Review what takes space. Clean up deliberately.</p>
        <p>Start with a read-only scan:</p>
        <pre>
          <code>sweep scan ./my-project</code>
        </pre>
        <p>
          <Link to="/docs/$" params={{ _splat: "users/getting-started" }}>
            Get started
          </Link>
          {" · "}
          <Link to="/docs/$" params={{ _splat: "users/safety" }}>
            Understand safety
          </Link>
          {" · "}
          <Link to="/docs/$" params={{ _splat: "developer/benchmarks" }}>
            Read the benchmarks
          </Link>
        </p>
        <p>
          These guides describe the current source checkout. Some improvements are awaiting release;
          check your installed version.
        </p>
      </div>
    </HomeLayout>
  );
}
