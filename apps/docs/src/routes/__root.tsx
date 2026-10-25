import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { LoadError, NotFound } from "../components/not-found";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import css from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", media: "(prefers-color-scheme: dark)", content: "#0b0d08" },
      { name: "theme-color", media: "(prefers-color-scheme: light)", content: "#f7f6f0" },
    ],
    links: [
      { rel: "stylesheet", href: css },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  component: Root,
  notFoundComponent: NotFound,
  errorComponent: LoadError,
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
