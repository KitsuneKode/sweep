import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidWidgetEvent, isValidWidgetSnapshot } from "@kitsunekode/sweep-core/widget";
import type { WidgetEvent, WidgetSnapshot } from "@kitsunekode/sweep-protocol";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SWEEP = join(REPO_ROOT, "apps/cli/dist/sweep.js");
const LOCAL_RUST_ENGINE = join(
  REPO_ROOT,
  "target",
  "debug",
  process.platform === "win32" ? "sweep-engine.exe" : "sweep-engine",
);
const NATIVE_CLI_AVAILABLE = existsSync(LOCAL_RUST_ENGINE);

const validateSnapshot = isValidWidgetSnapshot;
const validateEvent = isValidWidgetEvent;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sweep-widget-cli-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const dir = (...parts: string[]) => join(tmpDir, ...parts);

function runCli(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync({
    cmd: ["bun", SWEEP, ...args],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SWEEP_CONFIG_DIR: dir("test-config"),
      XDG_CONFIG_HOME: dir("test-xdg-config"),
      XDG_CACHE_HOME: dir("test-xdg-cache"),
      XDG_STATE_HOME: dir("test-xdg-state"),
      ...env,
    },
  });

  return {
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
    exitCode: proc.exitCode,
  };
}

function seedProjectsTree(root: string): { idleApp: string; activeApp: string } {
  const idleApp = join(root, "idle-app");
  const activeApp = join(root, "active-app");

  mkdirSync(join(idleApp, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(idleApp, ".turbo"), { recursive: true });
  writeFileSync(join(idleApp, "package.json"), '{"name":"idle-app"}\n');
  writeFileSync(join(idleApp, "node_modules", "pkg", "index.js"), "x".repeat(4096));
  writeFileSync(join(idleApp, ".turbo", "cache.bin"), "y".repeat(1024));

  // Backdate idle-app files/dir by 45 days so project-activity detects it as idle.
  const oldTime = new Date(Date.now() - 45 * 86_400_000);
  utimesSync(join(idleApp, "package.json"), oldTime, oldTime);
  utimesSync(idleApp, oldTime, oldTime);

  mkdirSync(join(activeApp, ".next"), { recursive: true });
  mkdirSync(join(activeApp, "dist"), { recursive: true });
  writeFileSync(join(activeApp, "package.json"), '{"name":"active-app"}\n');
  writeFileSync(join(activeApp, ".next", "build.js"), "z".repeat(2048));
  // Opt-in dangerous candidate (`dist`) when requested via -p dist
  writeFileSync(join(activeApp, "dist", "bundle.js"), "w".repeat(8192));

  return { idleApp, activeApp };
}

describe("CLI sweep widget", () => {
  const engines = NATIVE_CLI_AVAILABLE ? (["js", "rust"] as const) : (["js"] as const);

  for (const engine of engines) {
    test(`widget --json (${engine} engine): emits bounded read-only snapshot, separates guarded bytes, and never deletes`, () => {
      const workspace = dir("workspace");
      const { idleApp } = seedProjectsTree(workspace);
      const engineEnv = engine === "rust" ? { SWEEP_ENGINE_PATH: LOCAL_RUST_ENGINE } : {};

      const res = runCli(
        ["widget", workspace, "--json", "--engine", engine, "-p", "dist"],
        engineEnv,
      );
      expect(res.exitCode).toBe(0);

      const snapshot = JSON.parse(res.stdout) as WidgetSnapshot;
      expect(validateSnapshot(snapshot)).toBe(true);
      expect(snapshot.widgetSchemaVersion).toBe(1);
      expect(snapshot.readOnly).toBe(true);
      expect(snapshot.source).toBe("live");
      expect(snapshot.state).toBe("ok");
      expect(snapshot.stale).toBe(false);
      expect(snapshot.ageMs).toBe(0);
      expect(snapshot.error).toBeNull();
      expect(snapshot.space).toBeNull();
      expect(snapshot.projectsSummary).not.toBeNull();

      const summary = snapshot.projectsSummary!;
      expect(summary.reclaimableBytes).toBe(summary.safeBytes + summary.cautionBytes);
      expect(summary.reclaimableBytes).toBeGreaterThanOrEqual(7168);
      // `dist` is an opt-in dangerous candidate -> must be guarded, never added to reclaimableBytes
      expect(summary.protectedCount).toBe(1);
      expect(summary.guardedBytes).toBeGreaterThanOrEqual(8192);
      expect(summary.byCost.reduce((s, b) => s + b.bytes, 0)).toBe(summary.reclaimableBytes);
      expect(summary.topKinds.length).toBeGreaterThan(0);
      expect(summary.topKinds.some((k) => k.kind === "dist")).toBe(false);
      expect(summary.idle.projects).toBeGreaterThanOrEqual(1);
      expect(summary.idle.bytes).toBeGreaterThan(0);

      // Strictly read-only: artifacts remain untouched on disk.
      expect(existsSync(join(idleApp, "node_modules", "pkg", "index.js"))).toBe(true);
      expect(existsSync(join(idleApp, ".turbo", "cache.bin"))).toBe(true);

      // Guardrail: sweep apply --plan must unconditionally refuse a widget snapshot.
      const snapFile = dir("widget-snapshot.json");
      writeFileSync(snapFile, res.stdout);
      const applyRes = runCli(["apply", "--plan", snapFile, "--dry-run", "--json"]);
      expect(applyRes.exitCode).toBe(3);
    });
  }

  test("--cache-only returns empty stale state before scanning, then serves cached summary without re-scanning", () => {
    const workspace = dir("cached-workspace");
    seedProjectsTree(workspace);

    // Before any scan: --cache-only exits 0 with projectsSummary: null, stale: true, state: "stale"
    const before = runCli(["widget", workspace, "--cache-only", "--json"]);
    expect(before.exitCode).toBe(0);
    const beforeSnap = JSON.parse(before.stdout) as WidgetSnapshot;
    expect(validateSnapshot(beforeSnap)).toBe(true);
    expect(beforeSnap.source).toBe("cache");
    expect(beforeSnap.stale).toBe(true);
    expect(beforeSnap.state).toBe("stale");
    expect(beforeSnap.projectsSummary).toBeNull();

    // Live scan populates L4 cache
    const live = runCli(["widget", workspace, "--json", "--engine", "js"]);
    expect(live.exitCode).toBe(0);
    const liveSnap = JSON.parse(live.stdout) as WidgetSnapshot;
    expect(liveSnap.source).toBe("live");
    expect(liveSnap.projectsSummary?.reclaimableBytes).toBeGreaterThan(0);

    // Delete artifacts on disk to prove --cache-only does NOT rescan
    rmSync(join(workspace, "idle-app", "node_modules"), { recursive: true, force: true });

    const cached = runCli(["widget", workspace, "--cache-only", "--json"]);
    expect(cached.exitCode).toBe(0);
    const cachedSnap = JSON.parse(cached.stdout) as WidgetSnapshot;
    expect(validateSnapshot(cachedSnap)).toBe(true);
    expect(cachedSnap.source).toBe("cache");
    expect(cachedSnap.stale).toBe(false);
    expect(cachedSnap.state).toBe("ok");
    expect(cachedSnap.ageMs).toBeGreaterThanOrEqual(0);
    expect(cachedSnap.projectsSummary?.reclaimableBytes).toBe(
      liveSnap.projectsSummary?.reclaimableBytes,
    );

    // --stale-after 0s marks the cached snapshot stale
    const stale = runCli(["widget", workspace, "--cache-only", "--stale-after", "0s", "--json"]);
    expect(stale.exitCode).toBe(0);
    const staleSnap = JSON.parse(stale.stdout) as WidgetSnapshot;
    expect(staleSnap.stale).toBe(true);
    expect(staleSnap.state).toBe("stale");
  });

  test("--json-stream emits valid NDJSON widget_started and widget_snapshot events", () => {
    const workspace = dir("stream-workspace");
    seedProjectsTree(workspace);

    const res = runCli(["widget", workspace, "--json-stream", "--engine", "js"]);
    expect(res.exitCode).toBe(0);

    const lines = res.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const events = lines.map((line) => JSON.parse(line) as WidgetEvent);
    for (const ev of events) {
      expect(validateEvent(ev)).toBe(true);
    }
    expect(events[0]?.type).toBe("widget_started");
    expect(events.at(-1)?.type).toBe("widget_snapshot");
  });

  test("respects existing guardrails (refuses ~ and /) and rejects invalid widget flags with exit code 2", () => {
    const homeRes = runCli(["widget", homedir(), "--json"]);
    expect(homeRes.exitCode).toBe(2);

    const rootRes = runCli(["widget", "/", "--json"]);
    expect(rootRes.exitCode).toBe(2);

    const badView = runCli(["widget", tmpDir, "--view", "space", "--json"]);
    expect(badView.exitCode).toBe(2);

    const conflictCache = runCli(["widget", tmpDir, "--cache-only", "--refresh", "--json"]);
    expect(conflictCache.exitCode).toBe(2);

    const conflictStream = runCli(["widget", tmpDir, "--json", "--json-stream"]);
    expect(conflictStream.exitCode).toBe(2);

    const zeroTimeout = runCli(["widget", tmpDir, "--timeout", "0s", "--json"]);
    expect(zeroTimeout.exitCode).toBe(2);
  });

  test("emits structured widget errors for missing target, unavailable rust engine, and unreadable folder", () => {
    const missingRes = runCli(["widget", dir("does-not-exist"), "--json"]);
    expect(missingRes.exitCode).toBe(2);
    const missingSnap = JSON.parse(missingRes.stdout) as WidgetSnapshot;
    expect(validateSnapshot(missingSnap)).toBe(true);
    expect(missingSnap.state).toBe("error");
    expect(missingSnap.error?.code).toBe("target_missing");

    const workspace = dir("engine-workspace");
    mkdirSync(workspace, { recursive: true });
    const missingEngine = runCli(["widget", workspace, "--json", "--engine", "rust"], {
      SWEEP_ENGINE_PATH: dir("no-such-engine"),
    });
    expect(missingEngine.exitCode).toBe(4);
    const engineSnap = JSON.parse(missingEngine.stdout) as WidgetSnapshot;
    expect(validateSnapshot(engineSnap)).toBe(true);
    expect(engineSnap.state).toBe("error");
    expect(engineSnap.error?.code).toBe("engine_missing");
    expect(engineSnap.error?.fallbackAvailable).toBe(true);

    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = dir("locked-workspace");
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);
      try {
        const permRes = runCli(["widget", locked, "--json"]);
        expect(permRes.exitCode).toBe(2);
        const permSnap = JSON.parse(permRes.stdout) as WidgetSnapshot;
        expect(validateSnapshot(permSnap)).toBe(true);
        expect(permSnap.state).toBe("error");
        expect(permSnap.error?.code).toBe("permission_denied");
      } finally {
        chmodSync(locked, 0o755);
      }
    }
  });

  test("sweep schema exports widgetSnapshot, widgetEvent, and widgetCache schemas", () => {
    const res = runCli(["schema"]);
    expect(res.exitCode).toBe(0);
    const doc = JSON.parse(res.stdout) as {
      protocolVersion: string;
      schemas: Record<string, { title?: string }>;
    };
    expect(doc.protocolVersion).toBe("1");
    expect(doc.schemas.widgetSnapshot?.title).toBe("WidgetSnapshot");
    expect(doc.schemas.widgetEvent?.title).toBe("WidgetEvent");
    expect(doc.schemas.widgetCache?.title).toBe("WidgetCacheEnvelope");
  });
});
