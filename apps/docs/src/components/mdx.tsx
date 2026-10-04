import defaultComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { docHref } from "../lib/links";

export function mdxComponents(path: string): MDXComponents {
  const Anchor = defaultComponents.a;
  return {
    ...defaultComponents,
    a: (props) => <Anchor {...props} href={docHref(path, props.href)} />,
  };
}
