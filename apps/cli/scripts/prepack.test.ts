import { describe, expect, test } from "bun:test";
import { assertPublishable, resolveDependencies, type Catalogs } from "./prepack.js";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.js";

const catalogs: Catalogs = {
  default: { commander: "^12.1.0", picocolors: "^1.1.1" },
  named: { build: { typescript: "^5.7.2" } },
};

describe("resolveDependencies", () => {
  test("drops internal workspace packages", () => {
    // They are private, never published, and already inside the dist bundle.
    expect(
      resolveDependencies({ "@kitsunekode/sweep-core": "workspace:*" }, catalogs),
    ).toBeUndefined();
  });

  test("resolves a bare catalog: through the default catalog", () => {
    expect(resolveDependencies({ commander: "catalog:" }, catalogs)).toEqual({
      commander: "^12.1.0",
    });
  });

  test("resolves catalog:<name> through the matching named catalog", () => {
    expect(resolveDependencies({ typescript: "catalog:build" }, catalogs)).toEqual({
      typescript: "^5.7.2",
    });
  });

  test("leaves literal ranges alone", () => {
    const block = { "@kitsunekode/sweep-engine-linux-64": "0.3.0" };
    expect(resolveDependencies(block, catalogs)).toEqual(block);
  });

  test("keeps publishable deps while dropping workspace ones", () => {
    expect(
      resolveDependencies(
        { "@kitsunekode/sweep-ui": "workspace:*", commander: "catalog:" },
        catalogs,
      ),
    ).toEqual({ commander: "^12.1.0" });
  });

  test("throws rather than guessing when a catalog entry is missing", () => {
    expect(() => resolveDependencies({ missing: "catalog:" }, catalogs)).toThrow(
      /no catalog entry for missing/,
    );
    expect(() => resolveDependencies({ commander: "catalog:nope" }, catalogs)).toThrow(
      /no catalog named "nope"/,
    );
  });

  test("undefined blocks stay undefined", () => {
    expect(resolveDependencies(undefined, catalogs)).toBeUndefined();
  });
});

describe("assertPublishable", () => {
  // Regression: 0.3.0 shipped with `workspace:*` and `catalog:` intact, so every
  // install failed with EUNSUPPORTEDPROTOCOL. Nothing caught it before publish.
  test("rejects a manifest that still carries workspace: ranges", () => {
    expect(() =>
      assertPublishable({ dependencies: { "@kitsunekode/sweep-core": "workspace:*" } }),
    ).toThrow(/npm cannot install that/);
  });

  test("rejects a manifest that still carries catalog: ranges", () => {
    expect(() => assertPublishable({ dependencies: { commander: "catalog:" } })).toThrow(
      /npm cannot install that/,
    );
  });

  test("checks optional and peer dependencies too", () => {
    expect(() => assertPublishable({ optionalDependencies: { foo: "workspace:*" } })).toThrow();
    expect(() => assertPublishable({ peerDependencies: { bar: "catalog:" } })).toThrow();
  });

  test("accepts a fully resolved manifest", () => {
    expect(() =>
      assertPublishable({
        dependencies: { commander: "^12.1.0" },
        optionalDependencies: { "@kitsunekode/sweep-engine-linux-64": "0.3.0" },
      }),
    ).not.toThrow();
  });
});

test("bundled CLI dependencies are omitted while external dependencies stay", () => {
  expect(
    resolveDependencies(
      { commander: "catalog:", external: "1.0.0" },
      catalogs,
      new Set(["commander"]),
    ),
  ).toEqual({ external: "1.0.0" });
});

test("interrupted packing preserves the original manifest and requires restoration before retry", () => {
  const owned = mkdtempSync(join(tmpdir(), "sweep-pack-recovery-"));
  try {
    const cli = join(owned, "apps/cli");
    const scripts = join(cli, "scripts");
    mkdirSync(scripts, { recursive: true });
    for (const name of ["prepack.ts", "postpack.ts", "atomic-write.ts"])
      copyFileSync(new URL(name, import.meta.url), join(scripts, name));
    writeFileSync(
      join(owned, "package.json"),
      JSON.stringify({ workspaces: { catalog: { commander: "^12.1.0" } } }),
    );
    writeFileSync(join(owned, "README.md"), "Owned package fixture\n");
    writeFileSync(join(owned, "LICENSE"), "MIT\n");
    const manifest = join(cli, "package.json");
    const backup = `${manifest}.prepack-backup`;
    const original =
      '{"name":"owned","version":"0.4.0-next.0","dependencies":{"commander":"catalog:"}}\n';
    writeFileSync(manifest, original);
    const run = (name: string) =>
      execFileSync(process.execPath, [join(scripts, name)], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: "pipe",
      });
    run("prepack.ts");
    expect(readFileSync(backup, "utf8")).toBe(original);
    const packed = readFileSync(manifest, "utf8");
    expect(packed).not.toContain("catalog:");
    expect(() => run("prepack.ts")).toThrow(/interrupted pack/);
    expect(readFileSync(manifest, "utf8")).toBe(packed);
    expect(readFileSync(backup, "utf8")).toBe(original);
    run("postpack.ts");
    expect(readFileSync(manifest, "utf8")).toBe(original);
    expect(existsSync(backup)).toBe(false);
    expect(readdirSync(cli).some((name) => name.endsWith(".tmp"))).toBe(false);
    writeFileSync(backup, '{"name":');
    expect(() => run("postpack.ts")).toThrow(/backup is incomplete/);
    expect(readFileSync(manifest, "utf8")).toBe(original);
    expect(existsSync(backup)).toBe(true);
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
});

test("atomic replacement cleans its staging file if rename fails", () => {
  const owned = mkdtempSync(join(tmpdir(), "sweep-atomic-write-"));
  try {
    const destination = join(owned, "directory");
    mkdirSync(destination);
    expect(() => atomicWrite(destination, "complete manifest\n")).toThrow();
    expect(readdirSync(owned)).toEqual(["directory"]);
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
});
