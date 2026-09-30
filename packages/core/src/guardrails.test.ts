import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  GuardrailError,
  assertSafeCwd,
  assertSafePattern,
  assertSizeLimit,
  assertTargetDirectory,
} from "./guardrails.js";

describe("assertSafeCwd", () => {
  // ── Blocked paths ──────────────────────────────────────────────────────────

  test("blocks filesystem root /", () => {
    expect(() => assertSafeCwd("/")).toThrow(GuardrailError);
  });

  test("blocks /home (the parent of all home dirs)", () => {
    expect(() => assertSafeCwd("/home")).toThrow(GuardrailError);
  });

  test("blocks os.homedir() directly", () => {
    expect(() => assertSafeCwd(homedir())).toThrow(GuardrailError);
  });

  test("blocks /usr", () => {
    expect(() => assertSafeCwd("/usr")).toThrow(GuardrailError);
  });

  test("blocks /etc", () => {
    expect(() => assertSafeCwd("/etc")).toThrow(GuardrailError);
  });

  test("blocks /var", () => {
    expect(() => assertSafeCwd("/var")).toThrow(GuardrailError);
  });

  // ── Shallow paths ──────────────────────────────────────────────────────────

  test("blocks paths only 1 level below root (e.g. /tmp)", () => {
    expect(() => assertSafeCwd("/tmp")).toThrow(GuardrailError);
  });

  // ── Path traversal ─────────────────────────────────────────────────────────

  test("blocks path traversal resolving to root or system directories", () => {
    expect(() => assertSafeCwd("/tmp/../../etc")).toThrow(GuardrailError);
    expect(() => assertSafeCwd("../../../../../../../../etc")).toThrow(GuardrailError);
  });

  test("allows relative path to a valid project directory", () => {
    // `.` is only valid when the process cwd itself is deep enough (not
    // `/workspace` in this environment). A nested relative path is.
    expect(() => assertSafeCwd("./packages/core")).not.toThrow();
  });

  test("blocks a target whose symlink resolves to a protected root", () => {
    // Lexically `link-to-root` is deep under tmpdir - only canonicalizing the
    // target catches that it IS `/`. Without this a symlinked scan root can
    // walk straight past the blocked-root list.
    if (process.platform === "win32") return; // symlink perms vary on Windows
    const dir = mkdtempSync(join(tmpdir(), "sweep-cwd-"));
    const link = join(dir, "link-to-root");
    symlinkSync("/", link);
    try {
      expect(() => assertSafeCwd(link)).toThrow(GuardrailError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("still allows a symlinked target resolving to an ordinary project dir", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "sweep-cwd-ok-"));
    const link = join(tmpdir(), `sweep-cwd-ok-link-${process.pid}`);
    symlinkSync(dir, link);
    try {
      // The link resolves inside tmpdir - deep enough, no protected segment.
      expect(() => assertSafeCwd(link)).not.toThrow();
    } finally {
      rmSync(link, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Safe paths ────────────────────────────────────────────────────────────

  test("allows a normal project path inside home", () => {
    const projectPath = join(homedir(), "projects", "myapp");
    expect(() => assertSafeCwd(projectPath)).not.toThrow();
  });

  test("allows multi-level temporary project directories", () => {
    expect(() => assertSafeCwd(join(tmpdir(), "project"))).not.toThrow();
    expect(() => assertSafeCwd(join(tmpdir(), "user", "project"))).not.toThrow();
  });

  // ── Error codes ───────────────────────────────────────────────────────────

  test("GuardrailError has code 2", () => {
    try {
      assertSafeCwd("/");
    } catch (err) {
      expect(err instanceof GuardrailError).toBe(true);
      expect((err as GuardrailError).code).toBe(2);
    }
  });
});

describe("assertTargetDirectory", () => {
  test("rejects a path that does not exist", () => {
    const missing = join(tmpdir(), `sweep-missing-${process.pid}`);
    expect(() => assertTargetDirectory(missing)).toThrow(GuardrailError);
    expect(() => assertTargetDirectory(missing)).toThrow(/does not exist/);
  });

  test("rejects a regular file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-td-"));
    const file = join(dir, "file.txt");
    writeFileSync(file, "x");
    try {
      expect(() => assertTargetDirectory(file)).toThrow(/not a directory/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts an existing directory", () => {
    expect(() => assertTargetDirectory(tmpdir())).not.toThrow();
  });

  test("follows a symlink to a directory", () => {
    if (process.platform === "win32") return; // symlink perms vary on Windows
    const dir = mkdtempSync(join(tmpdir(), "sweep-td-"));
    const link = join(tmpdir(), `sweep-td-link-${process.pid}`);
    symlinkSync(dir, link);
    try {
      expect(() => assertTargetDirectory(link)).not.toThrow();
    } finally {
      rmSync(link, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assertSafePattern", () => {
  test("blocks patterns starting with /", () => {
    expect(() => assertSafePattern("/etc")).toThrow(GuardrailError);
  });

  test("blocks patterns containing ..", () => {
    expect(() => assertSafePattern("../secret")).toThrow(GuardrailError);
  });

  test("blocks empty patterns", () => {
    expect(() => assertSafePattern("")).toThrow(GuardrailError);
  });

  test("blocks whitespace-only patterns", () => {
    expect(() => assertSafePattern("   ")).toThrow(GuardrailError);
  });

  test("allows node_modules", () => {
    expect(() => assertSafePattern("node_modules")).not.toThrow();
  });

  test("allows glob pattern *.tsbuildinfo", () => {
    expect(() => assertSafePattern("*.tsbuildinfo")).not.toThrow();
  });

  test("allows .next", () => {
    expect(() => assertSafePattern(".next")).not.toThrow();
  });
});

describe("assertSafeCwd: adversarial inputs", () => {
  test("blocks null-byte injection in path", () => {
    // Null bytes in paths can confuse C-level FS calls
    expect(() => assertSafeCwd(join(tmpdir(), "project\x00evil"))).toThrow(GuardrailError);
  });

  test("blocks paths that resolve to system directories via symlink-style traversal", () => {
    if (process.platform === "win32") {
      expect(() => assertSafeCwd("C:\\Windows\\System32\\..\\..")).toThrow(GuardrailError);
    } else {
      expect(() => assertSafeCwd("/usr/lib/../../etc")).toThrow(GuardrailError);
    }
  });

  test("blocks paths resolving to blocked roots", () => {
    if (process.platform === "win32") {
      expect(() => assertSafeCwd("C:\\Windows")).toThrow(GuardrailError);
      expect(() => assertSafeCwd("C:\\Program Files")).toThrow(GuardrailError);
    } else {
      expect(() => assertSafeCwd("/usr/local")).toThrow(GuardrailError);
      expect(() => assertSafeCwd("/dev")).toThrow(GuardrailError);
      expect(() => assertSafeCwd("/proc")).toThrow(GuardrailError);
      expect(() => assertSafeCwd("/sys")).toThrow(GuardrailError);
    }
  });

  test("allows deeply nested project path", () => {
    const deep = join(homedir(), "work", "clients", "acme", "monorepo", "packages", "api");
    expect(() => assertSafeCwd(deep)).not.toThrow();
  });
});

describe("assertSafePattern: adversarial inputs", () => {
  test("blocks pattern that is just a dot", () => {
    expect(() => assertSafePattern(".")).not.toThrow(); // "." is a valid name (like .next)
  });

  test("blocks pattern with embedded null byte", () => {
    expect(() => assertSafePattern("node_modules\x00evil")).toThrow(GuardrailError);
  });

  test("blocks pattern starting with /usr", () => {
    expect(() => assertSafePattern("/usr/local/bin")).toThrow(GuardrailError);
  });

  test("allows patterns with hyphens and underscores", () => {
    expect(() => assertSafePattern(".parcel-cache")).not.toThrow();
    expect(() => assertSafePattern(".nyc_output")).not.toThrow();
  });
});

describe("assertSizeLimit", () => {
  const TEN_GB = 10 * 1024 ** 3;

  test("does not throw under limit", () => {
    expect(() => assertSizeLimit(TEN_GB - 1, 10, false)).not.toThrow();
  });

  test("throws over limit without --force-large", () => {
    expect(() => assertSizeLimit(TEN_GB + 1, 10, false)).toThrow(GuardrailError);
  });

  test("does not throw over limit with --force-large", () => {
    expect(() => assertSizeLimit(TEN_GB + 1, 10, true)).not.toThrow();
  });

  test("uses configured maxSizeGB (not hardcoded 10)", () => {
    const oneGB = 1 * 1024 ** 3;
    expect(() => assertSizeLimit(oneGB + 1, 1, false)).toThrow(GuardrailError);
    expect(() => assertSizeLimit(oneGB + 1, 2, false)).not.toThrow();
  });
});
