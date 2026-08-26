import { join } from "node:path";
import { REPO_ROOT, readCliVersion } from "./bundle.js";

const version = readCliVersion();
const target = process.argv[2];
const outfile = process.argv[3] ?? "sweep";

console.log(`building standalone binary (${outfile})...`);

const buildConfig: any = {
  entrypoints: [join(REPO_ROOT, "apps/cli/src/bin.ts")],
  target: "bun",
  minify: {
    syntax: true,
    whitespace: true,
  },
  outfile,
  define: {
    __SWEEP_VERSION__: JSON.stringify(version),
  },
};

if (target && target.startsWith("bun-")) {
  buildConfig.target = target;
}

await Bun.build(buildConfig);
console.log(`✓ standalone executable ready: ${outfile}`);
