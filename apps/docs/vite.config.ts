import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { parseSiteUrl } from "./src/lib/site.ts";
const contentDir = fileURLToPath(new URL("../../docs", import.meta.url));
function contentPaths(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return contentPaths(path);
    if (!entry.isFile() || !/\.mdx?$/.test(entry.name)) return [];
    const slug = relative(contentDir, path)
      .replaceAll("\\", "/")
      .replace(/\.mdx?$/, "")
      .replace(/(?:^|\/)index$/, "");
    return [`/docs${slug ? `/${slug}` : ""}`];
  });
}
export default defineConfig({
  resolve: { tsconfigPaths: true },
  define: {
    __DOCS_SITE_URL__: JSON.stringify(parseSiteUrl(process.env.DOCS_SITE_URL)) ?? "undefined",
  },
  plugins: [
    fumadocsMdx(),
    tailwindcss(),
    tanstackStart({
      prerender: {
        enabled: true,
        concurrency: 2,
        crawlLinks: false,
        autoStaticPathsDiscovery: false,
        failOnError: true,
      },
      pages: ["/", ...contentPaths(contentDir)].map((path) => ({
        path,
        prerender: { enabled: true },
      })),
    }),
    react(),
  ],
});
