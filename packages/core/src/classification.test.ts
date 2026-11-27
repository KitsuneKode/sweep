import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanEntry } from "@kitsunekode/sweep-protocol";
import {
  CLOUD_SYNC_REASON,
  hasMacOsAppBundleAncestor,
  isInsideCloudSyncDir,
  isInsideCloudSyncDirFor,
  isInsideToolHome,
  isInsideToolHomeFor,
} from "./classification.js";
import { classifyEntry, toCandidate } from "./planner.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sweep-classification-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function entry(path: string, name: string, entryType: ScanEntry["entryType"]): ScanEntry {
  return { path, name, entryType, isSymlink: false, estimatedBytes: 0 };
}

function dir(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function file(contents: string, ...parts: string[]): string {
  const path = join(root, ...parts);
  writeFileSync(path, contents);
  return path;
}

describe("default names need context to be safe", () => {
  test("a regular file named target is not cargo output", () => {
    dir("docs");
    const path = file("my notes\n", "docs", "target");
    const result = classifyEntry(entry(path, "target", "file"));
    expect(result.riskTier).toBe("dangerous");
    expect(result.reasons).toEqual(["default-pattern", "entry-type-mismatch"]);
    expect(toCandidate(entry(path, "target", "file")).selectedByDefault).toBe(false);
  });

  test("an authored target folder without a cargo marker is not presumed safe", () => {
    const path = dir("notes", "target");
    file("authored essay\n", "notes", "target", "chapter1.md");
    const result = classifyEntry(entry(path, "target", "directory"));
    expect(result.riskTier).toBe("dangerous");
    expect(result.reasons).toEqual(["default-pattern", "no-project-marker"]);
  });

  test("target beside Cargo.toml stays safe", () => {
    const path = dir("crate", "target");
    file("[package]\n", "crate", "Cargo.toml");
    expect(classifyEntry(entry(path, "target", "directory"))).toEqual({
      riskTier: "safe",
      reasons: ["default-pattern"],
    });
  });

  test("target carrying cargo's CACHEDIR.TAG stays safe without a manifest", () => {
    const path = dir("custom-target-dir", "target");
    file(
      "Signature: 8a477f597d28d172789f06886806bc55\n",
      "custom-target-dir",
      "target",
      "CACHEDIR.TAG",
    );
    expect(classifyEntry(entry(path, "target", "directory")).riskTier).toBe("safe");
  });

  test.skipIf(process.platform === "win32")(
    "a symlink named like a cargo marker is not project proof",
    () => {
      const path = dir("spoof", "target");
      const real = file("not a manifest\n", "elsewhere.txt");
      symlinkSync(real, join(root, "spoof", "Cargo.toml"));
      expect(classifyEntry(entry(path, "target", "directory")).reasons).toContain(
        "no-project-marker",
      );

      const tagged = dir("tagged", "target");
      symlinkSync(real, join(tagged, "CACHEDIR.TAG"));
      expect(classifyEntry(entry(tagged, "target", "directory")).reasons).toContain(
        "no-project-marker",
      );
    },
  );

  test("a directory named Cargo.toml is not a manifest", () => {
    const path = dir("odd", "target");
    dir("odd", "Cargo.toml");
    expect(classifyEntry(entry(path, "target", "directory")).reasons).toContain(
      "no-project-marker",
    );
  });

  test("a directory named like a tsbuildinfo file is a type mismatch", () => {
    const path = dir("pkg", "tsconfig.tsbuildinfo");
    expect(classifyEntry(entry(path, "tsconfig.tsbuildinfo", "directory")).reasons).toContain(
      "entry-type-mismatch",
    );
  });

  test("node_modules needs no marker", () => {
    const path = dir("app", "node_modules");
    expect(classifyEntry(entry(path, "node_modules", "directory")).riskTier).toBe("safe");
  });

  test("node_modules inside a system app install is a tool home", () => {
    const result = classifyEntry(
      entry("/usr/share/cursor/resources/app/node_modules", "node_modules", "directory"),
    );
    expect(result.riskTier).toBe("dangerous");
    expect(result.reasons).toEqual(["default-pattern", "tool-home"]);
  });

  test("symlinks keep the caution tier and gain no context reason", () => {
    const result = classifyEntry({
      ...entry(join(root, "target"), "target", "symlink"),
      isSymlink: true,
    });
    expect(result).toEqual({ riskTier: "caution", reasons: ["symlink", "default-pattern"] });
  });
});

describe("isInsideToolHome", () => {
  const home = "/home/dev";

  test.each([
    "/home/dev/.bun/install/global/node_modules",
    "/home/dev/.bun/install/cache/links/zod/node_modules",
    "/home/dev/.npm-global/lib/node_modules",
    "/home/dev/.asdf/installs/nodejs/22/lib/node_modules",
    "/home/dev/.mise/installs/node/22/lib/node_modules",
    "/home/dev/.nodenv/versions/22/lib/node_modules",
    "/home/dev/.pyenv/versions/3.12/lib/node_modules",
    "/home/dev/.poetry/venv/node_modules",
    "/home/dev/.conda/envs/ml/node_modules",
    "/home/dev/miniconda3/envs/ml/node_modules",
    "/home/dev/anaconda3/envs/ml/node_modules",
    "/home/dev/miniforge3/envs/ml/node_modules",
    "/home/dev/mambaforge/envs/ml/node_modules",
    "/home/dev/.uv/tools/ruff/node_modules",
    "/home/dev/.pipx/venvs/tool/node_modules",
    "/home/dev/.rbenv/versions/3.3/node_modules",
    "/home/dev/.rvm/gems/node_modules",
    "/home/dev/.gem/ruby/node_modules",
    "/home/dev/go/pkg/mod/node_modules",
    "/home/dev/.sdkman/candidates/java/node_modules",
    "/home/dev/.gradle/caches/node_modules",
    "/home/dev/.m2/repository/node_modules",
    "/home/dev/.composer/vendor/node_modules",
    "/home/dev/.pub-cache/hosted/node_modules",
    "/home/dev/.android/avd/node_modules",
    "/home/dev/.flutter/packages/node_modules",
    "/home/dev/.var/app/com.example.App/data/node_modules",
    "/home/dev/snap/code/current/node_modules",
    "/home/dev/scoop/apps/node/current/node_modules",
    "/home/dev/.vscode-insiders/extensions/ext/node_modules",
    "/home/dev/.vscode-oss/extensions/ext/node_modules",
    "/home/dev/.windsurf/extensions/ext/node_modules",
    "/home/dev/.windsurf-server/bin/node_modules",
    "/home/dev/.zed/extensions/node_modules",
    "/home/dev/.claude/plugins/node_modules",
    "/home/dev/.codex/skills/node_modules",
    "/home/dev/.gemini/extensions/node_modules",
    "/home/dev/.t3/userdata/node_modules",
    "/home/dev/.local/share/zed/prettier/node_modules",
    "/home/dev/.local/share/nvim/lazy/blink.cmp/target",
    "/home/dev/.config/Cursor/node_modules",
    "/home/dev/.cargo/registry/src/x/target",
    "/home/dev/Applications/Editor.app/Contents/Resources/app/node_modules",
    "/usr/share/cursor/resources/app/node_modules",
    "/usr/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
    "/home/linuxbrew/.linuxbrew/lib/node_modules",
    "/etc/nginx/node_modules",
    "/private/etc/nginx/node_modules",
    "/sys/class/target",
    "/proc/sys/target",
    "/dev/disk/target",
    "/boot/grub/target",
    "/bin/sub/node_modules",
    "/sbin/sub/node_modules",
    "/lib/sub/node_modules",
    "/lib64/sub/node_modules",
    "/var/lib/docker/overlay2/abc/diff/app/node_modules",
    "/nix/store/abc-pkg/lib/node_modules",
  ])("protects %s", (path) => {
    expect(isInsideToolHome(path, home)).toBe(true);
  });

  test.each([
    "/home/dev/Projects/app/node_modules",
    "/home/dev/Projects/example.app/node_modules",
    "/home/dev/go/src/proj/node_modules",
    "/home/dev/go/src/github.com/me/app/node_modules",
    "/home/dev/.t3/worktrees/x/node_modules",
    "/home/dev/.codex/worktrees/x/node_modules",
    "/home/dev/Dropbox/proj/node_modules",
    "/home/dev/OneDrive/Documents/proj/node_modules",
    "/home/dev/OneDrive - Contoso/proj/node_modules",
    "/home/dev/Google Drive/proj/node_modules",
    "/home/dev/My Drive/proj/node_modules",
    "/home/dev/code/.github-like/target",
    "/home/devops/.bun/node_modules",
    "/home/linuxbrew/Projects/app/node_modules",
    "/run/media/u/Data/proj/node_modules",
    "/run/user/1000/gvfs/smb/proj/node_modules",
    "/dev/shm/build/node_modules",
    "/var/www/site/node_modules",
    "/var/folders/xy/T/sweep-test/node_modules",
    "/tmp/sweep-test/node_modules",
    "/srv/app/node_modules",
  ])("leaves %s to the normal rules", (path) => {
    expect(isInsideToolHome(path, home)).toBe(false);
  });

  test("example.app without Contents/Info.plist stays a normal project folder", () => {
    const nm = dir("example.app", "node_modules");
    expect(isInsideToolHome(nm, home)).toBe(false);
    expect(classifyEntry(entry(nm, "node_modules", "directory"))).toEqual({
      riskTier: "safe",
      reasons: ["default-pattern"],
    });
  });

  test(".app bundle detection requires macOS and Contents/Info.plist", () => {
    const nm = dir("Editor.app", "Contents", "Resources", "app", "node_modules");
    file("<plist/>\n", "Editor.app", "Contents", "Info.plist");
    expect(hasMacOsAppBundleAncestor(nm)).toBe(true);
    const fakeDirPlist = dir("Fake.app", "Contents", "Info.plist");
    expect(hasMacOsAppBundleAncestor(join(fakeDirPlist, "node_modules"))).toBe(false);
    expect(hasMacOsAppBundleAncestor(dir("plain.app", "node_modules"))).toBe(false);

    const expected = process.platform === "darwin";
    expect(isInsideToolHome(nm, home)).toBe(expected);
    const result = classifyEntry(entry(nm, "node_modules", "directory"));
    expect(result.riskTier).toBe(expected ? "dangerous" : "safe");
  });

  test("Windows drive and UNC paths do not match Unix OS system roots (cross-platform)", () => {
    const winHome = "C:\\Users\\dev";
    for (const safeWinPath of [
      "C:\\dev\\app\\node_modules",
      "D:\\bin\\x\\node_modules",
      "C:\\etc\\project\\node_modules",
      "\\\\?\\C:\\dev\\app\\node_modules",
      "\\\\server\\share\\dev\\app\\node_modules",
      "\\\\?\\UNC\\server\\share\\dev\\app\\node_modules",
      "C:\\Users\\dev\\AppData\\Local\\Temp\\t\\node_modules",
      "C:\\Users\\dev\\go\\src\\proj\\node_modules",
      "C:\\Users\\dev\\.t3\\worktrees\\x\\node_modules",
      "C:\\Users\\dev\\.codex\\worktrees\\x\\node_modules",
      "C:\\Users\\dev\\OneDrive\\Documents\\proj\\node_modules",
    ]) {
      expect(isInsideToolHomeFor(safeWinPath, winHome, true, false)).toBe(false);
    }

    for (const protectedWinPath of [
      "C:\\Windows\\System32\\target",
      "c:\\windows\\winsxs\\target",
      "\\\\?\\C:\\Windows\\System32\\target",
      "D:\\Program Files\\App\\resources\\node_modules",
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules",
      "C:\\Users\\dev\\go\\pkg\\mod\\node_modules",
      "C:\\Users\\dev\\.t3\\userdata\\node_modules",
      "C:\\Users\\dev\\.codex\\skills\\node_modules",
    ]) {
      expect(isInsideToolHomeFor(protectedWinPath, winHome, true, false)).toBe(true);
    }

    // POSIX paths still match Unix OS roots (except /dev/shm).
    expect(isInsideToolHomeFor("/dev/disk/target", home, false, false)).toBe(true);
    expect(isInsideToolHomeFor("/etc/nginx/node_modules", home, false, false)).toBe(true);
    expect(isInsideToolHomeFor("/dev/shm/build/node_modules", home, false, false)).toBe(false);
    expect(isInsideToolHomeFor("/run/media/u/Data/proj/node_modules", home, false, false)).toBe(
      false,
    );
  });

  test.if(process.platform === "win32")(
    "Windows app data is protected, temp and C:\\dev are not",
    () => {
      const winHome = "C:\\Users\\dev";
      expect(isInsideToolHome("C:\\dev\\app\\node_modules", winHome)).toBe(false);
      expect(isInsideToolHome("D:\\bin\\x\\node_modules", winHome)).toBe(false);
      expect(isInsideToolHome("C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules", winHome)).toBe(
        true,
      );
      expect(isInsideToolHome("c:\\users\\DEV\\appdata\\local\\x\\node_modules", winHome)).toBe(
        true,
      );
      expect(
        isInsideToolHome("C:\\Users\\dev\\AppData\\Local\\Temp\\t\\node_modules", winHome),
      ).toBe(false);
      expect(isInsideToolHome("D:\\Program Files\\App\\resources\\node_modules", winHome)).toBe(
        true,
      );
      expect(isInsideToolHome("C:\\Windows\\System32\\target", winHome)).toBe(true);
      expect(isInsideToolHome("\\\\?\\C:\\Windows\\System32\\target", winHome)).toBe(true);
      expect(isInsideToolHome("\\\\?\\C:\\Users\\dev\\.bun\\node_modules", winHome)).toBe(true);
      expect(isInsideToolHome("C:\\Users\\dev\\scoop\\apps\\node\\node_modules", winHome)).toBe(
        true,
      );
    },
  );

  test("an unset or root home disables home rules but keeps system rules", () => {
    expect(isInsideToolHome("/.bun/node_modules", "/")).toBe(false);
    expect(isInsideToolHome("/usr/share/x/node_modules", "")).toBe(true);
  });
});

describe("cloud-sync folders add a non-blocking informational reason", () => {
  const home = "/home/dev";

  test.each([
    "/home/dev/Dropbox/proj/node_modules",
    "/home/dev/OneDrive/Documents/proj/node_modules",
    "/home/dev/OneDrive - Contoso/proj/node_modules",
    "/home/dev/Google Drive/proj/node_modules",
    "/home/dev/My Drive/proj/node_modules",
    "/home/dev/Library/CloudStorage/GoogleDrive-me@example.com/proj/node_modules",
  ])("tags %s as cloud-sync", (path) => {
    expect(isInsideCloudSyncDir(path, home)).toBe(true);
  });

  test.each([
    "/home/dev/Projects/app/node_modules",
    "/home/dev/DropboxBackup/proj/node_modules",
    "/home/dev/OneDriveBackup/proj/node_modules",
    "/home/dev/OneDrive - /proj/node_modules",
    "/home/dev/Library/CloudStorage",
    "/tmp/Dropbox/proj/node_modules",
  ])("does not tag %s as cloud-sync", (path) => {
    expect(isInsideCloudSyncDir(path, home)).toBe(false);
  });

  test("Windows org-named OneDrive paths match case-insensitively", () => {
    const winHome = "C:\\Users\\dev";
    expect(
      isInsideCloudSyncDirFor(
        "C:\\Users\\dev\\onedrive - acme corp\\proj\\node_modules",
        winHome,
        true,
        false,
      ),
    ).toBe(true);
    expect(
      isInsideCloudSyncDirFor(
        "C:\\Users\\dev\\OneDrive\\Documents\\proj\\node_modules",
        winHome,
        true,
        false,
      ),
    ).toBe(true);
    expect(
      isInsideCloudSyncDirFor("C:\\Users\\dev\\Projects\\app\\node_modules", winHome, true, false),
    ).toBe(false);
  });

  test("cloud-sync reason does not demote safe projects or alter default selection", () => {
    for (const path of [
      "/home/dev/Dropbox/proj/node_modules",
      "/home/dev/OneDrive/Documents/proj/node_modules",
      "/home/dev/OneDrive - Contoso/proj/node_modules",
      "/home/dev/Google Drive/proj/node_modules",
      "/home/dev/My Drive/proj/node_modules",
    ]) {
      const result = classifyEntry(entry(path, "node_modules", "directory"), home);
      expect(result.riskTier).toBe("safe");
      expect(result.reasons).toEqual(["default-pattern", CLOUD_SYNC_REASON]);
    }

    // ~/Library/CloudStorage/* stays dangerous because of ~/Library while also recording cloud-sync.
    const cloudStorage = classifyEntry(
      entry(
        "/home/dev/Library/CloudStorage/GoogleDrive-me/proj/node_modules",
        "node_modules",
        "directory",
      ),
      home,
    );
    expect(cloudStorage.riskTier).toBe("dangerous");
    expect(cloudStorage.reasons).toEqual(["default-pattern", "tool-home", CLOUD_SYNC_REASON]);
  });
});

describe("project identity files are never candidates", () => {
  test.each(["src", "package.json", "Cargo.toml", ".env", ".env.production", ".sweeprc"])(
    "%s matched by a custom pattern is blocked",
    (name) => {
      const path = dir("repo", name);
      const result = classifyEntry(entry(path, name, "directory"));
      expect(result.riskTier).toBe("blocked");
      expect(result.reasons).toContain("protected-project-file");
      expect(toCandidate(entry(path, name, "directory")).selectedByDefault).toBe(false);
    },
  );

  test("artifact names that merely look similar stay classifiable", () => {
    const path = dir("repo", ".envrc-cache");
    expect(classifyEntry(entry(path, ".envrc-cache", "directory")).riskTier).not.toBe("blocked");
  });
});
