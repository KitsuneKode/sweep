/** State derivation benchmark; excludes React/OpenTUI rendering. */
import { cpus } from "node:os";
import {
  DEFAULT_SELECTION_POLICY,
  type ScanCandidate,
  type ScanPlan,
} from "@kitsunekode/sweep-protocol";
import {
  createUiState,
  moveCursor,
  toggleSelectionById,
  getUiSummary,
  countSelectedDangerous,
} from "../src/state.js";
import { buildDisplayRows } from "../src/rows.js";
import { buildScopeSidebarRows } from "../src/sidebar.js";

const quantile = (values: number[], p: number) =>
  values.slice().sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!;
const rows: Array<Record<string, unknown>> = [];
for (const n of [1000, 10000, 50000]) {
  const candidates = Array.from(
    { length: n },
    (_, i): ScanCandidate => ({
      id: `cand_${i}`,
      path: `/tmp/sweep-benchmark/projects/pkg_${Math.floor(i / 10)}/cache_${i}`,
      name: `cache_${i}`,
      kind: "custom",
      estimatedBytes: (n - i) * 1024,
      isSymlink: false,
      entryType: "directory",
      riskTier: "safe",
      reasons: ["default-pattern"],
      selectedByDefault: true,
    }),
  );
  const plan: ScanPlan = {
    protocolVersion: "1",
    targetDir: "/tmp/sweep-benchmark",
    selectionPolicy: DEFAULT_SELECTION_POLICY,
    candidates,
    selectedCandidateIds: candidates.map((c) => c.id),
    summary: {
      candidateCount: n,
      estimatedTotalBytes: candidates.reduce((s, c) => s + c.estimatedBytes, 0),
      scannedDirs: n,
      skippedDirs: 0,
      exact: false,
      selectedCount: n,
      riskCounts: { safe: n, caution: 0, dangerous: 0, blocked: 0 },
    },
    createdAt: new Date().toISOString(),
  };
  let state = createUiState(plan);
  const derive = () => {
    getUiSummary(state);
    countSelectedDangerous(state);
    buildDisplayRows(state);
    buildScopeSidebarRows(
      state.targetDir,
      state.candidates,
      state.selectedIds,
      state.expandedScopes,
    );
  };
  derive();
  const sample = (kind: string, change: () => void) => {
    const raw: number[] = [];
    for (let i = 0; i < 35; i++) {
      const started = performance.now();
      change();
      derive();
      const elapsed = performance.now() - started;
      if (i >= 5) raw.push(elapsed);
    }
    rows.push({
      n,
      kind,
      samples: raw.length,
      p50Ms: quantile(raw, 0.5),
      p95Ms: quantile(raw, 0.95),
      maxMs: Math.max(...raw),
      raw,
    });
  };
  sample("cursor", () => {
    state = moveCursor(state, 1);
  });
  sample("selection", () => {
    state = toggleSelectionById(state, "cand_1");
  });
}
process.stdout.write(
  JSON.stringify(
    {
      date: new Date().toISOString(),
      runtime: Bun.version,
      cpu: cpus()[0]?.model,
      method:
        "30 samples after five warmups; state change, summary, dangerous count, display rows and sidebar. Excludes rendering. Synthetic local state, no filesystem writes.",
      rows,
    },
    null,
    2,
  ) + "\n",
);
