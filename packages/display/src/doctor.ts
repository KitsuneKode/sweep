import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { createPalette, plural, type Palette } from "./palette.js";
import { displayTarget, truncateMiddle } from "./report.js";

export type DoctorCheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheckEntry {
  name: string;
  ok: boolean;
  /** Optional explicit status; defaults to `"ok"` when `ok` is true, else `"warn"`. */
  status?: DoctorCheckStatus;
  detail: string;
  reasonKind?: string;
  reason?: string;
}

export interface DoctorReportOptions {
  targetDir: string;
  protocolVersion?: string;
  quiet?: boolean;
  verbose?: boolean;
  columns?: number;
  tty?: boolean;
  palette?: Palette;
}

interface SectionSpec {
  title: string;
  names: readonly string[];
}

const SECTIONS: readonly SectionSpec[] = [
  {
    title: "ENVIRONMENT & SAFETY",
    names: ["apply_lock", "filesystem_identity", "target", "config_dir"],
  },
  {
    title: "CONFIGURATION",
    names: ["config", "patterns", "disabled_patterns"],
  },
  {
    title: "RUNTIME & ENGINE",
    names: ["opentui", "rust_engine", "rust_apply_safety", "dry_scan"],
  },
];

const LABELS: Readonly<Record<string, string>> = {
  apply_lock: "apply lock",
  filesystem_identity: "fs identity",
  target: "target",
  config_dir: "config dir",
  config: "config",
  patterns: "patterns",
  disabled_patterns: "disabled patterns",
  opentui: "opentui",
  rust_engine: "rust engine",
  rust_apply_safety: "apply safety",
  dry_scan: "dry scan",
  protocol: "protocol",
};

function checkStatus(check: DoctorCheckEntry): DoctorCheckStatus {
  if (check.status) return check.status;
  return check.ok ? "ok" : "warn";
}

function humanLabel(name: string): string {
  return LABELS[name] ?? name.replace(/_/g, " ");
}

function isStandalonePath(text: string): boolean {
  return (
    !text.includes(" ") &&
    (text.startsWith("/") || text.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(text))
  );
}

/** Word-wrap prose cleanly to `width`, middle-truncating any single token wider than `width`. */
function wrapWords(text: string, width: number): string[] {
  if (width <= 4) return [truncateMiddle(text, Math.max(1, width))];
  if (text.length <= width) return [text];

  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";

  for (const rawWord of words) {
    const word = rawWord.length > width ? truncateMiddle(rawWord, width) : rawWord;
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

/**
 * Format a check detail to fit `budget` without mid-word wrapping.
 * Parenthesized module paths (e.g. `0.6.8 (/.../index.bun.js)`) keep their
 * leading version token clear and middle-truncate the path in dim text.
 */
function formatTtyDetail(
  detail: string,
  status: DoctorCheckStatus,
  budget: number,
  verbose: boolean,
  palette: Palette,
): string[] {
  const safe = sanitizeTerminalText(detail);
  const styleText =
    status === "fail"
      ? palette.danger
      : status === "warn"
        ? palette.warning
        : (text: string) => text;

  if (isStandalonePath(safe)) {
    const shown = verbose ? safe : truncateMiddle(safe, budget);
    return [styleText(shown)];
  }

  // Pattern: `<primary> (<absolute-or-home-path>)` e.g. `0.6.8 (/home/.../index.bun.js)`
  const parenPath = /^([^\s(]+)\s+\(((?:\/|~\/|[A-Za-z]:[\\/])[^)]+)\)$/.exec(safe);
  if (parenPath && status === "ok") {
    const [, head, pathPart] = parenPath;
    if (head && pathPart) {
      const pathBudget = budget - head.length - 3; // space + "(" + ")"
      if (pathBudget >= 10) {
        const shownPath = verbose ? pathPart : truncateMiddle(pathPart, pathBudget);
        return [`${head} ${palette.dim(`(${shownPath})`)}`];
      }
      return [truncateMiddle(safe, budget)];
    }
  }

  // Middle-truncate long embedded paths before word-wrapping so error messages
  // never wrap mid-path or lose their trailing diagnosis.
  const compacted = verbose
    ? safe
    : safe.replace(/(?:\/|~\/|[A-Za-z]:[\\/])[^\s)]+/g, (token) => {
        const maxPath = Math.max(24, Math.floor(budget * 0.65));
        return token.length > maxPath ? truncateMiddle(token, maxPath) : token;
      });

  return wrapWords(compacted, budget).map((line) => styleText(line));
}

function statusGlyph(status: DoctorCheckStatus, palette: Palette): string {
  switch (status) {
    case "ok":
      return palette.positive("✓");
    case "warn":
      return palette.warning("!");
    case "fail":
      return palette.danger("✗");
  }
}

export function formatDoctorReport(
  checks: readonly DoctorCheckEntry[],
  options: DoctorReportOptions,
): string[] {
  const tty = options.tty ?? process.stdout.isTTY === true;
  const palette = options.palette ?? createPalette({ stream: { isTTY: tty } });
  const quiet = options.quiet ?? false;
  const verbose = options.verbose ?? false;
  const protocolVersion =
    options.protocolVersion ?? checks.find((check) => check.name === "protocol")?.detail;

  const visibleChecks = checks.filter((check) => !(quiet && check.ok && !verbose));
  if (quiet && visibleChecks.length === 0) return [];

  let passed = 0;
  let warnings = 0;
  let failures = 0;
  for (const check of checks) {
    const s = checkStatus(check);
    if (s === "ok") passed++;
    else if (s === "fail") failures++;
    else warnings++;
  }

  if (!tty) {
    return formatPlainDoctorReport(visibleChecks, {
      passed,
      warnings,
      failures,
      total: checks.length,
      protocolVersion,
      palette,
    });
  }

  const columns = Math.max(56, Math.min(options.columns ?? process.stdout.columns ?? 100, 120));
  const lines: string[] = [""];

  // Header: ◆ sweep doctor · <target>
  const headerLead = " ◆ sweep doctor · ";
  const shownTarget = sanitizeTerminalText(displayTarget(options.targetDir));
  const targetBudget = Math.max(16, columns - headerLead.length);
  lines.push(
    ` ${palette.bold(palette.accent("◆ sweep doctor"))} ${palette.dim("·")} ${truncateMiddle(shownTarget, targetBudget)}`,
  );

  // One-line summary banner
  const summaryParts: string[] = [];
  if (failures > 0) {
    summaryParts.push(palette.bold(palette.danger(`✗ ${plural(failures, "failure")}`)));
    if (warnings > 0) summaryParts.push(palette.warning(plural(warnings, "warning")));
    summaryParts.push(palette.dim(`${plural(passed, "check")} passed`));
  } else if (warnings > 0) {
    summaryParts.push(palette.bold(palette.warning(`! ${plural(warnings, "warning")}`)));
    summaryParts.push(palette.dim(`${plural(passed, "check")} passed`));
  } else {
    summaryParts.push(palette.bold(palette.positive(`✓ All ${checks.length} checks passed`)));
  }
  if (protocolVersion) {
    summaryParts.push(palette.dim(`protocol v${sanitizeTerminalText(protocolVersion)}`));
  }
  lines.push(` ${summaryParts.join(palette.dim("  ·  "))}`);

  // Group visible checks (omit standalone `protocol` row when already shown in banner and passing)
  const byName = new Map<string, DoctorCheckEntry>();
  const placed = new Set<string>();
  for (const check of visibleChecks) {
    if (check.name === "protocol" && check.ok && protocolVersion && !verbose) {
      placed.add(check.name);
      continue;
    }
    byName.set(check.name, check);
  }

  const grouped: Array<{ title: string; entries: DoctorCheckEntry[] }> = [];
  for (const section of SECTIONS) {
    const entries: DoctorCheckEntry[] = [];
    for (const name of section.names) {
      const found = byName.get(name);
      if (found) {
        entries.push(found);
        placed.add(name);
      }
    }
    if (entries.length > 0) grouped.push({ title: section.title, entries });
  }

  const extra = visibleChecks.filter((check) => !placed.has(check.name));
  if (extra.length > 0) grouped.push({ title: "OTHER", entries: extra });

  const allShown = grouped.flatMap((group) => group.entries);
  const labelWidth = Math.max(18, ...allShown.map((entry) => humanLabel(entry.name).length)) + 2;
  const detailIndent = 1 + 2 + labelWidth; // " " + "<glyph> " + padded label
  const detailBudget = Math.max(20, columns - detailIndent);

  for (const group of grouped) {
    lines.push("");
    lines.push(` ${palette.dim(group.title)}`);
    for (const check of group.entries) {
      const status = checkStatus(check);
      const label = humanLabel(check.name).padEnd(labelWidth);
      const styledLabel = status === "ok" ? label : palette.bold(label);
      const detailLines = formatTtyDetail(check.detail, status, detailBudget, verbose, palette);
      lines.push(` ${statusGlyph(status, palette)} ${styledLabel}${detailLines[0] ?? ""}`);
      const pad = " ".repeat(detailIndent);
      for (let i = 1; i < detailLines.length; i++) {
        lines.push(`${pad}${detailLines[i]}`);
      }
    }
  }

  lines.push("");
  return lines;
}

function formatPlainDoctorReport(
  checks: readonly DoctorCheckEntry[],
  summary: {
    passed: number;
    warnings: number;
    failures: number;
    total: number;
    protocolVersion: string | undefined;
    palette: Palette;
  },
): string[] {
  const { passed, warnings, failures, total, protocolVersion, palette } = summary;
  const lines: string[] = [];

  const proto = protocolVersion ? ` (protocol v${sanitizeTerminalText(protocolVersion)})` : "";
  if (failures > 0) {
    const warnPart = warnings > 0 ? `, ${plural(warnings, "warning")}` : "";
    lines.push(
      `sweep doctor: ${plural(failures, "failure")}${warnPart}, ${plural(passed, "check")} passed${proto}`,
    );
  } else if (warnings > 0) {
    lines.push(
      `sweep doctor: ${plural(warnings, "warning")}, ${plural(passed, "check")} passed${proto}`,
    );
  } else {
    lines.push(`sweep doctor: all ${total} checks passed${proto}`);
  }

  const nameWidth = Math.max(16, ...checks.map((check) => check.name.length));
  for (const check of checks) {
    const status = checkStatus(check);
    const statusText = status.padEnd(4);
    const styledStatus =
      status === "ok"
        ? palette.positive(statusText)
        : status === "fail"
          ? palette.danger(statusText)
          : palette.warning(statusText);
    lines.push(
      `${styledStatus}  ${check.name.padEnd(nameWidth)}  ${sanitizeTerminalText(check.detail)}`,
    );
  }

  return lines;
}

export function printDoctorReport(
  checks: readonly DoctorCheckEntry[],
  options: DoctorReportOptions,
): void {
  for (const line of formatDoctorReport(checks, options)) {
    console.log(line);
  }
}
