/** Repeated UI derivation/rescan cleanup; no rendering or forced GC. */
import {
  createUiState,
  getUiSummary,
  moveCursor,
  clearSelection,
  resetForRescan,
} from "../src/state.js";
import { releaseUiCaches } from "../src/state/store.js";
import { buildDisplayRows } from "../src/rows.js";
import { buildScopeTreeRows } from "../src/scope-tree.js";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";

const rows: Array<Record<string, number>> = [];
for (let cycle = 0; cycle < 30; cycle++) {
  const candidates: ScanCandidate[] = Array.from({ length: 10000 }, (_, index) => ({
    id: `c-${cycle}-${index}`,
    path: `/fixture-${cycle}/apps/pkg-${index}/node_modules`,
    name: "node_modules",
    kind: "node_modules",
    estimatedBytes: 1,
    isSymlink: false,
    entryType: "directory",
    riskTier: "safe",
    reasons: ["default-pattern"],
    selectedByDefault: true,
  }));
  const plan: ScanPlan = {
    protocolVersion: "1",
    targetDir: `/fixture-${cycle}`,
    selectionPolicy: { mode: "default", includeDangerous: false },
    candidates,
    selectedCandidateIds: candidates.map((c) => c.id),
    createdAt: new Date().toISOString(),
    summary: {
      candidateCount: candidates.length,
      estimatedTotalBytes: candidates.length,
      scannedDirs: candidates.length,
      exact: false,
      selectedCount: candidates.length,
      riskCounts: { safe: candidates.length, caution: 0, dangerous: 0, blocked: 0 },
    },
  };
  let state = createUiState(plan);
  buildDisplayRows(state);
  buildScopeTreeRows(state.targetDir, state.candidates, state.selectedIds, state.expandedScopes);
  const started = performance.now();
  for (let index = 0; index < 100; index++) {
    state = moveCursor(state, 1);
    getUiSummary(state);
  }
  const cursor100Ms = performance.now() - started;
  state = clearSelection(state);
  if (getUiSummary(state).selectedCount !== 0) throw new Error("clear retained selections");
  state = resetForRescan(state);
  if (state.candidates.length !== 0 || state.selectedIds.size !== 0)
    throw new Error("rescan retained old candidates");
  releaseUiCaches();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const memory = process.memoryUsage();
  rows.push({ cycle, cursor100Ms, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed });
}
console.log(
  JSON.stringify(
    {
      date: new Date().toISOString(),
      runtime: Bun.version,
      method:
        "30 sessions, 10k candidates, 100 cursor moves, queue clear and rescan/cache release each. No forced GC. State derivation only; no real scan, painting or leak-proof claim.",
      rows,
    },
    null,
    2,
  ),
);
