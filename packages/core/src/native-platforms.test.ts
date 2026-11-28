import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  currentNativePlatformId,
  detectLinuxLibc,
  NATIVE_PLATFORM_NPM_NAMES,
  NATIVE_PLATFORMS,
  nativePlatformById,
  parseElfInterpreter,
  readElfInterpreter,
} from "./native-platforms.js";
import { sweepPackageRoot } from "./rust-engine.js";

function buildMinimalElf64WithInterp(interp: string | null): Uint8Array {
  const interpBytes = interp ? Buffer.from(`${interp}\0`, "utf8") : Buffer.alloc(0);
  const phoff = 64;
  const phentsize = 56;
  const phnum = interp ? 1 : 0;
  const interpOffset = phoff + phentsize * phnum;
  const buf = Buffer.alloc(interpOffset + interpBytes.length);
  // ELF magic + ELFCLASS64 + ELFDATA2LSB + EV_CURRENT
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = 2;
  buf[5] = 1;
  buf[6] = 1;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setBigUint64(32, BigInt(phoff), true);
  view.setUint16(54, phentsize, true);
  view.setUint16(56, phnum, true);
  if (interp) {
    view.setUint32(phoff, 3, true); // PT_INTERP
    view.setBigUint64(phoff + 8, BigInt(interpOffset), true);
    view.setBigUint64(phoff + 32, BigInt(interpBytes.length), true);
    interpBytes.copy(buf, interpOffset);
  }
  return buf;
}

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

  test("parseElfInterpreter extracts PT_INTERP from ELF64 and ignores static/non-ELF files", () => {
    expect(parseElfInterpreter(buildMinimalElf64WithInterp("/lib/ld-musl-x86_64.so.1"))).toBe(
      "/lib/ld-musl-x86_64.so.1",
    );
    expect(parseElfInterpreter(buildMinimalElf64WithInterp("/lib64/ld-linux-x86-64.so.2"))).toBe(
      "/lib64/ld-linux-x86-64.so.2",
    );
    expect(parseElfInterpreter(buildMinimalElf64WithInterp(null))).toBeNull();
    expect(parseElfInterpreter(Buffer.from("not an elf binary"))).toBeNull();

    if (process.platform === "linux") {
      const interp = readElfInterpreter(process.execPath);
      expect(interp).not.toBeNull();
      expect(interp!).toMatch(/ld-(?:linux|musl)/i);
    }
  });

  test("detectLinuxLibc prefers executable PT_INTERP even in mixed-libc environments", () => {
    // Alpine with gcompat / glibc compatibility libraries mapped alongside musl.
    expect(
      detectLinuxLibc({
        elfInterpreter: "/lib/ld-musl-x86_64.so.1",
        procSelfMaps:
          "7f000000-7f010000 r-xp 0 /lib/ld-musl-x86_64.so.1\n7f020000 r-xp 0 /lib/libc.so.6\n",
        glibcVersionRuntime: "2.39",
      }),
    ).toBe("musl");

    expect(
      detectLinuxLibc({
        elfInterpreter: "/lib64/ld-linux-x86-64.so.2",
        procSelfMaps: "7f000000-7f010000 r-xp 0 /lib/ld-musl-x86_64.so.1\n",
        glibcVersionRuntime: null,
      }),
    ).toBe("glibc");
  });

  test("detectLinuxLibc uses /proc/self/maps, falls back to runtime report, and returns unknown when inconclusive or mixed", () => {
    expect(
      detectLinuxLibc({
        elfInterpreter: null,
        procSelfMaps: "7f000000-7f010000 r-xp 00000000 00:00 0 /lib/ld-musl-x86_64.so.1\n",
        glibcVersionRuntime: null,
      }),
    ).toBe("musl");

    expect(
      detectLinuxLibc({
        elfInterpreter: null,
        procSelfMaps: "7f000000-7f010000 r-xp 00000000 00:00 0 /usr/lib/libc.so.6\n",
        glibcVersionRuntime: null,
      }),
    ).toBe("glibc");

    // Both musl and glibc mapped with no authoritative PT_INTERP -> explicit unknown.
    expect(
      detectLinuxLibc({
        elfInterpreter: null,
        procSelfMaps:
          "7f000000-7f010000 r-xp 0 /lib/ld-musl-x86_64.so.1\n" +
          "7f020000-7f030000 r-xp 0 /usr/lib/libc.so.6\n",
        glibcVersionRuntime: "2.39",
      }),
    ).toBe("unknown");

    // Runtime report used only when PT_INTERP and /proc/self/maps are unavailable.
    expect(
      detectLinuxLibc({
        elfInterpreter: null,
        procSelfMaps: null,
        glibcVersionRuntime: "2.39",
      }),
    ).toBe("glibc");

    // Inconclusive evidence must return "unknown" (never guess glibc or musl).
    expect(
      detectLinuxLibc({
        elfInterpreter: null,
        procSelfMaps: null,
        glibcVersionRuntime: null,
      }),
    ).toBe("unknown");
  });

  test.skipIf(process.platform !== "linux")(
    "detectLinuxLibc never invokes ldd from ambient PATH",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "sweep-no-ldd-"));
      const marker = join(root, "ldd-was-run");
      const fakeLdd = join(root, "ldd");
      try {
        writeFileSync(
          fakeLdd,
          `#!/usr/bin/env sh\necho ran > ${JSON.stringify(marker)}\nexit 99\n`,
        );
        chmodSync(fakeLdd, 0o755);
        const modPath = join(import.meta.dir, "native-platforms.ts");
        const proc = Bun.spawn(
          [
            process.execPath,
            "-e",
            `import { detectLinuxLibc } from ${JSON.stringify(modPath)}; console.log(detectLinuxLibc());`,
          ],
          {
            env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [code, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        expect(code).toBe(0);
        expect(stderr).toBe("");
        expect(["glibc", "musl"]).toContain(stdout.trim());
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("currentNativePlatformId resolves glibc, musl, unknown (null), macOS, Windows, and unsupported hosts", () => {
    expect(currentNativePlatformId({ platform: "linux", arch: "x64", libc: "glibc" })).toBe(
      "linux-64",
    );
    expect(currentNativePlatformId({ platform: "linux", arch: "x64", libc: "musl" })).toBe(
      "linux-64-musl",
    );
    expect(currentNativePlatformId({ platform: "linux", arch: "x64", libc: "unknown" })).toBeNull();
    expect(currentNativePlatformId({ platform: "linux", arch: "arm64", libc: "glibc" })).toBe(
      "linux-arm64",
    );
    expect(currentNativePlatformId({ platform: "linux", arch: "arm64", libc: "musl" })).toBe(
      "linux-arm64-musl",
    );
    expect(
      currentNativePlatformId({ platform: "linux", arch: "arm64", libc: "unknown" }),
    ).toBeNull();
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
      if (libc === "unknown") {
        expect(id).toBeNull();
      } else {
        const suffix = libc === "musl" ? "-musl" : "";
        expect(id).toBe(`${process.arch === "x64" ? "linux-64" : "linux-arm64"}${suffix}`);
      }
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
