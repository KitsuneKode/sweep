import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

interface Hit {
  url: string;
  title: string;
}

/** Turns the missing path into search words: "/docs/user/saftey-guide" → "user saftey guide". */
function wordsFrom(pathname: string): string {
  return pathname
    .split(/[/_.-]+/)
    .filter((part) => part && part !== "docs")
    .join(" ")
    .slice(0, 120);
}

/**
 * A 404 that behaves like sweep: it scans for the path, finds nothing,
 * confirms nothing was deleted, and suggests real pages from the search index.
 */
export function NotFound() {
  const { pathname } = useLocation();
  const [hits, setHits] = useState<Hit[] | null>(null);

  useEffect(() => {
    const query = wordsFrom(pathname);
    if (!query) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/search?query=${encodeURIComponent(query)}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : []))
      .then((results: { url: string; type: string; content: string }[]) => {
        const seen = new Set<string>();
        const pages: Hit[] = [];
        for (const result of results) {
          const url = result.url.split("#")[0]!;
          if (result.type !== "page" || seen.has(url)) continue;
          seen.add(url);
          // Search highlights matches with <mark>; keep the plain title.
          pages.push({ url, title: result.content.replace(/<[^>]*>/g, "") });
          if (pages.length === 4) break;
        }
        setHits(pages);
      })
      .catch(() => setHits([]));
    return () => controller.abort();
  }, [pathname]);

  return (
    <main id="main-content" tabIndex={-1} className="nf">
      <title>Page not found | Sweep</title>
      <meta name="robots" content="noindex" />
      <Link to="/" className="sweep-wordmark nf-home">
        <span className="sweep-wordmark-tab" aria-hidden="true" />
        sweep
      </Link>

      <div className="nf-folder" aria-hidden="true">
        <span className="nf-folder-back" />
        <span className="nf-dust" />
        <span className="nf-dust" />
        <span className="nf-dust" />
        <span className="nf-folder-front" />
      </div>

      <h1>Nothing here to sweep</h1>
      <p className="nf-lead">This page doesn't exist. It may have moved, or the link has a typo.</p>

      <div className="nf-term" data-ui aria-label="sweep scan output">
        <p className="nf-term-cmd">
          <span>$</span> sweep scan {pathname}
        </p>
        <p className="nf-term-line" style={{ "--i": 0 } as React.CSSProperties}>
          0 found
        </p>
        <p className="nf-term-line" style={{ "--i": 1 } as React.CSSProperties}>
          nothing queued · nothing deleted
        </p>
      </div>

      <nav className="nf-next" aria-label="Where to go next">
        {hits && hits.length > 0 && (
          <>
            <p>Closest pages</p>
            <ul>
              {hits.map((hit) => (
                <li key={hit.url}>
                  <a href={hit.url}>{hit.title}</a>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="nf-links">
          <Link to="/">Home</Link>
          <Link to="/docs/$" params={{ _splat: "users/getting-started" }}>
            Getting started
          </Link>
          <Link to="/docs/$" params={{ _splat: "" }}>
            All docs
          </Link>
        </p>
      </nav>
    </main>
  );
}

export function LoadError({ reset }: { reset: () => void }) {
  return (
    <main id="main-content" tabIndex={-1} className="nf">
      <title>Could not load this page | Sweep</title>
      <meta name="robots" content="noindex" />
      <Link to="/" className="sweep-wordmark nf-home">
        <span className="sweep-wordmark-tab" aria-hidden="true" />
        sweep
      </Link>
      <h1>This page didn't load</h1>
      <p className="nf-lead">
        Something failed while rendering it. Your files are untouched; this is only the website.
      </p>
      <p className="nf-links">
        <button type="button" onClick={reset}>
          Try again
        </button>
        <Link to="/docs/$" params={{ _splat: "" }}>
          Browse the docs
        </Link>
      </p>
    </main>
  );
}
