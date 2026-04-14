import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const OUT = join(DIST, "sweep.js");

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
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(" ", log);
  }
  process.exit(1);
}

// Prepend shebang manually — must be the very first byte of the file
const content = readFileSync(OUT, "utf8");
writeFileSync(OUT, `#!/usr/bin/env node\n${content}`);

// Make executable
chmodSync(OUT, 0o755);

const stat = Bun.file(OUT);
const sizeKB = (stat.size / 1024).toFixed(1);

console.log(`✓ dist/sweep.js  (${sizeKB} KB)`);
console.log("  Run: node dist/sweep.js --help");
