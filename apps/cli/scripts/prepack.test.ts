import { describe, expect, test } from "bun:test";
import { assertPublishable, resolveDependencies, type Catalogs } from "./prepack.js";

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
