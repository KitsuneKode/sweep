#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(import.meta.dir, "..");
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  ".turbo",
  ".changeset",
  ".worktrees",
]);

function walkMdFiles(dir: string, results: string[] = []): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walkMdFiles(fullPath, results);
    } else if (entry.isFile() && /\.mdx?$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

interface BrokenLink {
  file: string;
  linkText: string;
  url: string;
  reason: string;
}

function checkFile(filePath: string): BrokenLink[] {
  const content = readFileSync(filePath, "utf8");
  const broken: BrokenLink[] = [];

  // Match inline links [text](url)
  const inlineRegex = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;
  let match;

  const validate = (url: string, linkText: string) => {
    // Strip anchors and query params
    const cleanUrl = url.split("?")[0]!.split("#")[0]!;

    // Ignore web and email links, and page-local anchors
    if (
      cleanUrl.startsWith("http://") ||
      cleanUrl.startsWith("https://") ||
      cleanUrl.startsWith("mailto:") ||
      cleanUrl === ""
    ) {
      return;
    }

    if (cleanUrl.startsWith("file://")) {
      try {
        const targetPath = fileURLToPath(cleanUrl);
        if (!existsSync(targetPath)) {
          broken.push({
            file: filePath,
            linkText,
            url,
            reason: `File does not exist: ${targetPath}`,
          });
        }
      } catch (err) {
        broken.push({
          file: filePath,
          linkText,
          url,
          reason: `Invalid file URL: ${(err as Error).message}`,
        });
      }
    } else {
      const targetPath = resolve(dirname(filePath), cleanUrl);
      if (!existsSync(targetPath)) {
        broken.push({
          file: filePath,
          linkText,
          url,
          reason: `Path does not exist: ${targetPath}`,
        });
      }
    }
  };

  while ((match = inlineRegex.exec(content)) !== null) {
    const linkText = match[1] || "";
    const url = match[2] || "";
    validate(url, linkText);
  }

  // Match reference links [ref]: url
  const refRegex = /^\[([^\]\n]+)\]:\s*([^\s\n]+)/gm;
  while ((match = refRegex.exec(content)) !== null) {
    const linkText = match[1] || "";
    const url = match[2] || "";
    validate(url, linkText);
  }

  return broken;
}

function main() {
  const files = walkMdFiles(REPO_ROOT);
  const allBroken: BrokenLink[] = [];

  for (const file of files) {
    const broken = checkFile(file);
    allBroken.push(...broken);
  }

  const publicRoot = join(REPO_ROOT, "docs");
  const publicFiles = files.filter((file) => file.startsWith(`${publicRoot}${sep}`));
  const publicErrors: string[] = [];
  const titles = new Set<string>();
  for (const file of publicFiles) {
    const content = readFileSync(file, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content)?.[1];
    const title = frontmatter && /^title:\s*(.+)$/m.exec(frontmatter)?.[1];
    const description = frontmatter && /^description:\s*(.+)$/m.exec(frontmatter)?.[1];
    if (!title || !description)
      publicErrors.push(`${file}: title/description frontmatter required`);
    if (title && titles.has(title)) publicErrors.push(`${file}: duplicate page title ${title}`);
    if (title) titles.add(title);
  }
  const folders = new Set([publicRoot, ...publicFiles.map(dirname)]);
  for (const folder of folders) {
    const meta = join(folder, "meta.json");
    try {
      const navigation: unknown = JSON.parse(readFileSync(meta, "utf8"));
      if (typeof navigation !== "object" || navigation === null || !("pages" in navigation)) {
        throw new Error("pages array required");
      }
      const pages = navigation.pages;
      if (
        !Array.isArray(pages) ||
        pages.some((slug) => typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug))
      ) {
        throw new Error("pages must contain simple content slugs");
      }
      if (new Set(pages).size !== pages.length) throw new Error("duplicate navigation slug");
      for (const slug of pages as string[]) {
        if (
          ![`${slug}.md`, `${slug}.mdx`, `${slug}/index.md`, `${slug}/index.mdx`].some((path) =>
            existsSync(join(folder, path)),
          )
        ) {
          publicErrors.push(`${meta}: missing page ${slug}`);
        }
      }
      for (const file of publicFiles.filter((path) => dirname(path) === folder)) {
        const slug = file.slice(folder.length + 1).replace(/\.mdx?$/, "");
        if (!pages.includes(slug)) publicErrors.push(`${meta}: unlisted page ${slug}`);
      }
    } catch (error) {
      publicErrors.push(`${meta}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (publicErrors.length > 0) {
    console.error(publicErrors.join("\n"));
    process.exit(1);
  }

  if (allBroken.length > 0) {
    console.error(`\x1b[31mFound ${allBroken.length} broken link(s):\x1b[0m\n`);
    for (const link of allBroken) {
      const relFile = link.file.startsWith(REPO_ROOT)
        ? link.file.slice(REPO_ROOT.length + 1)
        : link.file;
      console.error(`\x1b[33m${relFile}\x1b[0m:`);
      console.error(`  Link: [${link.linkText}](${link.url})`);
      console.error(`  Reason: ${link.reason}\n`);
    }
    process.exit(1);
  }

  console.log("\x1b[32m✔ All documentation links are valid!\x1b[0m");
}

main();
