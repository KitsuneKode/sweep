import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CandidateKind, RebuildCost } from "@kitsunekode/sweep-protocol";
import { catalogEntryFor } from "./catalog.js";

export type { RebuildCost };

export interface Rebuild {
  cost: RebuildCost;
  /** How it comes back, short enough for a 40-cell panel. */
  how: string;
}

export interface RebuildCostMeta {
  label: string;
  hint: string;
}

export const REBUILD_COST_META: Readonly<Record<RebuildCost, Readonly<RebuildCostMeta>>> =
  Object.freeze({
    cache: Object.freeze({ label: "Caches", hint: "Comes back on its own" }),
    install: Object.freeze({ label: "Installs", hint: "Reinstalls from lockfile" }),
    build: Object.freeze({ label: "Builds", hint: "Rebuilds on next compile" }),
    custom: Object.freeze({ label: "Opt-in", hint: "Check first" }),
  });

/** Which package manager reinstalls node_modules here, from its lockfile. */
export function packageManager(root: string): string {
  const has = (file: string) => existsSync(join(root, file));
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  return "npm";
}

const rebuildCache = new Map<string, Rebuild>();

/**
 * Classify how costly it is to regenerate an artifact (`cache`, `install`,
 * `build`, or `custom`) and name the command or tool that brings it back.
 */
export function rebuildFor(kind: CandidateKind, root: string, name?: string): Rebuild {
  const key = `${kind}\0${root}\0${name ?? ""}`;
  const cached = rebuildCache.get(key);
  if (cached) return cached;
  const rebuild = readRebuild(kind, root, name);
  rebuildCache.set(key, rebuild);
  return rebuild;
}

function readRebuild(kind: CandidateKind, root: string, name?: string): Rebuild {
  switch (kind) {
    case "node_modules":
      return { cost: "install", how: `${packageManager(root)} install` };
    case "target":
      if (existsSync(join(root, "Cargo.toml"))) return { cost: "build", how: "cargo build" };
      if (existsSync(join(root, "pom.xml"))) return { cost: "build", how: "mvn package" };
      return { cost: "build", how: "the project's build" };
    case ".next":
      return { cost: "build", how: "next build or next dev" };
    case ".nuxt":
      return { cost: "build", how: "nuxt build or nuxt dev" };
    case ".svelte-kit":
      return { cost: "build", how: "vite dev or vite build" };
    case "dist":
    case "build":
    case "out":
      return { cost: "build", how: "the project's build" };
    case ".turbo":
      return { cost: "cache", how: "turbo refills it" };
    case ".vite":
      return { cost: "cache", how: "vite refills it" };
    case ".parcel-cache":
      return { cost: "cache", how: "parcel refills it" };
    case "tsbuildinfo":
      return { cost: "cache", how: "tsc refills it" };
    case "coverage":
    case ".nyc_output":
      return { cost: "cache", how: "the next coverage run" };
    default: {
      // Opt-in names the catalog knows (.venv, __pycache__...) carry their own
      // note; only a pattern the user wrote is "your pattern".
      const note = name ? catalogEntryFor(name)?.note : undefined;
      return { cost: "custom", how: note ?? "your pattern" };
    }
  }
}
