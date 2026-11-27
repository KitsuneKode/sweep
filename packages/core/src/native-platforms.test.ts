import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  currentNativePlatformId,
  detectLinuxLibc,
  NATIVE_PLATFORM_NPM_NAMES,
  NATIVE_PLATFORMS,
  nativePlatformById,
} from "./native-platforms.js";
import { sweepPackageRoot } from "./rust-engine.js";

describe("native platforms", () => {
  test("defines seven platform packages including Linux musl", () => {
    expect(NATIVE_PLATFORMS).toHaveLength(7);
    expect(NATIVE_PLATFORM_NPM_NAMES).toEqual([
      "@kitsunekode/sweep-engine-linux-64",
      "@kitsunekode/sweep-engine-linux-64-musl",
      "@kitsunekode/sweep-engine-linux-arm64",
      "@kitsunekode/sweep-engine-linux-arm64-musl",
      "@kitsunekode/sweep-engine-darwin-64",
      "@kitsunekode/sweep-engine-darwin-arm64",
      "@kitsunekode/sweep-engine-windows-64",
    ]);
  });

  test("declares libc on Linux platforms and omits it on macOS/Windows", () => {
    for (const platform of NATIVE_PLATFORMS) {
      if (platform.os === "linux") {
        expect(platform.libc).toBe(platform.id.endsWith("-musl") ? "musl" : "glibc");
      } else {
        expect(platform.libc).toBeUndefined();
      }
    }
  });

  test("detectLinuxLibc prefers glibc runtime report over musl files on disk", () => {
    expect(
      detectLinuxLibc({
        glibcVersionRuntime: "2.39",
        procSelfMaps: null,
        lddOutput: null,
        muslLoaderExists: true,
      }),
    ).toBe("glibc");
  });

  test("detectLinuxLibc identifies musl from /proc/self/maps and ldd output", () => {
    expect(
      detectLinuxLibc({
        glibcVersionRuntime: null,
        procSelfMaps: "7f000000-7f010000 r-xp 00000000 00:00 0 /lib/ld-musl-x86_64.so.1\n",
        lddOutput: null,
        muslLoaderExists: false,
      }),
    ).toBe("musl");

    expect(
      detectLinuxLibc({
        glibcVersionRuntime: null,
        procSelfMaps: "7f000000-7f010000 r-xp 00000000 00:00 0 /usr/lib/libc.so.6\n",
        lddOutput: null,
        muslLoaderExists: true,
      }),
    ).toBe("glibc");

    expect(
      detectLinuxLibc({
        glibcVersionRuntime: null,
        procSelfMaps: null,
        lddOutput: "musl libc (x86_64)\nVersion 1.2.5",
        muslLoaderExists: false,
      }),
    ).toBe("musl");

    expect(
      detectLinuxLibc({
        glibcVersionRuntime: null,
        procSelfMaps: null,
        lddOutput: "ldd (GNU libc) 2.31",
        muslLoaderExists: true,
      }),
    ).toBe("glibc");
  });

  test("currentNativePlatformId resolves glibc, musl, macOS, Windows, and unsupported hosts", () => {
    expect(currentNativePlatformId({ platform: "linux", arch: "x64", libc: "glibc" })).toBe(
      "linux-64",
    );
    expect(currentNativePlatformId({ platform: "linux", arch: "x64", libc: "musl" })).toBe(
      "linux-64-musl",
    );
    expect(currentNativePlatformId({ platform: "linux", arch: "arm64", libc: "glibc" })).toBe(
      "linux-arm64",
    );
    expect(currentNativePlatformId({ platform: "linux", arch: "arm64", libc: "musl" })).toBe(
      "linux-arm64-musl",
    );
    expect(currentNativePlatformId({ platform: "darwin", arch: "x64" })).toBe("darwin-64");
    expect(currentNativePlatformId({ platform: "darwin", arch: "arm64" })).toBe("darwin-arm64");
    expect(currentNativePlatformId({ platform: "win32", arch: "x64" })).toBe("windows-64");
    expect(currentNativePlatformId({ platform: "win32", arch: "arm64" })).toBeNull();
    expect(currentNativePlatformId({ platform: "freebsd", arch: "x64" })).toBeNull();
  });

  test("currentNativePlatformId matches host when supported", () => {
    const id = currentNativePlatformId();
    if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
      const libc = detectLinuxLibc();
      const suffix = libc === "musl" ? "-musl" : "";
      expect(id).toBe(`${process.arch === "x64" ? "linux-64" : "linux-arm64"}${suffix}`);
    }
    if (id) {
      expect(nativePlatformById(id)?.npmName).toMatch(/^@kitsunekode\/sweep-engine-/);
    }
  });
});

describe("sweepPackageRoot", () => {
  test("resolves repo root from packages/core/src", () => {
    const coreSrc = resolve(import.meta.dir);
    const root = sweepPackageRoot(coreSrc);
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(existsSync(join(root, "apps/cli"))).toBe(true);
  });

  test("resolves package root from dist layout", () => {
    const fakeDistDir = resolve("/tmp/sweep-pkg/dist");
    expect(sweepPackageRoot(fakeDistDir)).toBe(resolve("/tmp/sweep-pkg"));
    const fakeDistFile = resolve("/tmp/sweep-pkg/dist/sweep.js");
    expect(sweepPackageRoot(dirname(fakeDistFile))).toBe(resolve("/tmp/sweep-pkg"));
  });
});
