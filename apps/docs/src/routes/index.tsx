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
      <article id="main-content" tabIndex={-1} className="sweep-start">
        <p className="sweep-start-label">Sweep · project cleanup</p>
        <h1>Find what takes space. Choose what goes.</h1>
        <p className="sweep-start-lead">
          Review dependencies, build output and caches across your projects. Start with the largest
          artifacts and remove only the items you choose.
        </p>
        <p>After installing, open a project you know:</p>
        <pre>
          <code>sweep ui ./my-project</code>
        </pre>
        <section aria-labelledby="cleanup-steps">
          <h2 id="cleanup-steps">Your first cleanup</h2>
          <ol className="sweep-start-steps">
            <li>
              <strong>See the largest artifacts.</strong> Scanning changes no project files. Your
              queue starts empty.
            </li>
            <li>
              <strong>Choose what to remove.</strong> Use the checkboxes or Queue safe items. Open
              an item to see its full path and why it matched.
            </li>
            <li>
              <strong>Review the queue.</strong> Check the paths and deletion mode, then confirm.
              Local trash keeps the data and still occupies disk space.
            </li>
            <li>
              <strong>Check the result.</strong> Sweep reports completed, failed and unattempted
              items. Stopping work does not undo completed deletion.
            </li>
          </ol>
        </section>
        <nav className="sweep-start-links" aria-label="Start using Sweep">
          <Link to="/docs/$" params={{ _splat: "users/getting-started" }}>
            Install and get started
          </Link>
          <Link to="/docs/$" params={{ _splat: "users/safety" }}>
            Understand safety
          </Link>
          <Link to="/docs/$" params={{ _splat: "developer/benchmarks" }}>
            Read the benchmarks
          </Link>
          <Link to="/docs/$" params={{ _splat: "users/automation" }}>
            Use Sweep with scripts and agents
          </Link>
        </nav>
        <p>
          These guides describe the current source checkout. Some improvements are awaiting release;
          check your installed version.
        </p>
      </article>
    </HomeLayout>
  );
}
