const repository = "https://github.com/KitsuneKode/sweep/blob/main/";

/** Keep repository Markdown readable while routing the same links on the site. */
export function docHref(pagePath: string, href: string | undefined): string | undefined {
  if (!href || href.startsWith("#")) return href;
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
    return /^(https?:|mailto:|tel:)/i.test(href) ? href : undefined;
  }
  if (href.startsWith("//")) return href;
  if (href.startsWith("/")) return href;
  const base = new URL(`docs/${pagePath}`, "https://content.invalid/");
  const target = new URL(href, base);
  if (target.pathname === "/docs/benchmark-results.json") return "/benchmark-results.json";
  if (target.pathname.startsWith("/docs/") && /\.mdx?$/.test(target.pathname)) {
    const slug = target.pathname
      .slice(6)
      .replace(/\.mdx?$/, "")
      .replace(/(?:^|\/)index$/, "");
    return `/docs${slug ? `/${slug}` : ""}${target.search}${target.hash}`;
  }
  return `${repository}${target.pathname.slice(1)}${target.search}${target.hash}`;
}
