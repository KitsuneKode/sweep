import { describe, expect, test } from "bun:test";
import { docJsonLd, homeJsonLd, jsonLdText, pageHead, parseSiteUrl, robots, sitemap } from "./site";
import { docHref } from "./links";

describe("public documentation boundaries", () => {
  test("unconfigured previews cannot advertise themselves as canonical or indexable", () => {
    expect(parseSiteUrl(undefined)).toBeUndefined();
    expect(robots()).toContain("Disallow: /");
    const head = pageHead("Safety", "Review before deletion", "/docs/users/safety");
    expect(head.links).toEqual([]);
    expect(head.meta).toContainEqual({ name: "robots", content: "noindex, nofollow" });
  });
  test("only a deliberately configured public HTTPS origin is accepted", () => {
    expect(parseSiteUrl("https://docs.example.org/")).toBe("https://docs.example.org");
    for (const value of [
      "http://docs.example.org",
      "https://localhost",
      "https://127.0.0.1",
      "https://user:secret@docs.example.org",
      "https://docs.example.org/docs",
      "https://docs.example.org/?token=x",
      "https://docs.example.org/#x",
      "https://docs.example.org:4430",
    ]) {
      expect(() => parseSiteUrl(value)).toThrow();
    }
    expect(robots("https://docs.example.org")).toContain(
      "Sitemap: https://docs.example.org/sitemap.xml",
    );
    expect(
      pageHead("Safety", "Review", "/docs/users/safety", "https://docs.example.org").links,
    ).toEqual([{ rel: "canonical", href: "https://docs.example.org/docs/users/safety" }]);
  });
  test("social images and structured data need a public origin", () => {
    const jsonLd = () => [{ "@type": "WebSite" }];
    const preview = pageHead("Safety", "Review", "/docs/users/safety", undefined, { jsonLd });
    expect(preview.scripts).toEqual([]);
    expect(preview.meta).toContainEqual({ name: "twitter:card", content: "summary" });
    expect(preview.meta.some((m) => "property" in m && m.property === "og:image")).toBe(false);

    const site = "https://docs.example.org";
    const live = pageHead("Safety", "Review", "/docs/users/safety", site, {
      type: "article",
      jsonLd,
    });
    expect(live.meta).toContainEqual({ property: "og:image", content: `${site}/og.png` });
    expect(live.meta).toContainEqual({ name: "twitter:card", content: "summary_large_image" });
    expect(live.meta).toContainEqual({ property: "og:type", content: "article" });
    expect(live.scripts).toHaveLength(1);
  });
  test("structured data cannot close its script tag", () => {
    const text = jsonLdText({ name: "</script><script>alert(1)</script>" });
    expect(text).not.toContain("<");
    expect(JSON.parse(text).name).toBe("</script><script>alert(1)</script>");
  });
  test("home and docs structured data use absolute URLs", () => {
    const site = "https://docs.example.org";
    const [web, app] = homeJsonLd(site, `${site}/`) as Record<string, unknown>[];
    expect(web!["@type"]).toBe("WebSite");
    expect(app!.image).toBe(`${site}/og.png`);
    const [, crumbs] = docJsonLd("Safety", "Review", [
      { name: "Docs", path: "/docs" },
      { name: "Safety", path: "/docs/users/safety" },
    ])(site, `${site}/docs/users/safety`) as { itemListElement: { item: string }[] }[];
    expect(crumbs!.itemListElement.map((i) => i.item)).toEqual([
      `${site}/docs`,
      `${site}/docs/users/safety`,
    ]);
  });
  test("sitemap deduplicates routes and escapes XML", () => {
    const xml = sitemap(["/", "/docs", "/docs", "/docs?a=1&b=2"], "https://docs.example.org");
    expect(xml.match(/<loc>/g)?.length).toBe(3);
    expect(xml).toContain("a=1&amp;b=2");
  });
  test("repository Markdown resolves to documentation routes including anchors and hubs", () => {
    expect(docHref("index.md", "users/getting-started.md")).toBe("/docs/users/getting-started");
    expect(docHref("users/platforms.md", "../developer/benchmarks.md#memory")).toBe(
      "/docs/developer/benchmarks#memory",
    );
    expect(docHref("users/commands.md", "./index.md")).toBe("/docs/users");
    expect(docHref("users/commands.md", "../index.md")).toBe("/docs");
    expect(docHref("developer/benchmarks.md", "../benchmark-results.json")).toBe(
      "/benchmark-results.json",
    );
    expect(docHref("users/index.md", "../../README.md")).toBe(
      "https://github.com/KitsuneKode/sweep/blob/main/README.md",
    );
    expect(docHref("users/index.md", "#safety")).toBe("#safety");
    expect(docHref("users/index.md", "javascript:alert(1)")).toBeUndefined();
    expect(docHref("users/index.md", "data:text/html,<script>")).toBeUndefined();
    expect(docHref("users/index.md", "https://example.org/test.md")).toBe(
      "https://example.org/test.md",
    );
  });
});
