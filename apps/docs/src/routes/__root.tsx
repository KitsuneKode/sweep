import { createRootRoute, HeadContent, Outlet, Scripts, Link } from "@tanstack/react-router";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import css from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
    ],
    links: [{ rel: "stylesheet", href: css }],
  }),
  component: Root,
  notFoundComponent: () => (
    <main id="main-content" className="p-8">
      <h1>Page not found</h1>
      <p>This documentation page does not exist.</p>
      <Link to="/docs/$" params={{ _splat: "" }}>
        Browse the docs
      </Link>
    </main>
  ),
  errorComponent: ({ reset }) => (
    <main id="main-content" className="p-8">
      <h1>Could not load this page</h1>
      <p>Try again or browse the documentation.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>{" "}
      <Link to="/docs/$" params={{ _splat: "" }}>
        Browse the docs
      </Link>
    </main>
  ),
});
function Root() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider>
          <a href="#main-content" className="sr-only focus:not-sr-only">
            Skip to content
          </a>
          <Outlet />
        </RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
