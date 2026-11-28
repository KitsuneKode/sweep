import { describe, expect, test } from "bun:test";
import {
  compareVersion,
  evaluateElfAbi,
  extractSharedObjectsFromMetafile,
  parseReadelfInterpreter,
  parseReadelfNeeded,
  parseReadelfVersions,
} from "./check-elf-abi.js";

const SAMPLE_VERNEED_217 = `
Version symbols section '.gnu.version' contains 42 entries:
  000:   0 (*local*)       2 (GLIBC_2.2.5)

Version needs section '.gnu.version_r' contains 1 entry:
 Addr: 0x0000000000001000  Offset: 0x00001000  Link: 6 (.dynstr)
  000000: Version: 1  File: libc.so.6  Cnt: 4
  0x0010:   Name: GLIBC_2.17  Flags: none  Version: 5
  0x0020:   Name: GLIBC_2.14  Flags: none  Version: 4
  0x0030:   Name: GLIBC_2.3.4  Flags: none  Version: 3
  0x0040:   Name: GLIBC_2.2.5  Flags: none  Version: 2
`;

const SAMPLE_VERNEED_239 = `
Version needs section '.gnu.version_r' contains 1 entry:
  000000: Version: 1  File: libc.so.6  Cnt: 2
  0x0010:   Name: GLIBC_2.39  Flags: none  Version: 3
  0x0020:   Name: GLIBC_2.17  Flags: none  Version: 2
`;

// Regression fixture for the observed Debian 11 false pass: numeric versions
// are <= 2.2.5, but GLIBC_ABI_DT_RELR requires glibc >= 2.36.
const SAMPLE_VERNEED_DT_RELR = `
Version needs section '.gnu.version_r' contains 1 entry:
  000000: Version: 1  File: libc.so.6  Cnt: 2
  0x0010:   Name: GLIBC_2.2.5  Flags: none  Version: 2
  0x0020:   Name: GLIBC_ABI_DT_RELR  Flags: none  Version: 3
`;

describe("check-elf-abi", () => {
  test("compares dotted glibc versions numerically", () => {
    expect(compareVersion("2.2.5", "2.17")).toBeLessThan(0);
    expect(compareVersion("2.17", "2.17")).toBe(0);
    expect(compareVersion("2.17", "2.17.0")).toBe(0);
    expect(compareVersion("2.39", "2.17")).toBeGreaterThan(0);
    expect(compareVersion("2.34", "2.9")).toBeGreaterThan(0);
  });

  test("parses version needs, DT_NEEDED, and program interpreter from readelf output", () => {
    const parsed = parseReadelfVersions(SAMPLE_VERNEED_217);
    expect(parsed.glibcVersions).toEqual(["2.2.5", "2.3.4", "2.14", "2.17"]);
    expect(parsed.disallowedGlibcVersions).toEqual([]);
    expect(parsed.hasGlibcPrivate).toBe(false);

    expect(
      parseReadelfInterpreter(
        "  INTERP  0x000318 0x000318 0x000318 0x00001c 0x00001c R 0x1\n" +
          "      [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]\n",
      ),
    ).toBe("/lib64/ld-linux-x86-64.so.2");
    expect(parseReadelfInterpreter("  LOAD 0x000000 ...")).toBeNull();

    expect(
      parseReadelfNeeded(
        " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]\n" +
          " 0x0000000000000001 (NEEDED)             Shared library: [libm.so.6]\n",
      ),
    ).toEqual(["libc.so.6", "libm.so.6"]);
    expect(parseReadelfNeeded("There is no dynamic section in this file.\n")).toEqual([]);
  });

  test("rejects GLIBC_ABI_DT_RELR even when numeric GLIBC versions are <= 2.17", () => {
    const parsed = parseReadelfVersions(SAMPLE_VERNEED_DT_RELR);
    expect(parsed.glibcVersions).toEqual(["2.2.5"]);
    expect(parsed.disallowedGlibcVersions).toEqual(["GLIBC_ABI_DT_RELR"]);

    const res = evaluateElfAbi({
      mode: "glibc",
      maxGlibc: "2.17",
      ...parsed,
      interpreter: "/lib64/ld-linux-x86-64.so.2",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("GLIBC_ABI_DT_RELR");
  });

  test("accepts glibc binaries and shared objects at or below 2.17 and rejects GLIBC_2.39 and GLIBC_PRIVATE", () => {
    const ok = evaluateElfAbi({
      mode: "glibc",
      maxGlibc: "2.17",
      ...parseReadelfVersions(SAMPLE_VERNEED_217),
      interpreter: "/lib64/ld-linux-x86-64.so.2",
    });
    expect(ok.ok).toBe(true);
    expect(ok.maxFound).toBe("2.17");

    const okSo = evaluateElfAbi({
      mode: "glibc-so",
      maxGlibc: "2.17",
      ...parseReadelfVersions(SAMPLE_VERNEED_217),
      interpreter: null,
      neededLibraries: ["libc.so.6", "libm.so.6"],
    });
    expect(okSo.ok).toBe(true);

    const tooNew = evaluateElfAbi({
      mode: "glibc",
      maxGlibc: "2.17",
      ...parseReadelfVersions(SAMPLE_VERNEED_239),
      interpreter: "/lib64/ld-linux-x86-64.so.2",
    });
    expect(tooNew.ok).toBe(false);
    expect(tooNew.error).toContain("GLIBC_2.39");
    expect(tooNew.error).toContain("GLIBC_2.17");

    const privateSym = evaluateElfAbi({
      mode: "glibc",
      maxGlibc: "2.17",
      glibcVersions: ["2.17"],
      hasGlibcPrivate: true,
      interpreter: "/lib64/ld-linux-x86-64.so.2",
    });
    expect(privateSym.ok).toBe(false);
    expect(privateSym.error).toContain("GLIBC_PRIVATE");
  });

  test("enforces static linkage (no PT_INTERP and no DT_NEEDED) for musl engines and gates musl shared objects", () => {
    expect(
      evaluateElfAbi({
        mode: "musl-static",
        glibcVersions: [],
        interpreter: null,
        neededLibraries: [],
      }).ok,
    ).toBe(true);

    // Must reject DT_NEEDED even when PT_INTERP is absent.
    const withNeeded = evaluateElfAbi({
      mode: "musl-static",
      glibcVersions: [],
      interpreter: null,
      neededLibraries: ["libc.musl-x86_64.so.1"],
    });
    expect(withNeeded.ok).toBe(false);
    expect(withNeeded.error).toContain("DT_NEEDED");

    expect(
      evaluateElfAbi({
        mode: "musl-static",
        glibcVersions: [],
        interpreter: "/lib/ld-musl-x86_64.so.1",
        neededLibraries: [],
      }).ok,
    ).toBe(false);

    expect(
      evaluateElfAbi({
        mode: "musl-static",
        glibcVersions: ["2.17"],
        interpreter: null,
        neededLibraries: [],
      }).ok,
    ).toBe(false);

    expect(
      evaluateElfAbi({
        mode: "musl-dynamic",
        glibcVersions: [],
        interpreter: "/lib/ld-musl-x86_64.so.1",
        neededLibraries: ["libc.so", "libstdc++.so.6"],
      }).ok,
    ).toBe(true);

    expect(
      evaluateElfAbi({
        mode: "musl-dynamic",
        glibcVersions: [],
        interpreter: "/lib64/ld-linux-x86-64.so.2",
      }).ok,
    ).toBe(false);

    expect(
      evaluateElfAbi({
        mode: "musl-so",
        glibcVersions: [],
        interpreter: null,
        neededLibraries: ["libc.so"],
      }).ok,
    ).toBe(true);

    const badMuslSo = evaluateElfAbi({
      mode: "musl-so",
      glibcVersions: [],
      interpreter: null,
      neededLibraries: ["libc.so.6"],
    });
    expect(badMuslSo.ok).toBe(false);
    expect(badMuslSo.error).toContain("libc.so.6");
  });

  test("extracts embedded .so inputs from Bun build metafile", () => {
    const meta = JSON.stringify({
      inputs: {
        "apps/cli/src/bin-standalone.ts": { bytes: 100 },
        "node_modules/.bun/@opentui+core-linux-x64@0.6.8/node_modules/@opentui/core-linux-x64/libopentui.so":
          { bytes: 5255600 },
      },
    });
    expect(extractSharedObjectsFromMetafile(meta)).toEqual([
      "node_modules/.bun/@opentui+core-linux-x64@0.6.8/node_modules/@opentui/core-linux-x64/libopentui.so",
    ]);
  });
});
