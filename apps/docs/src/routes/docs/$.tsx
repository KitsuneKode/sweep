import { use } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { docs, source } from "../../lib/source";
import { layoutOptions } from "../../lib/layout";
import { pageHead } from "../../lib/site";
import { mdxComponents } from "../../components/mdx";

export const Route = createFileRoute("/docs/$")({
  loader: async ({ params }) => {
    const page = source.getPage(params._splat?.split("/").filter(Boolean) ?? []);
    if (!page) throw notFound();
    const content = docs.getPage(page.path);
    if (!content) throw notFound();
    await content.preload();
    return {
      path: page.path,
      url: page.url,
      title: page.data.title,
      description: page.data.description ?? "Sweep documentation",
    };
  },
  head: ({ loaderData }) =>
    loaderData
      ? pageHead(loaderData.title, loaderData.description, loaderData.url, __DOCS_SITE_URL__)
      : pageHead("Page not found", "This documentation page does not exist.", "/docs", undefined),
  component: Page,
});
function Page() {
  const data = Route.useLoaderData();
  const content = docs.getPage(data.path)!;
  const { toc } = use(content.load());
  const Body = content.body;
  return (
    <DocsLayout {...layoutOptions} tree={source.getPageTree()}>
      <DocsPage id="main-content" tabIndex={-1} toc={toc}>
        <DocsTitle>{data.title}</DocsTitle>
        <DocsDescription>{data.description}</DocsDescription>
        <DocsBody>
          <Body components={mdxComponents(data.path)} />
        </DocsBody>
      </DocsPage>
    </DocsLayout>
  );
}
