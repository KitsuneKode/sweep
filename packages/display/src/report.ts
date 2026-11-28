import { statfsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { RiskTier, ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { IDLE_WINDOW_MS, sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes, formatScanElapsed } from "./bytes.js";
import { groupCandidatesByKind } from "./grouping.js";
import { costCategoryForKind, costDot, createPalette, type Palette } from "./palette.js";

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
  /** The run's --idle window, when one was given. */
  idleMs?: number;
  /** Free/total bytes of the scanned filesystem; null hides the line. */
  disk?: { free: number; total: number } | null;
  /** Clock for idle math (tests). */
  now?: number;
  /** Explicit color palette (defaults to dynamic stdout capability). */
  palette?: Palette;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 86_400_000;
/** Suggest `--idle` at the same window the projects view calls idle. */
const SUGGESTED_IDLE_DAYS = IDLE_WINDOW_MS / DAY;

function readDisk(targetDir: string): { free: number; total: number } | null {
  try {
    const stats = statfsSync(targetDir);
    return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
  } catch {
    return null;
  }
}

/** "now", "<1h", "5h", "12d", "3mo", "1.5y" since the project was last worked on. */
export function idleLabel(activeMs: number | undefined, now = Date.now()): string {
  if (activeMs === undefined) return "";
  const ms = Math.max(0, now - activeMs);
  if (ms < MINUTE) return "now";
  if (ms < HOUR) return "<1h";
  const days = ms / DAY;
  if (days < 1) return `${Math.round(ms / HOUR)}h`;
  if (days < 60) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, "")}y`;
}

function idleWindowToken(idleMs: number): string {
  const safe = Math.max(0, idleMs);
  if (safe < HOUR) return `${Math.max(1, Math.round(safe / MINUTE))}m`;
  if (safe < DAY) return `${Math.round(safe / HOUR)}h`;
  const days = safe / DAY;
  if (days < 60) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, "")}y`;
}

/** Outermost owning folders, by name: `sweep`, not its `apps/cli` and `apps/docs`. */
function projectNames(candidates: readonly ScanCandidate[]): string[] {
  const parents = [...new Set(candidates.map((c) => dirname(c.path)))].sort(
    (a, b) => a.length - b.length,
  );
  const outer: string[] = [];
  for (const dir of parents) {
    if (!outer.some((root) => dir.startsWith(`${root}/`) || dir.startsWith(`${root}\\`)))
      outer.push(dir);
  }
  return outer.map((dir) => basename(dir));
}

const WORKSPACE_STUB_REASON = "workspace-stub";
const SYMLINK_ALIAS_REASON = "symlink-alias";
const GIT_TRACKED_REASON = "git-tracked";
const CLOUD_SYNC_REASON = "cloud-sync";
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

function rail(selected: boolean, tier: RiskTier, palette: Palette): string {
  if (selected) return palette.positive("●");
  if (tier === "caution") return palette.warning("○");
  if (tier === "dangerous" || tier === "blocked") return palette.danger("◌");
  return palette.dim("○");
}

function note(candidate: ScanCandidate, palette: Palette): string {
  const parts: string[] = [];
  if (candidate.riskTier === "blocked") {
    parts.push(
      palette.danger(
        candidate.reasons.includes(GIT_TRACKED_REASON) ? "blocked · git-tracked" : "blocked",
      ),
    );
  } else if (candidate.riskTier === "dangerous") {
    parts.push(palette.danger("dangerous"));
  } else if (candidate.riskTier === "caution") {
    parts.push(palette.warning("caution"));
  }
  if (isStub(candidate)) parts.push(palette.dim("workspace stub"));
  else if (candidate.reasons.includes(SYMLINK_ALIAS_REASON))
    parts.push(palette.dim("symlink alias"));
  else if (candidate.isSymlink) parts.push(palette.dim("symlink"));
  if (candidate.reasons.includes(CLOUD_SYNC_REASON)) parts.push(palette.dim("cloud-synced"));
  return parts.join(palette.dim(" · "));
}

function bar(bytes: number, maxBytes: number, kind: string, palette: Palette): string {
  if (maxBytes <= 0 || bytes <= 0) return " ".repeat(BAR_WIDTH);
  // Never round a real size down to nothing: one sliver still says "some".
  const filled = Math.max(1, Math.round((bytes / maxBytes) * BAR_WIDTH));
  const category = costCategoryForKind(kind);
  return palette.cost[category]("━".repeat(filled)) + palette.dim("─".repeat(BAR_WIDTH - filled));
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
  const palette = options.palette ?? createPalette();
  const columns = Math.max(48, Math.min(options.columns ?? process.stdout.columns ?? 100, 120));
  const verbose = options.verbose ?? false;
  const rowsPerGroup = verbose ? Infinity : (options.rowsPerGroup ?? 6);
  const selectedIds = new Set(plan.selectedCandidateIds);
  const approx = !plan.summary.exact;
  const now = options.now ?? Date.now();
  const idleDays = (c: ScanCandidate) =>
    c.projectActiveMs === undefined ? undefined : (now - c.projectActiveMs) / DAY;
  const lines: string[] = [];

  const visible = verbose ? plan.candidates : plan.candidates.filter((c) => !isStub(c));
  const hiddenStubs = plan.candidates.length - visible.length;
  const selected = plan.candidates.filter((c) => selectedIds.has(c.id));
  const selectedBytes = selected.reduce((sum, c) => sum + c.estimatedBytes, 0);
  const selectedApprox = approx || selected.some((c) => c.bytesKnown === false);
  const guarded = plan.candidates.filter(
    (c) => c.riskTier === "dangerous" || c.riskTier === "blocked",
  );
  const guardedBytes = guarded.reduce((sum, c) => sum + c.estimatedBytes, 0);
  const guardedApprox = approx || guarded.some((c) => c.bytesKnown === false);
  const unselectedBytes = plan.candidates
    .filter((c) => !selectedIds.has(c.id))
    .reduce((sum, c) => sum + c.estimatedBytes, 0);
  const hasUniqueBytes =
    plan.summary.uniqueTotalBytes !== undefined ||
    selected.some((c) => c.uniqueBytes !== undefined);
  const selectedUniqueSum = selected.reduce(
    (sum, c) => sum + (c.uniqueBytes ?? c.estimatedBytes),
    0,
  );
  const selectedUniqueBytes = hasUniqueBytes
    ? unselectedBytes === 0 && plan.summary.uniqueTotalBytes !== undefined
      ? Math.min(selectedBytes, Math.max(selectedUniqueSum, plan.summary.uniqueTotalBytes))
      : Math.min(selectedBytes, selectedUniqueSum)
    : selectedBytes;
  const uniqueBytesPartial = plan.summary.uniqueBytesPartial === true;
  const hasSharedHardlinks =
    !uniqueBytesPartial && hasUniqueBytes && selectedUniqueBytes < selectedBytes;

  const meta = [
    `${plan.summary.scannedDirs} ${plan.summary.scannedDirs === 1 ? "dir" : "dirs"}`,
    plan.summary.skippedDirs ? `${plan.summary.skippedDirs} skipped` : "",
    sanitizeTerminalText(displayTarget(targetDir)),
    options.elapsedMs !== undefined ? formatScanElapsed(options.elapsedMs) : "",
    options.engine ?? "",
  ].filter(Boolean);
  lines.push(
    ` ${palette.positive("✓")} ${palette.dim(truncateMiddle(`Scanned ${meta.join(" · ")}`, columns - 4))}`,
  );
  lines.push("");

  if (plan.candidates.length === 0) {
    lines.push(
      ` ${palette.bold("Nothing to clean.")} ${palette.dim("No build output or caches here.")}`,
    );
    lines.push("");
    return lines;
  }

  // The answer, before the evidence. Guarded (dangerous + blocked) bytes stay
  // strictly separate from reclaimable bytes.
  const idleScope =
    options.idleMs !== undefined ? ` from projects idle ${idleWindowToken(options.idleMs)}+` : "";
  const guardedNote =
    guarded.length > 0 ? `  ·  +${size(guardedBytes, guardedApprox)} guarded` : "";
  const selectedTally = `${visible.filter((c) => selectedIds.has(c.id)).length} of ${visible.length} selected`;
  lines.push(
    hasSharedHardlinks
      ? ` ${palette.bold(palette.positive(`about ${formatBytes(selectedUniqueBytes)} freed`))}${palette.bold(idleScope)}` +
          palette.dim(
            ` (${size(selectedBytes, selectedApprox)} apparent · shared hardlinks)  ·  ${selectedTally}${guardedNote}`,
          )
      : ` ${palette.bold(palette.positive(size(selectedBytes, selectedApprox)))} ${palette.bold(`to reclaim${idleScope}`)}` +
          palette.dim(
            `${uniqueBytesPartial ? " (apparent · shared hardlinks not fully counted)" : ""}  ·  ${selectedTally}${guardedNote}`,
          ),
  );

  // Disk context: what the cleanup means for the space actually left.
  const disk = options.disk === undefined ? readDisk(targetDir) : options.disk;
  if (disk && disk.total > 0) {
    const expectedGain = hasSharedHardlinks ? selectedUniqueBytes : selectedBytes;
    const after = Math.min(disk.total, disk.free + expectedGain);
    const tight = disk.free / disk.total < 0.1;
    lines.push(
      ` ${palette.dim("disk")} ${(tight ? palette.warning : (text: string) => text)(formatBytes(disk.free))}` +
        palette.dim(` free of ${formatBytes(disk.total)}`) +
        (expectedGain > 0
          ? palette.dim("  →  ") + palette.positive(`up to ${formatBytes(after)} free`)
          : ""),
    );
  }

  // Advice from project activity: clear what nobody uses, warn about what
  // someone is using right now (it comes straight back on the next build).
  const advice: string[] = [];
  const activeToday = selected.filter((c) => (idleDays(c) ?? Infinity) < 1);
  if (activeToday.length > 0) {
    const bytes = activeToday.reduce((sum, c) => sum + c.estimatedBytes, 0);
    const all = projectNames(activeToday);
    const names = all.slice(0, 3).map(sanitizeTerminalText);
    const head = `${size(bytes, approx)} of that is in projects worked on today (${names.join(", ")}${all.length > names.length ? ", …" : ""});`;
    const tail = "the next build or install brings it back";
    const singleLine = `${head} ${tail}`;
    if (3 + singleLine.length <= columns) {
      advice.push(
        `${palette.warning("!")} ${size(bytes, approx)} ${palette.dim("of that is in projects worked on today")} ` +
          palette.dim(`(${names.join(", ")}${all.length > names.length ? ", …" : ""}); `) +
          palette.dim(tail),
      );
    } else {
      advice.push(
        `${palette.warning("!")} ${size(bytes, approx)} ${palette.dim("of that is in projects worked on today")} ` +
          palette.dim(`(${names.join(", ")}${all.length > names.length ? ", …" : ""});`),
      );
      advice.push(`  ${palette.dim(tail)}`);
    }
  }
  if (options.idleMs === undefined) {
    const idle = selected.filter((c) => (idleDays(c) ?? 0) >= SUGGESTED_IDLE_DAYS);
    const idleBytes = idle.reduce((sum, c) => sum + c.estimatedBytes, 0);
    if (idle.length > 0 && idleBytes < selectedBytes) {
      advice.push(
        `${palette.accent("→")} ${size(idleBytes, approx)} ${palette.dim(`is in projects idle ${SUGGESTED_IDLE_DAYS}+ days, safe to clear first:`)} ` +
          palette.accent(`sweep --idle ${SUGGESTED_IDLE_DAYS}d`),
      );
    }
  }
  if (advice.length > 0) {
    lines.push("");
    for (const line of advice) lines.push(` ${line}`);
  }
  lines.push("");

  const groups = groupCandidatesByKind(visible).sort((a, b) => b.totalBytes - a.totalBytes);
  const shownRows = groups.map((group) =>
    [...group.entries].sort(rowOrder(selectedIds)).slice(0, rowsPerGroup),
  );
  // One shared note column, so every size lines up down the whole report.
  const noteWidth = Math.min(
    26,
    Math.max(0, ...shownRows.flat().map((c) => stripVTControlCharacters(note(c, palette)).length)),
  );
  const sizeWidth = 11;
  const idleWidth = 12;
  const longestPath = Math.max(
    0,
    ...shownRows.flat().map((c) => sanitizeTerminalText(displayPath(c.path, targetDir)).length),
  );
  // Sizes sit next to their paths, not stranded at the far edge of a wide terminal.
  const pathWidth = Math.max(
    12,
    Math.min(
      longestPath + 2,
      columns - 5 - sizeWidth - idleWidth - (noteWidth > 0 ? noteWidth + 2 : 0),
    ),
  );
  const maxGroupBytes = groups[0]?.totalBytes ?? 0;
  const labelWidth = Math.min(18, Math.max(...groups.map((g) => g.label.length)) + 2);

  for (const [index, group] of groups.entries()) {
    const picked = group.entries.filter((c) => selectedIds.has(c.id)).length;
    const groupApprox = approx || group.entries.some((c) => c.bytesKnown === false);
    lines.push(
      ` ${costDot(group.kind, palette)} ${palette.bold(sanitizeTerminalText(group.label).padEnd(labelWidth))}` +
        `${bar(group.totalBytes, maxGroupBytes, group.kind, palette)}  ` +
        `${palette.bold(size(group.totalBytes, groupApprox).padStart(10))}` +
        palette.dim(`   ${picked} of ${group.entries.length}`),
    );

    const shown = shownRows[index] ?? [];
    const folded = group.entries.length - shown.length;
    for (const candidate of shown) {
      const tail = note(candidate, palette);
      const path = truncateMiddle(
        sanitizeTerminalText(displayPath(candidate.path, targetDir)),
        pathWidth,
      );
      const amount = size(candidate.estimatedBytes, approx || candidate.bytesKnown === false);
      const days = idleDays(candidate);
      const idle = idleLabel(candidate.projectActiveMs, now);
      // Recent work reads in Direction C+ info cyan; long-idle recedes.
      const idleRaw =
        idle === "now"
          ? "active now"
          : idle
            ? `idle ${idle}`
            : candidate.projectRoot !== undefined
              ? "idle ?"
              : "";
      const idleText = idleRaw.padEnd(idleWidth - 2);
      const idleCell = idleRaw
        ? `  ${days !== undefined && days < 7 ? palette.info(idleText) : palette.dim(idleText)}`
        : " ".repeat(idleWidth);
      lines.push(
        `   ${rail(selectedIds.has(candidate.id), candidate.riskTier, palette)} ` +
          `${path.padEnd(pathWidth)}` +
          `${palette.dim(amount.padStart(sizeWidth))}` +
          idleCell +
          (tail ? `  ${tail}` : ""),
      );
    }
    if (folded > 0) {
      const shownBytes = shown.reduce((sum, c) => sum + c.estimatedBytes, 0);
      lines.push(
        palette.dim(
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
      `${palette.warning("○")} ${unselectedReview} left for you to decide ${palette.dim("(caution or dangerous) · review with")} ${palette.accent("sweep ui")}`,
    );
  }
  if (counts.blocked > 0) {
    notes.push(
      `${palette.danger("◌")} ${counts.blocked} blocked ${palette.dim("· git-tracked, project files or protected paths; never removed")}`,
    );
  }
  const cloudSynced = visible.filter((c) => c.reasons.includes(CLOUD_SYNC_REASON)).length;
  if (cloudSynced > 0) {
    notes.push(
      `${palette.warning("!")} ${cloudSynced} ${cloudSynced === 1 ? "candidate is" : "candidates are"} inside a cloud-synced folder ${palette.dim("(removing build output may trigger a large sync)")}`,
    );
  }
  if (hiddenStubs > 0) {
    notes.push(
      palette.dim(
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
