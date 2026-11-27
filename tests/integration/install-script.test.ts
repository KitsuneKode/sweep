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
  scriptBody: string,
  options: { badChecksum?: boolean; omitGzip?: boolean } = {},
): void {
  mkdirSync(dir, { recursive: true });
  const raw = Buffer.from(scriptBody, "utf8");
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

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requestedPaths.push(url.pathname);
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
