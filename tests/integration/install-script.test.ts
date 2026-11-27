import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALL_SH = join(REPO_ROOT, "install.sh");

function sha256(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function hostAssetName(libc: "glibc" | "musl" = "glibc"): string | null {
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!os || !arch) return null;
  if (os === "linux" && libc === "musl") return `sweep-linux-${arch}-musl`;
  return `sweep-${os}-${arch}`;
}

function writeFakeReleaseAsset(
  dir: string,
  assetName: string,
  scriptBody: string | Buffer,
  options: { badChecksum?: boolean; omitGzip?: boolean } = {},
): void {
  mkdirSync(dir, { recursive: true });
  const raw = Buffer.isBuffer(scriptBody) ? scriptBody : Buffer.from(scriptBody, "utf8");
  const rawSum = options.badChecksum ? "0".repeat(64) : sha256(raw);
  writeFileSync(join(dir, assetName), raw);
  writeFileSync(join(dir, `${assetName}.sha256`), `${rawSum}  ${assetName}\n`);

  if (!options.omitGzip) {
    const gz = gzipSync(raw);
    const gzSum = options.badChecksum ? "0".repeat(64) : sha256(gz);
    writeFileSync(join(dir, `${assetName}.gz`), gz);
    writeFileSync(join(dir, `${assetName}.gz.sha256`), `${gzSum}  ${assetName}.gz\n`);
  }
}

const isPosixHost = process.platform === "linux" || process.platform === "darwin";

describe.if(isPosixHost)("install.sh", () => {
  let root = "";
  let releaseRoot = "";
  let server: ReturnType<typeof Bun.serve> | null = null;
  const requestedPaths: string[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sweep-install-sh-test-"));
    releaseRoot = join(root, "releases");

    const asset = hostAssetName("glibc")!;
    const muslAsset = hostAssetName("musl")!;

    writeFakeReleaseAsset(
      join(releaseRoot, "latest/download"),
      asset,
      "#!/usr/bin/env sh\necho '0.9.0-latest'\n",
    );
    writeFakeReleaseAsset(
      join(releaseRoot, "download/v0.5.2"),
      asset,
      "#!/usr/bin/env sh\necho '0.5.2'\n",
    );
    writeFakeReleaseAsset(
      join(releaseRoot, "download/v0.5.2"),
      muslAsset,
      "#!/usr/bin/env sh\necho '0.5.2-musl'\n",
    );
    writeFakeReleaseAsset(
      join(releaseRoot, "download/v0.5.3-badsum"),
      asset,
      "#!/usr/bin/env sh\necho '0.5.3'\n",
      { badChecksum: true },
    );
    writeFakeReleaseAsset(
      join(releaseRoot, "download/v0.5.4-broken"),
      asset,
      "#!/usr/bin/env sh\necho 'incompatible glibc' >&2\nexit 127\n",
    );
    writeFakeReleaseAsset(
      join(releaseRoot, "download/v0.5.4-alpine-missing-cpp"),
      asset,
      "#!/usr/bin/env sh\necho 'Error relocating /tmp/sweep: libstdc++.so.6: symbol not found' >&2\nexit 127\n",
    );
    // Highly compressible 128 KiB payload to test bounded decompression cap.
    writeFakeReleaseAsset(
      join(releaseRoot, "download/v0.5.5-bomb"),
      asset,
      Buffer.alloc(128 * 1024, "A"),
    );

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requestedPaths.push(url.pathname);
        if (url.pathname.includes("v0.5.9-http403")) {
          return new Response("forbidden", { status: 403 });
        }
        const filePath = join(releaseRoot, url.pathname.replace(/^\/+/, ""));
        if (!existsSync(filePath)) {
          return new Response("not found", { status: 404 });
        }
        return new Response(Bun.file(filePath));
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function runInstall(env: Record<string, string>) {
    const proc = Bun.spawn(["sh", INSTALL_SH], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: root,
        SWEEP_RELEASE_BASE_URL: `http://127.0.0.1:${server!.port}`,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }

  test("prefers .gz asset with verified checksum and installs atomically", async () => {
    const installDir = join(root, "install-gz");
    requestedPaths.length = 0;

    const proc = await runInstall({ SWEEP_INSTALL_DIR: installDir });
    expect(proc.exitCode).toBe(0);

    const installed = join(installDir, "sweep");
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf8")).toContain("0.9.0-latest");
    // No leftover staging directory inside INSTALL_DIR.
    expect(readdirSync(installDir)).toEqual(["sweep"]);
    expect(requestedPaths.some((p) => p.endsWith(".gz"))).toBe(true);
    expect(requestedPaths.some((p) => p.endsWith(".gz.sha256"))).toBe(true);
  });

  test("falls back to raw asset when gzip is unavailable", async () => {
    const installDir = join(root, "install-nogzip");
    const noGzipBin = join(root, "bin-no-gzip");
    mkdirSync(noGzipBin, { recursive: true });
    for (const tool of [
      "sh",
      "uname",
      "tr",
      "curl",
      "mktemp",
      "sha256sum",
      "shasum",
      "awk",
      "mkdir",
      "chmod",
      "mv",
      "rm",
      "wc",
      "head",
      "cat",
      "ldd",
    ]) {
      const resolved = Bun.which(tool);
      if (resolved) {
        symlinkSync(resolved, join(noGzipBin, tool));
      }
    }

    requestedPaths.length = 0;
    const proc = await runInstall({
      SWEEP_INSTALL_DIR: installDir,
      SWEEP_VERSION: "0.5.2",
      PATH: noGzipBin,
    });
    expect(proc.exitCode).toBe(0);
    expect(requestedPaths.some((p) => p.endsWith(".gz"))).toBe(false);
    expect(requestedPaths.some((p) => p.endsWith(".sha256"))).toBe(true);
    expect(readFileSync(join(installDir, "sweep"), "utf8")).toContain("0.5.2");
  });

  test("accepts SWEEP_VERSION with and without a leading v", async () => {
    for (const version of ["0.5.2", "v0.5.2"]) {
      const installDir = join(root, `install-ver-${version}`);
      requestedPaths.length = 0;

      const proc = await runInstall({
        SWEEP_INSTALL_DIR: installDir,
        SWEEP_VERSION: version,
      });
      expect(proc.exitCode).toBe(0);
      expect(requestedPaths.every((p) => p.startsWith("/download/v0.5.2/"))).toBe(true);
      expect(readFileSync(join(installDir, "sweep"), "utf8")).toContain("0.5.2");
    }
  });

  test("rejects checksum mismatch and preserves an existing binary", async () => {
    const installDir = join(root, "install-badsum");
    mkdirSync(installDir, { recursive: true });
    const existing = join(installDir, "sweep");
    writeFileSync(existing, "#!/usr/bin/env sh\necho '0.5.1-existing'\n");
    chmodSync(existing, 0o755);

    const proc = await runInstall({
      SWEEP_INSTALL_DIR: installDir,
      SWEEP_VERSION: "0.5.3-badsum",
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("checksum mismatch");
    expect(readFileSync(existing, "utf8")).toContain("0.5.1-existing");
    expect(readdirSync(installDir)).toEqual(["sweep"]);
  });

  test("exits nonzero and preserves existing binary when staged binary fails --version", async () => {
    const installDir = join(root, "install-broken");
    mkdirSync(installDir, { recursive: true });
    const existing = join(installDir, "sweep");
    writeFileSync(existing, "#!/usr/bin/env sh\necho '0.5.1-working'\n");
    chmodSync(existing, 0o755);

    const proc = await runInstall({
      SWEEP_INSTALL_DIR: installDir,
      SWEEP_VERSION: "0.5.4-broken",
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("failed --version");
    expect(readFileSync(existing, "utf8")).toContain("0.5.1-working");
    expect(readdirSync(installDir)).toEqual(["sweep"]);
  });

  test("prints Alpine apk add hint when staged binary fails due to missing libstdc++/libgcc", async () => {
    const installDir = join(root, "install-alpine-hint");
    const proc = await runInstall({
      SWEEP_INSTALL_DIR: installDir,
      SWEEP_VERSION: "0.5.4-alpine-missing-cpp",
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("apk add libstdc++ libgcc");
  });

  test("refuses cleanly when destination $INSTALL_DIR/sweep is a directory", async () => {
    const installDir = join(root, "install-dest-is-dir");
    const destDir = join(installDir, "sweep");
    mkdirSync(destDir, { recursive: true });

    const proc = await runInstall({
      SWEEP_INSTALL_DIR: installDir,
      SWEEP_VERSION: "0.5.2",
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("is a directory");
    expect(statSync(destDir).isDirectory()).toBe(true);
    expect(existsSync(join(destDir, "sweep"))).toBe(false);
  });

  test("fails cleanly on non-writable install directory while preserving existing binary", async () => {
    if (process.getuid?.() === 0) return;
    const installDir = join(root, "install-readonly");
    mkdirSync(installDir, { recursive: true });
    const existing = join(installDir, "sweep");
    writeFileSync(existing, "#!/usr/bin/env sh\necho '0.5.1-readonly'\n");
    chmodSync(existing, 0o755);
    chmodSync(installDir, 0o555);
    try {
      const proc = await runInstall({
        SWEEP_INSTALL_DIR: installDir,
        SWEEP_VERSION: "0.5.2",
      });
      expect(proc.exitCode).not.toBe(0);
      expect(readFileSync(existing, "utf8")).toContain("0.5.1-readonly");
    } finally {
      chmodSync(installDir, 0o755);
    }
  });

  test("caps download size and decompression size before executing or installing", async () => {
    const dlDir = join(root, "install-cap-dl");
    const dlProc = await runInstall({
      SWEEP_INSTALL_DIR: dlDir,
      SWEEP_VERSION: "0.5.2",
      SWEEP_TEST_MAX_DOWNLOAD_BYTES: "8",
    });
    expect(dlProc.exitCode).not.toBe(0);
    expect(dlProc.stderr).toContain("exceeds maximum allowed size");
    expect(existsSync(join(dlDir, "sweep"))).toBe(false);

    const bombDir = join(root, "install-cap-decomp");
    const bombProc = await runInstall({
      SWEEP_INSTALL_DIR: bombDir,
      SWEEP_VERSION: "0.5.5-bomb",
      SWEEP_TEST_MAX_DECOMPRESSED_BYTES: "4096",
    });
    expect(bombProc.exitCode).not.toBe(0);
    expect(bombProc.stderr).toContain("decompressed binary exceeds maximum allowed size");
    expect(existsSync(join(bombDir, "sweep"))).toBe(false);
  });

  test("distinguishes HTTP 404 (missing asset), HTTP 403, curl write error (exit 23), and network error", async () => {
    const missingDir = join(root, "install-404");
    const missingProc = await runInstall({
      SWEEP_INSTALL_DIR: missingDir,
      SWEEP_VERSION: "9.9.9-does-not-exist",
    });
    expect(missingProc.exitCode).not.toBe(0);
    expect(missingProc.stderr).toContain("HTTP 404");
    expect(missingProc.stderr).toContain("release asset missing");

    const http403Dir = join(root, "install-403");
    const http403Proc = await runInstall({
      SWEEP_INSTALL_DIR: http403Dir,
      SWEEP_VERSION: "0.5.9-http403",
    });
    expect(http403Proc.exitCode).not.toBe(0);
    expect(http403Proc.stderr).toContain("HTTP 403");
    expect(http403Proc.stderr).not.toContain("release asset missing");

    // Simulate curl exit 23 (write error) via a fake curl binary.
    const writeErrBin = join(root, "fake-curl-23");
    mkdirSync(writeErrBin, { recursive: true });
    writeFileSync(join(writeErrBin, "curl"), "#!/usr/bin/env sh\nexit 23\n");
    chmodSync(join(writeErrBin, "curl"), 0o755);
    const writeErrProc = await runInstall({
      SWEEP_INSTALL_DIR: join(root, "install-curl23"),
      SWEEP_VERSION: "0.5.2",
      PATH: `${writeErrBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    });
    expect(writeErrProc.exitCode).not.toBe(0);
    expect(writeErrProc.stderr).toContain("write error");
    expect(writeErrProc.stderr).toContain("curl exit 23");
    expect(writeErrProc.stderr).not.toContain("release asset missing");

    // Simulate curl exit 7 (network error) via a fake curl binary.
    const netErrBin = join(root, "fake-curl-7");
    mkdirSync(netErrBin, { recursive: true });
    writeFileSync(join(netErrBin, "curl"), "#!/usr/bin/env sh\nexit 7\n");
    chmodSync(join(netErrBin, "curl"), 0o755);
    const netErrProc = await runInstall({
      SWEEP_INSTALL_DIR: join(root, "install-curl7"),
      SWEEP_VERSION: "0.5.2",
      PATH: `${netErrBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    });
    expect(netErrProc.exitCode).not.toBe(0);
    expect(netErrProc.stderr).toContain("network error");
    expect(netErrProc.stderr).toContain("curl exit 7");
    expect(netErrProc.stderr).not.toContain("release asset missing");
  });

  test("selects musl asset when musl is detected on Linux", async () => {
    if (process.platform !== "linux") return;
    const installDir = join(root, "install-musl");
    const fakeBin = join(root, "fake-musl-bin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, "ldd"), "#!/usr/bin/env sh\necho 'musl libc (x86_64)'\n");
    chmodSync(join(fakeBin, "ldd"), 0o755);

    requestedPaths.length = 0;
    const proc = await runInstall({
      SWEEP_INSTALL_DIR: installDir,
      SWEEP_VERSION: "0.5.2",
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    });
    expect(proc.exitCode).toBe(0);
    expect(requestedPaths.some((p) => p.includes("-musl.gz"))).toBe(true);
    expect(readFileSync(join(installDir, "sweep"), "utf8")).toContain("0.5.2-musl");
  });

  test("points Windows shells (MINGW/MSYS/Cygwin) to install.ps1", async () => {
    const installDir = join(root, "install-msys");
    const fakeBin = join(root, "fake-msys-bin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      join(fakeBin, "uname"),
      '#!/usr/bin/env sh\nif [ "$1" = "-m" ]; then echo x86_64; else echo MINGW64_NT-10.0; fi\n',
    );
    chmodSync(join(fakeBin, "uname"), 0o755);

    const proc = await runInstall({
      SWEEP_INSTALL_DIR: installDir,
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("install.ps1");
  });
});
