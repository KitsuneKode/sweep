import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, applyPlanWithBackend, scanToPlan } from "./engine.js";
import { isRustEngineAvailable, resolveRustEngineBinary } from "./rust-engine.js";
import { DEFAULT_CONFIG } from "./config.js";
import { loadPlan } from "./plan.js";
import { readFilesystemIdentity } from "./filesystem-identity.js";
import { cleanupSeededFixtures, seedScenario } from "@kitsunekode/sweep-test-fixtures";

const NATIVE_AVAILABLE = isRustEngineAvailable();
if (process.env.SWEEP_REQUIRE_RUST_TESTS === "1" && !NATIVE_AVAILABLE) {
  throw new Error("Native coverage is required, but no usable Rust test engine is available");
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sweep-engine-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  cleanupSeededFixtures();
});

const dir = (...parts: string[]) => join(tmpDir, ...parts);

test.skipIf(process.platform !== "linux" || !NATIVE_AVAILABLE)(
  "rust: active artifact removal activity reaches the host without changing outcome accounting",
  async () => {
    mkdirSync(dir("node_modules", "nested"), { recursive: true });
    for (let i = 0; i < 1000; i++) writeFileSync(dir("node_modules", "nested", `${i}`), "x");
    writeFileSync(dir("keep"), "keep");
    const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
    const counts: number[] = [];
    const result = await applyPlanWithBackend(plan, "rust", {
      onActivity: (entry, n) => {
        expect(entry.path).toBe(dir("node_modules"));
        counts.push(n);
      },
    });
    expect(counts.length).toBeGreaterThan(0);
    expect(counts[0]).toBe(1);
    expect(counts.every((n, i) => i === 0 || n > counts[i - 1]!)).toBe(true);
    expect(result.cleanResult.deleted.length).toBe(1);
    expect(existsSync(dir("node_modules"))).toBe(false);
    expect(readFileSync(dir("keep"), "utf8")).toBe("keep");
  },
);

for (const shape of ["before-begin", "regression", "unsafe-number", "after-deleted"] as const) {
  test.skipIf(process.platform === "win32")(
    `rust: refuses malformed removal activity (${shape})`,
    async () => {
      const { chmodSync } = await import("node:fs");
      mkdirSync(dir("node_modules"));
      const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
      const id = plan.selectedCandidateIds[0]!;
      const events = [
        ...(shape === "before-begin" ? [] : [{ type: "apply_begin", candidateId: id }]),
        ...(shape === "after-deleted" ? [{ type: "apply_deleted", candidateId: id }] : []),
        {
          type: "apply_activity",
          candidateId: id,
          removedEntries: shape === "unsafe-number" ? Number.MAX_SAFE_INTEGER + 1 : 2,
        },
        ...(shape === "regression"
          ? [{ type: "apply_activity", candidateId: id, removedEntries: 1 }]
          : []),
      ];
      const binary = dir("activity-engine");
      writeFileSync(
        binary,
        `#!/usr/bin/env bun
if (process.argv[2] === "--capabilities") {
  process.stdout.write('{"applyControl":true,"planIdentity":true,"applyActivity":true}\\n');
} else {
  process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n") + "\n")});
}
`,
      );
      chmodSync(binary, 0o700);
      const previous = process.env.SWEEP_ENGINE_PATH;
      process.env.SWEEP_ENGINE_PATH = binary;
      try {
        await expect(applyPlanWithBackend(plan, "rust", { onActivity() {} })).rejects.toThrow(
          /removal activity|Outcomes are unknown/,
        );
        expect(existsSync(dir("node_modules"))).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.SWEEP_ENGINE_PATH;
        else process.env.SWEEP_ENGINE_PATH = previous;
      }
    },
  );
}

for (const backend of ["js", "rust"] as const) {
  test.skipIf(process.platform === "win32")(
    `${backend}: covered alias receipts survive parent removal`,
    async () => {
      mkdirSync(dir("node_modules", "pkg"), { recursive: true });
      symlinkSync(dir("node_modules"), dir("alias"));
      const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
      const parent = plan.candidates.find((c) => c.name === "node_modules")!;
      const child = {
        ...parent,
        path: dir("alias", "pkg"),
        name: "pkg",
        id: "alias-child",
        identity: readFilesystemIdentity(dir("alias", "pkg")),
      };
      plan.candidates.push(child);
      plan.selectedCandidateIds.push(child.id);
      const applied = await applyPlanWithBackend(plan, backend);
      expect(applied.report.deletedCount).toBe(1);
      expect(applied.report.failedCount).toBe(0);
      expect(applied.report.outcomes).toEqual([
        { candidateId: parent.id, status: "deleted" },
        { candidateId: child.id, status: "covered", coveredBy: parent.id },
      ]);
      expect(applied.interrupted).toBe(false);
      expect(existsSync(dir("node_modules"))).toBe(false);
    },
  );
}

describe("core engine", () => {
  for (const backend of ["js", "rust"] as const) {
    test(`legacy plans without snapshots cannot authorize ${backend} deletion`, async () => {
      mkdirSync(dir("node_modules"));
      const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
      const withoutRoot = { ...plan };
      delete withoutRoot.targetIdentity;
      const saved = dir("legacy-plan.json");
      writeFileSync(saved, JSON.stringify(withoutRoot));
      const loaded = loadPlan(saved);
      expect(loaded.targetIdentity).toBeUndefined();
      await expect(applyPlanWithBackend(loaded, backend)).rejects.toThrow("root identity");
      const candidate = plan.candidates[0]!;
      delete candidate.identity;
      const applied = await applyPlanWithBackend(plan, backend);
      expect(applied.report.deletedCount).toBe(0);
      expect(applied.report.failedCount).toBe(1);
      expect(applied.report.failedPaths[0]?.error).toContain("identity");
      expect(existsSync(dir("node_modules"))).toBe(true);
    });

    test(`saved plans preserve same-type replacements before ${backend} apply`, async () => {
      const root = dir("project");
      const artifact = join(root, "node_modules");
      mkdirSync(artifact, { recursive: true });
      const { plan } = await scanToPlan(root, DEFAULT_CONFIG);
      const saved = dir("plan.json");
      writeFileSync(saved, JSON.stringify(plan));
      renameSync(artifact, join(root, "original"));
      mkdirSync(artifact);
      writeFileSync(join(artifact, "keep"), "replacement");
      const applied = await applyPlanWithBackend(loadPlan(saved), backend);
      expect(applied.report.deletedCount).toBe(0);
      expect(applied.report.failedCount).toBe(1);
      expect(applied.report.failedPaths[0]?.error).toContain("identity");
      expect(readFileSync(join(artifact, "keep"), "utf8")).toBe("replacement");
      expect(existsSync(join(root, "original"))).toBe(true);
    });

    test(`saved plans refuse a root replaced before ${backend} apply`, async () => {
      const root = dir("project");
      mkdirSync(join(root, "node_modules"), { recursive: true });
      const { plan } = await scanToPlan(root, DEFAULT_CONFIG);
      const saved = dir("plan.json");
      writeFileSync(saved, JSON.stringify(plan));
      renameSync(root, dir("original-project"));
      mkdirSync(join(root, "node_modules"), { recursive: true });
      writeFileSync(join(root, "node_modules", "keep"), "replacement");
      await expect(applyPlanWithBackend(loadPlan(saved), backend)).rejects.toThrow(
        /root.*changed/i,
      );
      expect(readFileSync(join(root, "node_modules", "keep"), "utf8")).toBe("replacement");
      expect(existsSync(dir("original-project", "node_modules"))).toBe(true);
    });
  }

  test("scanToPlan returns both scan summary and a selected plan", async () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir(".vite"));

    const { result, plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);

    expect(result.entries).toHaveLength(2);
    expect(plan.candidates).toHaveLength(2);
    expect(plan.summary.candidateCount).toBe(2);
    expect(plan.summary.selectedCount).toBe(2);
  });

  test("applyPlan merges revalidation failures into the final report", async () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir(".vite"));

    const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);

    rmSync(dir("node_modules"), { recursive: true, force: true });
    writeFileSync(dir("node_modules"), "drifted into a file");

    const applied = await applyPlan(plan);

    expect(applied.report.deletedCount).toBe(1);
    expect(applied.report.failedCount).toBe(1);
    expect(applied.report.failedPaths[0]?.path).toBe(dir("node_modules"));
    expect(applied.cleanResult.deleted).toHaveLength(1);
  });

  test("scanToPlan honors explicit selection policy", async () => {
    mkdirSync(dir("custom-cache"));

    const { plan } = await scanToPlan(
      tmpDir,
      {
        ...DEFAULT_CONFIG,
        patterns: [...DEFAULT_CONFIG.patterns, "custom-cache"],
      },
      {
        selectionPolicy: { mode: "all", includeDangerous: true },
      },
    );

    expect(plan.candidates).toHaveLength(1);
    expect(plan.selectedCandidateIds).toHaveLength(1);
    expect(plan.selectionPolicy).toEqual({
      mode: "all",
      includeDangerous: true,
    });
  });

  test("applyPlan reports missing candidates with a stable failure code", async () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir(".vite"));

    const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);

    rmSync(dir(".vite"), { recursive: true, force: true });

    const applied = await applyPlan(plan);

    expect(applied.report.failedCount).toBe(1);
    expect(applied.report.failedPaths[0]?.code).toBe("missing");
    expect(applied.report.failedPaths[0]?.path).toBe(dir(".vite"));
  });

  test("applyPlan stops scheduling deletions once cancelled", async () => {
    // More candidates than the pool's concurrency (4) - after the first delete
    // resolves, every subsequent pull sees the cancellation and skips work.
    const names = [
      "node_modules",
      ".next",
      ".turbo",
      ".parcel-cache",
      ".nuxt",
      ".vite",
      ".nyc_output",
      ".svelte-kit",
      "target",
      "x.tsbuildinfo",
    ];
    for (const name of names) {
      mkdirSync(dir(name));
    }

    const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
    expect(plan.selectedCandidateIds.length).toBe(names.length);

    let deleted = 0;
    const applied = await applyPlan(plan, {
      onDeleted: () => {
        deleted += 1;
      },
      isCancelled: () => deleted > 0,
    });

    expect(applied.interrupted).toBe(true);
    // At most the initial pool batch can have been attempted.
    expect(applied.report.deletedCount + applied.report.failedCount).toBeLessThanOrEqual(4);
    // Cancelled work is never attempted - most directories survive.
    const remaining = names.filter((name) => existsSync(dir(name)));
    expect(remaining.length).toBeGreaterThanOrEqual(names.length - 4);
  });

  test("scanToPlan preserves a mixed workspace scenario as a stable plan shape", async () => {
    mkdirSync(dir("packages", "web", "node_modules"), { recursive: true });
    mkdirSync(dir("packages", "api", "target"), { recursive: true });
    mkdirSync(dir("apps", "docs", ".next"), { recursive: true });
    mkdirSync(dir("apps", "docs", "custom-cache"), { recursive: true });

    const { plan } = await scanToPlan(
      tmpDir,
      {
        ...DEFAULT_CONFIG,
        patterns: [...DEFAULT_CONFIG.patterns, "custom-cache"],
      },
      {
        selectionPolicy: { mode: "default", includeDangerous: false },
      },
    );

    expect(plan.summary.candidateCount).toBe(4);
    expect(plan.summary.selectedCount).toBe(3);
    expect(plan.summary.riskCounts.safe).toBe(3);
    expect(plan.summary.riskCounts.dangerous).toBe(1);
  });

  test("applyPlan rejects a plan carrying a foreign protocol version", async () => {
    // A plan file is untrusted input - interpreting a future/past schema with
    // this engine's semantics is how silent misdeletes happen.
    mkdirSync(dir("node_modules"));
    const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
    const foreign = { ...plan, protocolVersion: "999" as "1" };

    await expect(applyPlan(foreign)).rejects.toThrow(/protocol version/);
    expect(existsSync(dir("node_modules"))).toBe(true);
  });

  test("applyPlan collapses a nested child into its parent delete", async () => {
    // A forged or stale plan can name both a directory and something inside
    // it; the child delete must fold into the parent - one attempt, no phantom
    // "missing" failure, and interrupted compares against the real work set.
    mkdirSync(dir("node_modules", "pkg"), { recursive: true });
    const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
    const parent = plan.candidates.find((c) => c.name === "node_modules")!;
    const child = {
      ...parent,
      id: "cand_nested",
      path: dir("node_modules", "pkg"),
      identity: readFilesystemIdentity(dir("node_modules", "pkg")),
      name: "pkg",
    };
    const forged = {
      ...plan,
      candidates: [...plan.candidates, child],
      selectedCandidateIds: [...plan.selectedCandidateIds, "cand_nested"],
    };

    const applied = await applyPlan(forged);
    expect(applied.report.deletedCount).toBe(1);
    expect(applied.report.failedCount).toBe(0);
    expect(applied.interrupted).toBe(false);
    expect(existsSync(dir("node_modules"))).toBe(false);
  });

  test("applyPlan fails outside-target paths per entry without aborting", async () => {
    // Forged entries become per-path report failures (matching the Rust
    // engine); legitimate selected candidates still apply, and nothing
    // outside the target is ever touched.
    mkdirSync(dir("node_modules"));

    const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
    const outsidePath = join("/tmp", "sweep-outside-target");
    const malicious = {
      ...plan,
      candidates: [
        ...plan.candidates,
        {
          ...plan.candidates[0]!,
          id: "cand_outside",
          path: outsidePath,
        },
      ],
      selectedCandidateIds: [...plan.selectedCandidateIds, "cand_outside"],
    };

    const { report } = await applyPlan(malicious);
    expect(report.failedPaths).toContainEqual(
      expect.objectContaining({ path: outsidePath, code: "outside_target" }),
    );
    expect(existsSync(outsidePath)).toBe(false);
    expect(existsSync(dir("node_modules"))).toBe(false);
  });

  test.skipIf(
    process.env.SWEEP_ENGINE_FROM_NPM === "1" ||
      !NATIVE_AVAILABLE ||
      !existsSync(resolveRustEngineBinary()),
  )("applyPlanWithBackend rust reports outside-target paths per entry", async () => {
    mkdirSync(dir("node_modules"));
    const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
    const outsidePath = join("/tmp", "sweep-rust-outside-target");
    const malicious = {
      ...plan,
      candidates: [
        ...plan.candidates,
        {
          ...plan.candidates[0]!,
          id: "cand_outside",
          path: outsidePath,
        },
      ],
      selectedCandidateIds: [...plan.selectedCandidateIds, "cand_outside"],
    };

    const { report } = await applyPlanWithBackend(malicious, "rust");
    expect(report.failedPaths).toContainEqual(
      expect.objectContaining({ path: outsidePath, code: "outside_target" }),
    );
    expect(existsSync(outsidePath)).toBe(false);
    expect(existsSync(dir("node_modules"))).toBe(false);
  });

  test("scanToPlan handles the seeded large-plan scenario predictably", async () => {
    const fixture = seedScenario("large-plan");

    const { plan } = await scanToPlan(
      fixture.root,
      {
        ...DEFAULT_CONFIG,
        patterns: [...DEFAULT_CONFIG.patterns, "custom-cache"],
      },
      {
        selectionPolicy: { mode: "default", includeDangerous: false },
      },
    );

    expect(plan.summary.candidateCount).toBeGreaterThan(12);
    expect(plan.summary.riskCounts.dangerous).toBeGreaterThan(0);
    expect(plan.summary.selectedCount).toBeGreaterThan(0);
  });
});

for (const backend of ["js", "rust"] as const) {
  test.skipIf(backend === "rust" && !NATIVE_AVAILABLE)(
    `${backend}: duplicate paths report only actual deletion operations`,
    async () => {
      mkdirSync(dir("node_modules"));
      const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
      const original = plan.candidates[0]!;
      plan.candidates.push({ ...original, id: "duplicate" });
      plan.selectedCandidateIds.push("duplicate");
      const callbacks: string[] = [];
      const applied = await applyPlanWithBackend(plan, backend, {
        onDeleted: (entry) => callbacks.push(entry.path),
      });
      expect(applied.report.deletedCount).toBe(1);
      expect(applied.cleanResult.deleted).toHaveLength(1);
      expect(callbacks).toHaveLength(1);
    },
  );
  test.skipIf(backend === "rust" && !NATIVE_AVAILABLE)(
    `${backend}: pre-aborted apply does not remove anything`,
    async () => {
      mkdirSync(dir("node_modules"));
      const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
      const applied = await applyPlanWithBackend(plan, backend, { signal: AbortSignal.abort() });
      expect(existsSync(dir("node_modules"))).toBe(true);
      expect(applied.report.deletedCount).toBe(0);
      expect(applied.interrupted).toBe(true);
    },
  );
}

for (const backend of ["js", "rust"] as const) {
  test.skipIf(backend === "rust" && !NATIVE_AVAILABLE)(
    `${backend}: changed sizes cannot bypass the configured apply ceiling`,
    async () => {
      mkdirSync(dir("node_modules"));
      const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
      writeFileSync(dir("node_modules", "grown"), Buffer.alloc(2048));
      await expect(
        applyPlanWithBackend(plan, backend, { maxSizeGB: 1024 / 1024 ** 3 }),
      ).rejects.toThrow();
      expect(existsSync(dir("node_modules", "grown"))).toBe(true);
      const applied = await applyPlanWithBackend(plan, backend, {
        maxSizeGB: 1024 / 1024 ** 3,
        forceLarge: true,
      });
      expect(applied.report.deletedCount).toBe(1);
    },
  );
}

test.skipIf(!NATIVE_AVAILABLE)(
  "rust: live cancellation drains actual outcomes and deletion callbacks",
  async () => {
    for (const name of ["a", "b", "c", "d"]) {
      mkdirSync(dir(name, "node_modules"), { recursive: true });
      if (name === "b")
        for (let i = 0; i < 4096; i++) writeFileSync(dir(name, "node_modules", `${i}`), "x");
    }
    const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
    const cancel = new AbortController();
    const deleted: string[] = [];
    const applied = await applyPlanWithBackend(plan, "rust", {
      signal: cancel.signal,
      onDeleted: (entry) => {
        deleted.push(entry.path);
        cancel.abort();
      },
    });
    expect(applied.interrupted).toBe(true);
    expect(applied.report.deletedCount).toBeGreaterThanOrEqual(1);
    expect(applied.report.deletedCount).toBeLessThan(4);
    expect(applied.report.deletedCount).toBe(deleted.length);
    expect(applied.report.outcomes).toHaveLength(4);
    for (const candidate of plan.candidates) {
      const outcome = applied.report.outcomes!.find((item) => item.candidateId === candidate.id)!;
      expect(existsSync(candidate.path)).toBe(outcome.status !== "deleted");
    }
  },
);

for (const backend of ["js", "rust"] as const) {
  test.skipIf(backend === "rust" && !NATIVE_AVAILABLE)(
    `${backend}: outcome IDs survive conflicting types on duplicate paths`,
    async () => {
      mkdirSync(dir("node_modules"));
      const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
      const original = plan.candidates[0]!;
      plan.candidates.push({ ...original, id: "valid" });
      plan.selectedCandidateIds.push("valid");
      original.entryType = "file";
      const applied = await applyPlanWithBackend(plan, backend);
      expect(applied.report.deletedCount).toBe(1);
      expect(applied.report.failedCount).toBe(1);
      expect(applied.report.outcomes).toEqual([
        { candidateId: original.id, status: "failed" },
        { candidateId: "valid", status: "deleted" },
      ]);
    },
  );
}

test.skipIf(process.platform === "win32")(
  "rust: an older engine cannot silently omit identity enforcement",
  async () => {
    const { chmodSync } = await import("node:fs");
    mkdirSync(dir("node_modules"));
    const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
    const binary = dir("old-engine");
    const started = dir("started");
    writeFileSync(
      binary,
      `#!/usr/bin/env bun
import {writeFileSync} from "node:fs";
if (process.argv[2] === "--capabilities") {
  process.stdout.write(JSON.stringify({applyControl:true}));
} else {
  writeFileSync(${JSON.stringify(started)}, "unsafe apply started");
}
`,
    );
    chmodSync(binary, 0o700);
    const previous = process.env.SWEEP_ENGINE_PATH;
    process.env.SWEEP_ENGINE_PATH = binary;
    try {
      await expect(applyPlanWithBackend(plan, "rust")).rejects.toThrow("saved-plan identity");
      expect(existsSync(started)).toBe(false);
      expect(existsSync(dir("node_modules"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SWEEP_ENGINE_PATH;
      else process.env.SWEEP_ENGINE_PATH = previous;
    }
  },
);

test.skipIf(!NATIVE_AVAILABLE)(
  "rust: closed initial control channel cannot start deletion",
  async () => {
    const { spawnSync } = await import("node:child_process");
    mkdirSync(dir("node_modules"));
    const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
    const result = spawnSync(resolveRustEngineBinary(), ["apply", "--json-control"], {
      input: `${JSON.stringify({ plan })}\n`,
      timeout: 5000,
    });
    expect(result.status).toBe(3);
    expect(existsSync(dir("node_modules"))).toBe(true);
  },
);

for (const failure of ["exit", "bad-report"] as const) {
  test.skipIf(process.platform === "win32")(
    `rust: ${failure} after apply starts reports unknown outcomes`,
    async () => {
      const { chmodSync } = await import("node:fs");
      mkdirSync(dir("node_modules"));
      const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
      const binary = dir("failed-engine");
      writeFileSync(
        binary,
        `#!/usr/bin/env bun
if (process.argv[2] === "--capabilities") {
  process.stdout.write('{"applyControl":true,"planIdentity":true}\\n');
  process.exit(0);
}
process.stdout.write(${JSON.stringify(JSON.stringify({ type: "apply_begin", candidateId: plan.selectedCandidateIds[0] }) + "\n")});
${failure === "exit" ? "process.exit(4);" : "process.stdout.write('invalid JSON\\n'); process.exit(0);"}
`,
      );
      chmodSync(binary, 0o700);
      const previous = process.env.SWEEP_ENGINE_PATH;
      process.env.SWEEP_ENGINE_PATH = binary;
      try {
        await expect(applyPlanWithBackend(plan, "rust")).rejects.toThrow(/Outcomes are unknown/);
        expect(existsSync(dir("node_modules"))).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.SWEEP_ENGINE_PATH;
        else process.env.SWEEP_ENGINE_PATH = previous;
      }
    },
  );
}

test.skipIf(process.platform === "win32")(
  "rust: stuck cancellation reports unknown outcomes without retrying",
  async () => {
    const { chmodSync } = await import("node:fs");
    mkdirSync(dir("node_modules"));
    const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
    const binary = dir("stuck-engine");
    writeFileSync(
      binary,
      `#!/usr/bin/env bun
if (process.argv[2] === "--capabilities") {
  process.stdout.write('{"applyControl":true,"planIdentity":true}\\n');
  process.exit(0);
}
setInterval(() => {}, 1000);
let data = "";
let announced = false;
process.stdin.on("data", chunk => {
  data += chunk.toString();
  if (!announced && data.includes("\\n")) {
    announced = true;
    const request = JSON.parse(data.slice(0, data.indexOf("\\n")));
    process.stdout.write(JSON.stringify({type:"apply_begin",candidateId:request.plan.selectedCandidateIds[0]}) + "\\n");
  }
});
`,
    );
    chmodSync(binary, 0o700);
    const previous = process.env.SWEEP_ENGINE_PATH;
    const cancel = new AbortController();
    process.env.SWEEP_ENGINE_PATH = binary;
    try {
      await expect(
        applyPlanWithBackend(plan, "rust", {
          signal: cancel.signal,
          onBegin: () => cancel.abort(),
        }),
      ).rejects.toThrow(/Outcomes are unknown/);
      expect(existsSync(dir("node_modules"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SWEEP_ENGINE_PATH;
      else process.env.SWEEP_ENGINE_PATH = previous;
    }
  },
  35_000,
);

test.skipIf(process.platform === "win32")(
  "rust: foreground SIGINT reaches the host without killing its apply child",
  async () => {
    const { spawn } = await import("node:child_process");
    for (const name of ["a", "b", "c"]) {
      mkdirSync(dir(name, "node_modules"), { recursive: true });
      if (name === "b")
        for (let i = 0; i < 4096; i++) writeFileSync(dir(name, "node_modules", `${i}`), "x");
    }
    const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);
    const helper = dir("signal-host.ts");
    const engineModule = new URL("./engine.ts", import.meta.url).pathname;
    writeFileSync(
      helper,
      `import { applyPlanWithBackend } from ${JSON.stringify(engineModule)};
const plan = ${JSON.stringify(plan)};
const control = new AbortController();
process.once("SIGINT", () => control.abort());
let sent = false;
const deleted = [];
const result = await applyPlanWithBackend(plan, "rust", {
  signal: control.signal,
  onBegin: () => { if (!sent) { sent = true; process.kill(-process.pid, "SIGINT"); } },
  onDeleted: entry => deleted.push(entry.path),
});
console.log(JSON.stringify({report: result.report, deleted}));
`,
    );
    const child = spawn(process.execPath, [helper], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SWEEP_ENGINE_PATH: resolveRustEngineBinary() },
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
    let code;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(watchdog);
    }
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const result = JSON.parse(stdout) as {
      report: import("@kitsunekode/sweep-protocol").ApplyReport;
      deleted: string[];
    };
    expect(result.report.outcomes).toHaveLength(3);
    expect(result.deleted.length).toBe(result.report.deletedCount);
    expect(plan.candidates.filter((candidate) => !existsSync(candidate.path)).length).toBe(
      result.report.deletedCount,
    );
  },
  // APFS setup + bounded JS enumeration can exceed Bun's default five-second
  // test deadline on a loaded runner. Keep the child watchdog independent.
  30_000,
);

describe("applyPlan input guards", () => {
  test("a non-finite maxSizeGB is rejected instead of silently disabling the ceiling", async () => {
    mkdirSync(dir("node_modules"));
    const { plan } = await scanToPlan(tmpDir, DEFAULT_CONFIG);

    // JSON.stringify(NaN/Infinity) -> null -> the native ceiling check would
    // see "no limit" and skip the preflight entirely. Fail loudly instead.
    await expect(applyPlan(plan, { maxSizeGB: NaN })).rejects.toThrow("maxSizeGB");
    await expect(applyPlan(plan, { maxSizeGB: Infinity })).rejects.toThrow("maxSizeGB");
    expect(existsSync(dir("node_modules"))).toBe(true);
  });
});

for (const backend of ["js", "rust"] as const) {
  test.skipIf(process.platform === "win32")(
    `${backend}: a symlink plan target fails before callbacks or deletion`,
    async () => {
      mkdirSync(dir("project", "node_modules"), { recursive: true });
      const { plan } = await scanToPlan(dir("project"), DEFAULT_CONFIG);
      const link = dir("alias");
      symlinkSync(dir("project"), link);
      plan.targetDir = link;
      plan.targetIdentity = readFilesystemIdentity(link);
      plan.candidates = plan.candidates.map((candidate) => ({
        ...candidate,
        path: join(link, candidate.name),
      }));
      let begins = 0;
      await expect(
        applyPlanWithBackend(plan, backend, {
          onBegin: () => {
            begins++;
          },
        }),
      ).rejects.toThrow();
      expect(begins).toBe(0);
      expect(existsSync(dir("project", "node_modules"))).toBe(true);
    },
  );
}
