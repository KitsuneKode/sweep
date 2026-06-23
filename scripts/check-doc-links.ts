#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(import.meta.dir, "..");
const IGNORE_DIRS = new Set(["node_modules", ".git", "target", "dist", ".turbo", ".changeset"]);

function walkMdFiles(dir: string, results: string[] = []): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walkMdFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
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
