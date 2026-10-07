import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("actual preflight accepts preview versions and rejects malformed versions", async () => {
  // Execute the real script against owned manifests. Other checks deliberately
  // fail because this is not a complete release tree; no publication runs.
  const parent = join(import.meta.dir, "../../../target");
  mkdirSync(parent, { recursive: true });
  const owned = mkdtempSync(join(parent, "preflight-version-"));
  const cli = join(owned, "apps/cli");
  mkdirSync(join(cli, "scripts"), { recursive: true });
  for (const script of ["preflight.ts", "release-policy.ts"])
    copyFileSync(join(import.meta.dir, script), join(cli, "scripts", script));
  try {
    for (const [version, valid] of [
      ["0.4.0-next.0", true],
      ["0.4.0", true],
      ["0.4.0-next.01", false],
      ["01.4.0", false],
    ] as const) {
      writeFileSync(
        join(cli, "package.json"),
        JSON.stringify({ name: "@kitsunekode/sweep", version }),
      );
      const child = Bun.spawn([process.execPath, join(cli, "scripts/preflight.ts")], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).not.toBe(0); // Missing dist must still refuse publication.
      expect(valid ? out : err).toContain(`${valid ? "✓" : "✗"}  version is valid release semver`);
      if (!valid) expect(err).toContain("Invalid release version");
    }
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
});
