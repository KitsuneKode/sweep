import { stripVTControlCharacters } from "node:util";
import pc from "picocolors";
import type { RiskTier, ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes, formatScanElapsed } from "./bytes.js";
import { groupCandidatesByKind } from "./grouping.js";

/**
 * The terminal scan report: the answer first (what would be reclaimed), then
 * where it lives, biggest first. Rows are paths relative to the scan target,
 * so the part that differs between rows is the part you read. Long groups
 * show their largest rows and fold the tail into one counted line.
 */

export interface ScanReportOptions {
  verbose?: boolean;
  elapsedMs?: number;
  engine?: string;
  /** Terminal width; defaults to the live stdout width. */
  columns?: number;
  /** Rows shown per group before the tail folds. */
  rowsPerGroup?: number;
}

const WORKSPACE_STUB_REASON = "workspace-stub";
const SYMLINK_ALIAS_REASON = "symlink-alias";
const GIT_TRACKED_REASON = "git-tracked";
const BAR_WIDTH = 16;

function isStub(candidate: ScanCandidate): boolean {
  return candidate.reasons.includes(WORKSPACE_STUB_REASON);
}

/** `a/b/c` relative to the target, with the user's home folded to `~`. */
export function displayPath(path: string, targetDir: string): string {
  const target = targetDir.replace(/[\\/]+$/, "");
  if (path === target) return ".";
  if (path.startsWith(`${target}/`) || path.startsWith(`${target}\\`)) {
    return path.slice(target.length + 1);
  }
  const home = process.env.HOME;
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

export function displayTarget(targetDir: string): string {
  const home = process.env.HOME;
  if (home && targetDir === home) return "~";
  if (home && targetDir.startsWith(`${home}/`)) return `~/${targetDir.slice(home.length + 1)}`;
  return targetDir;
}

/** Keep both ends of a path: the root says where, the leaf says what. */
export function truncateMiddle(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(0, width));
  if (text.length <= width) return text;
  const keep = width - 1;
  const head = Math.ceil(keep * 0.4);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

function rail(selected: boolean, tier: RiskTier): string {
  if (selected) return pc.green("●");
  if (tier === "caution") return pc.yellow("○");
  if (tier === "dangerous" || tier === "blocked") return pc.red("◌");
  return pc.dim("○");
}

function note(candidate: ScanCandidate): string {
  const parts: string[] = [];
  if (candidate.riskTier === "blocked") {
    parts.push(
      pc.red(candidate.reasons.includes(GIT_TRACKED_REASON) ? "blocked · git-tracked" : "blocked"),
    );
  } else if (candidate.riskTier === "dangerous") {
    parts.push(pc.red("dangerous"));
  } else if (candidate.riskTier === "caution") {
    parts.push(pc.yellow("caution"));
  }
  if (isStub(candidate)) parts.push(pc.dim("workspace stub"));
  else if (candidate.reasons.includes(SYMLINK_ALIAS_REASON)) parts.push(pc.dim("symlink alias"));
  else if (candidate.isSymlink) parts.push(pc.dim("symlink"));
  return parts.join(pc.dim(" · "));
}

function bar(bytes: number, maxBytes: number): string {
  if (maxBytes <= 0 || bytes <= 0) return " ".repeat(BAR_WIDTH);
  // Never round a real size down to nothing: one sliver still says "some".
  const filled = Math.max(1, Math.round((bytes / maxBytes) * BAR_WIDTH));
  return pc.cyan("━".repeat(filled)) + pc.dim("─".repeat(BAR_WIDTH - filled));
}

function size(bytes: number, approx: boolean): string {
  return `${approx ? "~" : ""}${formatBytes(bytes)}`;
}

/** Selected first, then largest: what would go leads, what stays follows. */
function rowOrder(selectedIds: Set<string>) {
  return (left: ScanCandidate, right: ScanCandidate) => {
    const bySelection = Number(selectedIds.has(right.id)) - Number(selectedIds.has(left.id));
    return bySelection !== 0 ? bySelection : right.estimatedBytes - left.estimatedBytes;
  };
}

export function formatScanReport(
  plan: ScanPlan,
  targetDir: string,
  options: ScanReportOptions = {},
): string[] {
  const columns = Math.max(48, Math.min(options.columns ?? process.stdout.columns ?? 100, 120));
  const verbose = options.verbose ?? false;
  const rowsPerGroup = verbose ? Infinity : (options.rowsPerGroup ?? 6);
  const selectedIds = new Set(plan.selectedCandidateIds);
  const approx = !plan.summary.exact;
  const lines: string[] = [];

  const visible = verbose ? plan.candidates : plan.candidates.filter((c) => !isStub(c));
  const hiddenStubs = plan.candidates.length - visible.length;
  const selected = plan.candidates.filter((c) => selectedIds.has(c.id));
  const selectedBytes = selected.reduce((sum, c) => sum + c.estimatedBytes, 0);

  const meta = [
    `${plan.summary.scannedDirs} dirs`,
    plan.summary.skippedDirs ? `${plan.summary.skippedDirs} skipped` : "",
    sanitizeTerminalText(displayTarget(targetDir)),
    options.elapsedMs !== undefined ? formatScanElapsed(options.elapsedMs) : "",
    options.engine ?? "",
  ].filter(Boolean);
  lines.push(
    ` ${pc.green("✓")} ${pc.dim(truncateMiddle(`Scanned ${meta.join(" · ")}`, columns - 4))}`,
  );
  lines.push("");

  if (plan.candidates.length === 0) {
    lines.push(` ${pc.bold("Nothing to clean.")} ${pc.dim("No build output or caches here.")}`);
    lines.push("");
    return lines;
  }

  // The answer, before the evidence.
  lines.push(
    ` ${pc.bold(pc.yellow(size(selectedBytes, approx)))} ${pc.bold("to reclaim")}` +
      pc.dim(
        `  ·  ${visible.filter((c) => selectedIds.has(c.id)).length} of ${visible.length} selected`,
      ),
  );
  lines.push("");

  const groups = groupCandidatesByKind(visible).sort((a, b) => b.totalBytes - a.totalBytes);
  const shownRows = groups.map((group) =>
    [...group.entries].sort(rowOrder(selectedIds)).slice(0, rowsPerGroup),
  );
  // One shared note column, so every size lines up down the whole report.
  const noteWidth = Math.min(
    26,
    Math.max(0, ...shownRows.flat().map((c) => stripVTControlCharacters(note(c)).length)),
  );
  const sizeWidth = 11;
  const longestPath = Math.max(
    0,
    ...shownRows.flat().map((c) => sanitizeTerminalText(displayPath(c.path, targetDir)).length),
  );
  // Sizes sit next to their paths, not stranded at the far edge of a wide terminal.
  const pathWidth = Math.max(
    12,
    Math.min(longestPath + 2, columns - 5 - sizeWidth - (noteWidth > 0 ? noteWidth + 2 : 0)),
  );
  const maxGroupBytes = groups[0]?.totalBytes ?? 0;
  const labelWidth = Math.min(18, Math.max(...groups.map((g) => g.label.length)) + 2);

  for (const [index, group] of groups.entries()) {
    const picked = group.entries.filter((c) => selectedIds.has(c.id)).length;
    lines.push(
      ` ${pc.bold(sanitizeTerminalText(group.label).padEnd(labelWidth))}` +
        `${bar(group.totalBytes, maxGroupBytes)}  ` +
        `${pc.yellow(size(group.totalBytes, approx).padStart(10))}` +
        pc.dim(`   ${picked} of ${group.entries.length}`),
    );

    const shown = shownRows[index] ?? [];
    const folded = group.entries.length - shown.length;
    for (const candidate of shown) {
      const tail = note(candidate);
      const path = truncateMiddle(
        sanitizeTerminalText(displayPath(candidate.path, targetDir)),
        pathWidth,
      );
      const amount = size(candidate.estimatedBytes, approx || candidate.bytesKnown === false);
      lines.push(
        `   ${rail(selectedIds.has(candidate.id), candidate.riskTier)} ` +
          `${path.padEnd(pathWidth)}` +
          `${pc.dim(amount.padStart(sizeWidth))}` +
          (tail ? `  ${tail}` : ""),
      );
    }
    if (folded > 0) {
      const shownBytes = shown.reduce((sum, c) => sum + c.estimatedBytes, 0);
      lines.push(
        pc.dim(
          `     + ${folded} more · ${size(group.totalBytes - shownBytes, approx)}  (--verbose lists all)`,
        ),
      );
    }
    lines.push("");
  }

  // What stays, and why: the reader should never wonder about a missing item.
  const counts = plan.summary.riskCounts;
  const unselectedReview = visible.filter(
    (c) => !selectedIds.has(c.id) && (c.riskTier === "caution" || c.riskTier === "dangerous"),
  ).length;
  const notes: string[] = [];
  if (unselectedReview > 0) {
    notes.push(
      `${pc.yellow("○")} ${unselectedReview} left for you to decide ${pc.dim("(caution or dangerous) · review with")} ${pc.cyan("sweep ui")}`,
    );
  }
  if (counts.blocked > 0) {
    notes.push(
      `${pc.red("◌")} ${counts.blocked} blocked ${pc.dim("· git-tracked, project files or protected paths; never removed")}`,
    );
  }
  if (hiddenStubs > 0) {
    notes.push(
      pc.dim(
        `  ${hiddenStubs} workspace node_modules ${hiddenStubs === 1 ? "stub" : "stubs"} hidden · --verbose to list`,
      ),
    );
  }
  for (const line of notes) lines.push(` ${line}`);
  if (notes.length > 0) lines.push("");
  return lines;
}

export function printScanReport(
  plan: ScanPlan,
  targetDir: string,
  options: ScanReportOptions = {},
): void {
  for (const line of formatScanReport(plan, targetDir, options)) console.log(line);
}
