import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_PLATFORMS } from "@kitsunekode/sweep-core/native-platforms";
import { nativePackageJson } from "./package-json.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("nativePackageJson", () => {
  // The release job packs these over the committed files; a reordered key
  // dirtied the tree and the publish guard refused 0.5.0.
  test("is byte-identical to every committed template at its version", () => {
    for (const platform of NATIVE_PLATFORMS) {
      const committed = readFileSync(
        join(REPO_ROOT, "native-packages", platform.id, "package.json"),
        "utf8",
      );
      const version = (JSON.parse(committed) as { version: string }).version;
      expect(nativePackageJson(platform, version)).toBe(committed);
    }
  });
});
