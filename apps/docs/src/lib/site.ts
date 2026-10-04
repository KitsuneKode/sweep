/** Public origin only. Never derive canonicals from a request Host header. */
export function parseSiteUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.port ||
    !url.hostname.includes(".") ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "localhost" ||
    /^\d+(\.\d+){3}$/.test(url.hostname)
  )
    throw new Error("DOCS_SITE_URL must be a public HTTPS origin, without a path or credentials.");
  return url.origin;
}

export function pageHead(title: string, description: string, path: string, siteUrl?: string) {
  const canonical = siteUrl ? new URL(path, siteUrl).href : undefined;
  return {
    meta: [
      { title: `${title} | Sweep` },
      { name: "description", content: description },
      { name: "robots", content: siteUrl ? "index, follow" : "noindex, nofollow" },
      { property: "og:title", content: `${title} | Sweep` },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "Sweep" },
      { name: "twitter:card", content: "summary" },
      ...(canonical ? [{ property: "og:url", content: canonical }] : []),
    ],
    links: canonical ? [{ rel: "canonical", href: canonical }] : [],
  };
}

export function robots(siteUrl?: string): string {
  return siteUrl
    ? `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${siteUrl}/sitemap.xml\n`
    : "User-agent: *\nDisallow: /\n";
}

/** XML escaping is also needed for a configured origin or a future slug. */
export function sitemap(paths: string[], siteUrl: string): string {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
    );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...new Set(paths)].map((path) => `<url><loc>${escape(new URL(path, siteUrl).href)}</loc></url>`).join("")}</urlset>\n`;
}
