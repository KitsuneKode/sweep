/**
 * Prepare apps/cli for `npm pack` / `npm publish`.
 *
 * Copies the root README and LICENSE in, and rewrites the dependency block so
 * the published manifest is installable by npm.
 *
 * The workspace manifest uses Bun's `workspace:` and `catalog:` protocols.
 * `bun publish` resolves those while packing, but `npm publish` — which is what
 * `changeset publish` shells out to — does not: it ships the literal strings and
 * every install then dies with EUNSUPPORTEDPROTOCOL. That is exactly how 0.3.0
 * shipped broken.
 *
 * `postpack.ts` restores the original manifest.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(CLI_ROOT, "../..");
const MANIFEST = join(CLI_ROOT, "package.json");
export const BACKUP = join(CLI_ROOT, "package.json.prepack-backup");

export type DependencyBlock = Record<string, string>;

export interface Catalogs {
  /** The default catalog, used by a bare `catalog:`. */
  default: DependencyBlock;
  /** Named catalogs, used by `catalog:<name>`. */
  named: Record<string, DependencyBlock>;
}

/** Root catalog definitions. Bun accepts them at the root or under `workspaces`. */
export function readCatalogs(repoRoot: string): Catalogs {
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    catalog?: DependencyBlock;
    catalogs?: Record<string, DependencyBlock>;
    workspaces?: { catalog?: DependencyBlock; catalogs?: Record<string, DependencyBlock> };
  };
  return {
    default: root.workspaces?.catalog ?? root.catalog ?? {},
    named: root.workspaces?.catalogs ?? root.catalogs ?? {},
  };
}

/**
 * Rewrite one dependency block for publication.
 *
 * Internal `workspace:` packages are dropped outright: they are `private` and
 * never published, and the bundle in `dist/` already contains their code, so
 * declaring them would only produce an unresolvable dependency.
 */
export function resolveDependencies(
  block: DependencyBlock | undefined,
  catalogs: Catalogs,
): DependencyBlock | undefined {
  if (!block) return undefined;

  const resolved: DependencyBlock = {};
  for (const [name, range] of Object.entries(block)) {
    if (range.startsWith("workspace:")) continue;

    if (range.startsWith("catalog:")) {
      // `catalog:` reads the default catalog; `catalog:<name>` reads a named one.
      const catalogName = range.slice("catalog:".length).trim();
      const source = catalogName.length > 0 ? catalogs.named[catalogName] : catalogs.default;
      if (!source) {
        throw new Error(`prepack: no catalog named "${catalogName}" (${name}: ${range})`);
      }
      const version = source[name];
      if (!version) {
        throw new Error(`prepack: no catalog entry for ${name} (${range})`);
      }
      resolved[name] = version;
      continue;
    }

    resolved[name] = range;
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Guard: nothing Bun-specific may reach the registry. */
export function assertPublishable(manifest: Record<string, unknown>): void {
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const block = manifest[field] as DependencyBlock | undefined;
    if (!block) continue;
    for (const [name, range] of Object.entries(block)) {
      if (range.startsWith("workspace:") || range.startsWith("catalog:")) {
        throw new Error(
          `prepack: ${field}.${name} is "${range}"; npm cannot install that. ` +
            `Resolve it before publishing.`,
        );
      }
    }
  }
}

function main(): void {
  for (const file of ["README.md", "LICENSE"] as const) {
    copyFileSync(join(REPO_ROOT, file), join(CLI_ROOT, file));
  }

  const original = readFileSync(MANIFEST, "utf8");
  // Never overwrite a backup from an interrupted pack; it holds the real manifest.
  if (!existsSync(BACKUP)) writeFileSync(BACKUP, original);

  const manifest = JSON.parse(original) as Record<string, unknown>;
  const catalogs = readCatalogs(REPO_ROOT);

  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const resolved = resolveDependencies(manifest[field] as DependencyBlock | undefined, catalogs);
    if (resolved) manifest[field] = resolved;
    else delete manifest[field];
  }

  assertPublishable(manifest);
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log("prepack: copied README.md and LICENSE, resolved dependencies for publish");
}

if (import.meta.main) main();
