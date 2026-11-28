import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "./bytes.js";
import { costDot, createPalette, plural, type Palette } from "./palette.js";
import { displayTarget, truncateMiddle } from "./report.js";

/** One catalog pattern and what a read-only scan found for it. */
export interface InitFinding {
  pattern: string;
  note: string;
  count: number;
  bytes: number;
}

export interface InitReport {
  targetDir: string;
  /** Built-in patterns with matches: already on, nothing to decide. */
  defaults: InitFinding[];
  /** Opt-in patterns with matches: the decisions `init` asks about. */
  optIns: InitFinding[];
  /** Matches that are git-tracked or project files: shown, never removable. */
  blocked: number;
}

export interface InitDisplayOptions {
  tty?: boolean;
  columns?: number;
  palette?: Palette;
}

function row(
  finding: InitFinding,
  width: number,
  countWidth: number,
  sizeWidth: number,
  tty: boolean,
  palette: Palette,
): string {
  const count = `${finding.count}`.padStart(countWidth);
  const bytes = formatBytes(finding.bytes).padStart(sizeWidth);
  const dot = tty ? `${costDot(finding.pattern, palette)} ` : "";
  return `${dot}${sanitizeTerminalText(finding.pattern).padEnd(width)}  ${palette.dim(count)}  ${bytes}  ${palette.dim(sanitizeTerminalText(finding.note))}`;
}

export function formatInitReport(report: InitReport, options: InitDisplayOptions = {}): string[] {
  const tty = options.tty ?? process.stdout.isTTY === true;
  const palette = options.palette ?? createPalette({ stream: { isTTY: tty } });
  const columns = Math.max(56, Math.min(options.columns ?? process.stdout.columns ?? 100, 120));
  const allFindings = [...report.defaults, ...report.optIns];
  const width = Math.max(12, ...allFindings.map((finding) => finding.pattern.length));
  const countWidth = Math.max(2, ...allFindings.map((finding) => String(finding.count).length));
  const sizeWidth = Math.max(9, ...allFindings.map((finding) => formatBytes(finding.bytes).length));

  const target = sanitizeTerminalText(displayTarget(report.targetDir));
  const lines: string[] = [];

  if (tty) {
    lines.push("");
    lines.push(
      ` ${palette.bold(palette.accent("◆ sweep init"))} ${palette.dim("·")} ${truncateMiddle(target, Math.max(16, columns - 16))}`,
    );
    lines.push("");
  } else {
    lines.push(`sweep init · ${target}`);
    lines.push("");
  }

  if (report.defaults.length > 0) {
    lines.push(
      ` ${palette.bold("Already covered")} ${palette.dim("built-in, pre-selected when safe")}`,
    );
    const marker = tty ? palette.positive("✓") : "ok";
    for (const finding of report.defaults) {
      lines.push(`   ${marker} ${row(finding, width, countWidth, sizeWidth, tty, palette)}`);
    }
  } else {
    lines.push(` ${palette.dim("No built-in artifacts here yet.")}`);
  }

  if (report.optIns.length > 0) {
    lines.push("");
    lines.push(
      ` ${palette.bold("Worth a decision")} ${palette.dim("opt-in names: always reviewed, never pre-selected")}`,
    );
    const marker = tty ? palette.warning("?") : "opt";
    for (const finding of report.optIns) {
      lines.push(`   ${marker} ${row(finding, width, countWidth, sizeWidth, tty, palette)}`);
    }
  }

  if (report.blocked > 0) {
    lines.push("");
    const verb = report.blocked === 1 ? "is" : "are";
    lines.push(
      ` ${palette.dim(`${plural(report.blocked, "match", "matches")} ${verb} git-tracked or project files: listed in scans, never removable.`)}`,
    );
  }
  lines.push("");
  return lines;
}

/**
 * What init saw, before it writes anything: the defaults that already apply,
 * and the opt-in names worth a decision. Reads like a short report, not a log.
 */
export function printInitReport(report: InitReport, options: InitDisplayOptions = {}): void {
  for (const line of formatInitReport(report, options)) {
    console.log(line);
  }
}

/** Format a `.sweeprc` dry-run JSON preview, indented cleanly when printed to a TTY. */
export function formatInitDryRunJson(value: unknown, options: InitDisplayOptions = {}): string[] {
  const tty = options.tty ?? process.stdout.isTTY === true;
  const palette = options.palette ?? createPalette({ stream: { isTTY: tty } });
  const raw = JSON.stringify(value, null, 2).split("\n");
  if (!tty) return raw;
  return [
    ` ${palette.dim(".sweeprc preview")}`,
    ...raw.map((line) => `   ${palette.dim("│")} ${line}`),
    "",
  ];
}

export function printInitDryRunJson(value: unknown, options: InitDisplayOptions = {}): void {
  for (const line of formatInitDryRunJson(value, options)) {
    console.log(line);
  }
}

export function formatInitNextSteps(
  configPath: string,
  written: boolean,
  options: InitDisplayOptions = {},
): string[] {
  const tty = options.tty ?? process.stdout.isTTY === true;
  const palette = options.palette ?? createPalette({ stream: { isTTY: tty } });
  const shown = sanitizeTerminalText(configPath);
  const lines: string[] = [];
  if (written) {
    lines.push(tty ? ` ${palette.positive("✓")} Wrote ${shown}` : `Wrote ${shown}`);
  } else {
    lines.push(` ${palette.dim("Dry run: nothing written.")}`);
  }
  lines.push("");
  lines.push(` ${palette.bold("Next")}`);
  lines.push(
    `   ${palette.accent("sweep --dry-run")}   ${palette.dim("see exactly what would be removed")}`,
  );
  lines.push(
    `   ${palette.accent("sweep ui")}          ${palette.dim("review and choose interactively")}`,
  );
  lines.push(
    `   ${palette.accent("sweep --trash")}     ${palette.dim("clean, keeping a way back")}`,
  );
  lines.push("");
  return lines;
}

export function printInitNextSteps(
  configPath: string,
  written: boolean,
  options: InitDisplayOptions = {},
): void {
  for (const line of formatInitNextSteps(configPath, written, options)) {
    console.log(line);
  }
}
