import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const OUT = join(DIST, "sweep.js");

// Read version from package.json to inject at build time
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };

// Clean dist/
if (existsSync(DIST)) {
  rmSync(DIST, { recursive: true, force: true });
}

console.log("Building sweep...");

const result = await Bun.build({
  entrypoints: [join(ROOT, "src/index.ts")],
  outdir: DIST,
  target: "node",
  minify: {
    whitespace: true,
    syntax: true,
    identifiers: false, // keep readable for error stack traces
  },
  naming: "sweep.js",
  // No banner here — Bun doesn't guarantee it lands on line 1
  external: [],
  define: {
    // Inject version so `sweep --version` always matches package.json
    __SWEEP_VERSION__: JSON.stringify(pkg.version),
  },
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(" ", log);
  }
  process.exit(1);
}

// Prepend shebang + early NO_COLOR check.
//
// The NO_COLOR check MUST run before picocolors' module-level init code in the
// bundle, which captures process.env.NO_COLOR at startup. Since ESM imports are
// hoisted, we can't do this inside index.ts — it must be literally the first
// executable line of the output file.
const content = readFileSync(OUT, "utf8");
const preamble = [
  "#!/usr/bin/env node",
  // eslint-disable-next-line quotes
  "if(process.argv.includes('--no-color'))process.env['NO_COLOR']='1';",
].join("\n");
writeFileSync(OUT, `${preamble}\n${content}`);

// Make executable
chmodSync(OUT, 0o755);

const stat = Bun.file(OUT);
const sizeKB = (stat.size / 1024).toFixed(1);

console.log(`✓ dist/sweep.js  (${sizeKB} KB)`);
console.log("  Run: node dist/sweep.js --help");
