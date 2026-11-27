import { describe, expect, test } from "bun:test";
import {
  compareVersion,
  evaluateElfAbi,
  parseReadelfInterpreter,
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

describe("check-elf-abi", () => {
  test("compares dotted glibc versions numerically", () => {
    expect(compareVersion("2.2.5", "2.17")).toBeLessThan(0);
    expect(compareVersion("2.17", "2.17")).toBe(0);
    expect(compareVersion("2.17", "2.17.0")).toBe(0);
    expect(compareVersion("2.39", "2.17")).toBeGreaterThan(0);
    expect(compareVersion("2.34", "2.9")).toBeGreaterThan(0);
  });

  test("parses version needs and program interpreter from readelf output", () => {
    const parsed = parseReadelfVersions(SAMPLE_VERNEED_217);
    expect(parsed.glibcVersions).toEqual(["2.2.5", "2.3.4", "2.14", "2.17"]);
    expect(parsed.hasGlibcPrivate).toBe(false);

    expect(
      parseReadelfInterpreter(
        "  INTERP  0x000318 0x000318 0x000318 0x00001c 0x00001c R 0x1\n" +
          "      [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]\n",
      ),
    ).toBe("/lib64/ld-linux-x86-64.so.2");
    expect(parseReadelfInterpreter("  LOAD 0x000000 ...")).toBeNull();
  });

  test("accepts glibc binaries at or below 2.17 and rejects GLIBC_2.39", () => {
    const ok = evaluateElfAbi({
      mode: "glibc",
      maxGlibc: "2.17",
      ...parseReadelfVersions(SAMPLE_VERNEED_217),
      interpreter: "/lib64/ld-linux-x86-64.so.2",
    });
    expect(ok.ok).toBe(true);
    expect(ok.maxFound).toBe("2.17");

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

  test("enforces static musl engines and dynamic musl standalones", () => {
    expect(
      evaluateElfAbi({
        mode: "musl-static",
        glibcVersions: [],
        hasGlibcPrivate: false,
        interpreter: null,
      }).ok,
    ).toBe(true);

    expect(
      evaluateElfAbi({
        mode: "musl-static",
        glibcVersions: [],
        hasGlibcPrivate: false,
        interpreter: "/lib/ld-musl-x86_64.so.1",
      }).ok,
    ).toBe(false);

    expect(
      evaluateElfAbi({
        mode: "musl-static",
        glibcVersions: ["2.17"],
        hasGlibcPrivate: false,
        interpreter: null,
      }).ok,
    ).toBe(false);

    expect(
      evaluateElfAbi({
        mode: "musl-dynamic",
        glibcVersions: [],
        hasGlibcPrivate: false,
        interpreter: "/lib/ld-musl-x86_64.so.1",
      }).ok,
    ).toBe(true);

    expect(
      evaluateElfAbi({
        mode: "musl-dynamic",
        glibcVersions: [],
        hasGlibcPrivate: false,
        interpreter: "/lib64/ld-linux-x86-64.so.2",
      }).ok,
    ).toBe(false);
  });
});
