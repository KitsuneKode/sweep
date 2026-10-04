import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";

const root = fileURLToPath(new URL("../../../docs", import.meta.url));
const client = fileURLToPath(new URL("../dist/client", import.meta.url));
const serverUrl = new URL("../dist/server/server.js", import.meta.url);
const app = (await import(serverUrl.href)).default as {
  fetch: (request: Request) => Promise<Response>;
};
async function paths(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const pages: string[] = [];
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) pages.push(...(await paths(path)));
    else if (entry.isFile() && /\.mdx?$/.test(entry.name)) {
      const slug = relative(root, path)
        .replaceAll("\\", "/")
        .replace(/\.mdx?$/, "")
        .replace(/(?:^|\/)index$/, "");
      pages.push(`/docs${slug ? `/${slug}` : ""}`);
    }
  }
  return pages;
}
const pagePaths = ["/", ...(await paths(root))];
let preview = false;
for (const path of pagePaths) {
  const html = await readFile(resolve(client, `.${path}`, "index.html"), "utf8");
  assert.match(html, /<h1[\s>]/, `${path}: prerendered heading is missing`);
  assert.match(html, /name="description"/, `${path}: description is missing`);
  assert.match(html, /<title>[^<]+\| Sweep<\/title>/, `${path}: page title is missing`);
  assert(!/href="[^"#]*\.md(?:[#?"])/.test(html), `${path}: raw Markdown link was not mapped`);
  preview = html.includes('content="noindex, nofollow"');
  if (preview)
    assert(!html.includes('rel="canonical"'), `${path}: preview advertises a canonical URL`);
  const response = await app.fetch(new Request(`http://localhost${path}`));
  assert.equal(response.status, 200, `${path}: SSR route failed`);
}
const query = await app.fetch(new Request("http://localhost/api/search?query=safety"));
assert.equal(query.status, 200);
const results = (await query.json()) as { url: string }[];
assert(
  results.some((item) => item.url === "/docs/users/safety"),
  "search cannot find the safety guide",
);
assert.equal(
  (await app.fetch(new Request(`http://localhost/api/search?query=${"a".repeat(201)}`))).status,
  400,
);
assert.equal((await app.fetch(new Request("http://localhost/docs/does-not-exist"))).status, 404);
assert.equal((await app.fetch(new Request("http://localhost/missing"))).status, 404);
const robots = await app.fetch(new Request("http://localhost/robots.txt"));
assert.equal(robots.status, 200);
assert((await robots.text()).includes(preview ? "Disallow: /\n" : "Sitemap:"));
const sitemap = await app.fetch(new Request("http://localhost/sitemap.xml"));
assert.equal(sitemap.status, preview ? 404 : 200);
if (!preview) assert.equal(((await sitemap.text()).match(/<loc>/g) ?? []).length, pagePaths.length);
const benchmark = await app.fetch(new Request("http://localhost/benchmark-results.json"));
assert.equal(benchmark.status, 200);
assert.equal(benchmark.headers.get("X-Content-Type-Options"), "nosniff");
console.log(
  `Docs smoke passed: ${pagePaths.length} prerendered/SSR pages, mapped links, search, 404s, benchmark data and ${preview ? "preview" : "public"} SEO.`,
);
