import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, openTuiProdJsxPlugin, readCliVersion } from "./bundle.js";

export interface StandaloneBuildOptions {
  entry?: string | undefined;
  outfile: string;
  target?: string | undefined;
  assets?: string[] | undefined;
  bytecode?: boolean | undefined;
  version?: string | undefined;
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
      define: {
        __SWEEP_VERSION__: JSON.stringify(version),
        "process.env.NODE_ENV": '"production"',
        "process.env.DEV": '"false"',
      },
      throw: true,
    });
    if (!result.success) {
      throw new Error(`standalone build failed for ${outfile}`);
    }
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

if (import.meta.main) {
  const version = readCliVersion();
  const target = process.argv[2];
  const outfile = process.argv[3] ?? "sweep";
  const nativeAsset = join(
    REPO_ROOT,
    `target/release/sweep-engine${process.platform === "win32" ? ".exe" : ""}`,
  );
  if (!existsSync(nativeAsset)) {
    throw new Error("Build the host Rust engine first: bun run engine:build");
  }
  if (
    target &&
    target !== `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  ) {
    throw new Error("Standalone builds must run on the target platform to embed its native engine");
  }

  console.log(`building standalone binary (${outfile})...`);
  try {
    await buildStandaloneExecutable({
      outfile,
      target: target || undefined,
      assets: [nativeAsset],
      bytecode: !process.argv.includes("--no-bytecode"),
      version,
    });
  } catch (error) {
    console.error(`✗ standalone build failed:`, error);
    process.exit(1);
  }

  console.log(`✓ standalone executable ready: ${outfile}`);
}
