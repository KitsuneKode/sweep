import { lstatSync } from "node:fs";
import type {
  CandidateKind,
  RiskTier,
  ScanCandidate,
  ScanEntry,
  ScanPlan,
  ScanResult,
} from "../../protocol/src/index.js";
import { PROTOCOL_VERSION } from "../../protocol/src/index.js";

export function buildPlan(targetDir: string, result: ScanResult): ScanPlan {
  const candidates = result.entries.map((entry) => toCandidate(entry));
  const selectedCandidateIds = candidates
    .filter((candidate) => candidate.selectedByDefault)
    .map((candidate) => candidate.id);
  const riskCounts = countRiskTiers(candidates);

  return {
    protocolVersion: PROTOCOL_VERSION,
    targetDir,
    candidates,
    summary: {
      candidateCount: candidates.length,
      estimatedTotalBytes: result.estimatedTotalBytes,
      scannedDirs: result.scannedDirs,
      exact: result.exact,
      selectedCount: selectedCandidateIds.length,
      riskCounts,
    },
    selectedCandidateIds,
    createdAt: new Date().toISOString(),
  };
}

export function toCandidate(entry: ScanEntry): ScanCandidate {
  const id = `cand_${hashString(`${entry.path}:${entry.name}`)}`;
  const kind = candidateKindFromName(entry.name);
  const riskTier = inferRiskTier(entry, kind);
  const reasons = inferReasons(entry, kind);

  return {
    ...entry,
    id,
    kind,
    riskTier,
    reasons,
    selectedByDefault: riskTier !== "dangerous" && riskTier !== "blocked",
  };
}

export function resolveSelectedCandidates(plan: ScanPlan): ScanCandidate[] {
  const selectedIds = new Set(plan.selectedCandidateIds);
  return plan.candidates.filter((candidate) => selectedIds.has(candidate.id));
}

export function revalidateCandidates(candidates: ScanCandidate[]): {
  ready: ScanEntry[];
  failedPaths: Array<{ path: string; error: string }>;
} {
  const ready: ScanEntry[] = [];
  const failedPaths: Array<{ path: string; error: string }> = [];

  for (const candidate of candidates) {
    try {
      const stat = lstatSync(candidate.path);
      const isSymlink = stat.isSymbolicLink();
      const entryType = isSymlink ? "symlink" : stat.isDirectory() ? "directory" : "file";

      if (isSymlink !== candidate.isSymlink) {
        failedPaths.push({
          path: candidate.path,
          error: "candidate type changed since plan creation",
        });
        continue;
      }

      if (entryType !== candidate.entryType) {
        failedPaths.push({
          path: candidate.path,
          error: "candidate entry type changed since plan creation",
        });
        continue;
      }

      ready.push(candidate);
    } catch (err) {
      failedPaths.push({
        path: candidate.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ready, failedPaths };
}

export function countRiskTiers(candidates: ScanCandidate[]): Record<RiskTier, number> {
  return candidates.reduce<Record<RiskTier, number>>(
    (counts, candidate) => {
      counts[candidate.riskTier] += 1;
      return counts;
    },
    {
      safe: 0,
      caution: 0,
      dangerous: 0,
      blocked: 0,
    },
  );
}

export function candidateKindFromName(name: string): CandidateKind {
  switch (name) {
    case "node_modules":
    case "dist":
    case "build":
    case "out":
    case ".next":
    case ".nuxt":
    case ".svelte-kit":
    case ".turbo":
    case ".vite":
    case ".parcel-cache":
    case "target":
    case "coverage":
    case ".nyc_output":
      return name;
    default:
      return name.endsWith(".tsbuildinfo") ? "tsbuildinfo" : "custom";
  }
}

export function inferRiskTier(entry: ScanEntry, kind: CandidateKind): RiskTier {
  if (entry.isSymlink) return "caution";
  if (kind === "custom") return "dangerous";
  return "safe";
}

export function inferReasons(entry: ScanEntry, kind: CandidateKind): string[] {
  const reasons: string[] = [];
  if (entry.isSymlink) reasons.push("symlink");
  if (kind === "custom") {
    reasons.push("custom-pattern");
  } else {
    reasons.push("default-pattern");
  }
  return reasons;
}

function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
