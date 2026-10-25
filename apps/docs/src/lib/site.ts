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

export interface HeadOptions {
  /** Use this exact `<title>` instead of `"<title> | Sweep"`. */
  fullTitle?: string;
  type?: "website" | "article";
  /** Structured data; emitted only with a public origin, since it needs absolute URLs. */
  jsonLd?: (siteUrl: string, canonical: string) => object[];
}

const OG_IMAGE = { path: "/og.png", width: "1200", height: "630" };
const OG_ALT = "Sweep's terminal review: build artifacts listed with sizes and risk tiers.";

/** Absolute URLs (canonical, social image, JSON-LD) only exist for a configured public origin. */
export function pageHead(
  title: string,
  description: string,
  path: string,
  siteUrl?: string,
  options: HeadOptions = {},
) {
  const canonical = siteUrl ? new URL(path, siteUrl).href : undefined;
  const fullTitle = options.fullTitle ?? `${title} | Sweep`;
  const image = siteUrl ? new URL(OG_IMAGE.path, siteUrl).href : undefined;
  const jsonLd = siteUrl && canonical ? (options.jsonLd?.(siteUrl, canonical) ?? []) : [];
  return {
    meta: [
      { title: fullTitle },
      { name: "description", content: description },
      { name: "robots", content: siteUrl ? "index, follow" : "noindex, nofollow" },
      { property: "og:title", content: fullTitle },
      { property: "og:description", content: description },
      { property: "og:type", content: options.type ?? "website" },
      { property: "og:site_name", content: "Sweep" },
      { property: "og:locale", content: "en" },
      { name: "twitter:card", content: image ? "summary_large_image" : "summary" },
      ...(canonical ? [{ property: "og:url", content: canonical }] : []),
      ...(image
        ? [
            { property: "og:image", content: image },
            { property: "og:image:width", content: OG_IMAGE.width },
            { property: "og:image:height", content: OG_IMAGE.height },
            { property: "og:image:alt", content: OG_ALT },
            { name: "twitter:image", content: image },
          ]
        : []),
    ],
    links: canonical ? [{ rel: "canonical", href: canonical }] : [],
    scripts: jsonLd.map((data) => ({
      type: "application/ld+json",
      children: jsonLdText(data),
    })),
  };
}

/** JSON for a `<script>` body: `<` is escaped so content can never close the tag. */
export function jsonLdText(data: object): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

const REPOSITORY = "https://github.com/KitsuneKode/sweep";

export function homeJsonLd(siteUrl: string, canonical: string): object[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Sweep",
      url: canonical,
    },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Sweep",
      alternateName: "@kitsunekode/sweep",
      description:
        "A command-line cleaner that finds build artifacts such as node_modules, target and .next across projects and removes only the ones you choose.",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Linux, macOS, Windows",
      url: canonical,
      image: new URL(OG_IMAGE.path, siteUrl).href,
      downloadUrl: "https://www.npmjs.com/package/@kitsunekode/sweep",
      codeRepository: REPOSITORY,
      license: "https://opensource.org/licenses/MIT",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
  ];
}

export function docJsonLd(
  title: string,
  description: string,
  crumbs: { name: string; path: string }[],
) {
  return (siteUrl: string, canonical: string): object[] => [
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: title,
      description,
      url: canonical,
      image: new URL(OG_IMAGE.path, siteUrl).href,
      isPartOf: { "@type": "WebSite", name: "Sweep", url: new URL("/", siteUrl).href },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: crumbs.map((crumb, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: crumb.name,
        item: new URL(crumb.path, siteUrl).href,
      })),
    },
  ];
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
