import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, openTuiProdJsxPlugin, readCliVersion } from "./bundle.js";

export interface StandaloneBuildOptions {
  entry?: string | undefined;
  outfile: string;
  target?: string | undefined;
  assets?: string[] | undefined;
  metafile?: string | undefined;
  bytecode?: boolean | undefined;
  version?: string | undefined;
}

function parseArgs(argv: string[]): {
  target: string;
  outfile: string;
  enginePath?: string;
  metafile?: string;
  noBytecode: boolean;
} {
  const positional: string[] = [];
  let enginePath: string | undefined;
  let metafile: string | undefined;
  let noBytecode = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--engine" || arg === "-e") {
      enginePath = argv[++i];
      if (!enginePath) throw new Error("--engine requires a binary path");
    } else if (arg === "--metafile") {
      metafile = argv[++i];
      if (!metafile) throw new Error("--metafile requires a path");
    } else if (arg.startsWith("--metafile=")) {
      metafile = arg.slice("--metafile=".length);
    } else if (arg === "--no-bytecode") {
      noBytecode = true;
    } else if (arg.startsWith("--engine=")) {
      enginePath = arg.slice("--engine=".length);
    } else {
      positional.push(arg);
    }
  }

  return {
    target: positional[0] ?? "",
    outfile: positional[1] ?? "sweep",
    ...(enginePath !== undefined ? { enginePath } : {}),
    ...(metafile !== undefined ? { metafile } : {}),
    noBytecode,
  };
}

function isLinuxMuslTarget(target: string | undefined): boolean {
  const hostOs = process.platform === "win32" ? "windows" : process.platform;
  const hostPrefix = `bun-${hostOs}-${process.arch}`;
  return process.platform === "linux" && target === `${hostPrefix}-musl`;
}

/**
 * Compile a self-contained Bun executable using the exact same production
 * environment and `@opentui/react` `jsxDEV -> jsx` transform as `scripts/bundle.ts`,
 * so OpenTUI's outer ErrorBoundary never calls an undefined `jsxDEV` in production.
 */
export async function buildStandaloneExecutable(options: StandaloneBuildOptions): Promise<void> {
  const version = options.version ?? readCliVersion();
  const entry = options.entry ?? join(REPO_ROOT, "apps/cli/src/bin-standalone.ts");
  const outfile = resolve(REPO_ROOT, options.outfile);
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  const isLinuxMusl = isLinuxMuslTarget(options.target);
  const define: Record<string, string> = {
    __SWEEP_VERSION__: JSON.stringify(version),
    "process.env.NODE_ENV": '"production"',
    "process.env.DEV": '"false"',
  };
  const external: string[] = [];
  if (process.platform === "linux") {
    define["process.env.OPENTUI_LIBC"] = JSON.stringify(isLinuxMusl ? "musl" : "glibc");
    // Exclude the opposite libc's OpenTUI package so Bun does not embed a dead
    // 5 MiB glibc libopentui.so inside musl standalones (or vice versa).
    const oppositeOpentui = isLinuxMusl
      ? `@opentui/core-linux-${process.arch}`
      : `@opentui/core-linux-${process.arch}-musl`;
    external.push(oppositeOpentui);
  }

  const compile: Extract<NonNullable<Bun.BuildConfig["compile"]>, object> = {
    outfile,
    autoloadDotenv: false,
    autoloadBunfig: false,
    ...(options.assets && options.assets.length > 0 ? { assets: options.assets } : {}),
    ...(options.target && options.target.startsWith("bun-")
      ? { target: options.target as Bun.Build.CompileTarget }
      : {}),
  };

  try {
    const result = await Bun.build({
      entrypoints: [entry],
      compile,
      minify: true,
      format: "esm",
      bytecode: options.bytecode ?? true,
      plugins: [openTuiProdJsxPlugin],
      ...(external.length > 0 ? { external } : {}),
      ...(options.metafile ? { metafile: true } : {}),
      define,
      throw: true,
    });
    if (!result.success) {
      throw new Error(`standalone build failed for ${outfile}`);
    }
    if (options.metafile) {
      if (!result.metafile) {
        throw new Error(`standalone build did not emit metafile for ${outfile}`);
      }
      writeFileSync(
        resolve(REPO_ROOT, options.metafile),
        `${JSON.stringify(result.metafile, null, 2)}\n`,
      );
    }
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

if (import.meta.main) {
  const version = readCliVersion();
  const { target, outfile, enginePath, metafile, noBytecode } = parseArgs(process.argv.slice(2));
  const hostOs = process.platform === "win32" ? "windows" : process.platform;
  const hostPrefix = `bun-${hostOs}-${process.arch}`;
  const isLinuxMusl = isLinuxMuslTarget(target);

  if (target && target !== hostPrefix && !isLinuxMusl) {
    throw new Error("Standalone builds must run on the target platform to embed its native engine");
  }

  const defaultNativeAsset = isLinuxMusl
    ? `target/${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl/release/sweep-engine`
    : `target/release/sweep-engine${process.platform === "win32" ? ".exe" : ""}`;

  const resolvedNative = resolve(REPO_ROOT, enginePath ?? defaultNativeAsset);
  if (!existsSync(resolvedNative)) {
    throw new Error(
      `Native Rust engine not found at ${resolvedNative}; build it first (or pass --engine <path>)`,
    );
  }

  console.log(`building standalone binary (${outfile})...`);
  try {
    await buildStandaloneExecutable({
      outfile,
      target: target || undefined,
      assets: [resolvedNative],
      ...(metafile !== undefined ? { metafile } : {}),
      bytecode: !noBytecode,
      version,
    });
  } catch (error) {
    console.error(`✗ standalone build failed:`, error);
    process.exit(1);
  }

  console.log(`✓ standalone executable ready: ${outfile}`);
}
