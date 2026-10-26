import pc from "picocolors";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "./bytes.js";

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

function row(finding: InitFinding, width: number): string {
  const count = `${finding.count}`.padStart(5);
  const bytes = formatBytes(finding.bytes).padStart(10);
  return `${sanitizeTerminalText(finding.pattern).padEnd(width)}${pc.dim(count)}${bytes}  ${pc.dim(sanitizeTerminalText(finding.note))}`;
}

/**
 * What init saw, before it writes anything: the defaults that already apply,
 * and the opt-in names worth a decision. Reads like a short report, not a log.
 */
export function printInitReport(report: InitReport): void {
  const width = Math.max(
    12,
    ...[...report.defaults, ...report.optIns].map((finding) => finding.pattern.length + 2),
  );
  console.log(
    `\n ${pc.bold("sweep init")} ${pc.dim("·")} ${pc.dim(sanitizeTerminalText(report.targetDir))}\n`,
  );
  if (report.defaults.length > 0) {
    console.log(` ${pc.bold("Already covered")} ${pc.dim("built-in, pre-selected when safe")}`);
    for (const finding of report.defaults)
      console.log(`   ${pc.green("✓")} ${row(finding, width)}`);
  } else {
    console.log(` ${pc.dim("No built-in artifacts here yet.")}`);
  }
  if (report.optIns.length > 0) {
    console.log(
      `\n ${pc.bold("Worth a decision")} ${pc.dim("opt-in names: always reviewed, never pre-selected")}`,
    );
    for (const finding of report.optIns) console.log(`   ${pc.yellow("?")} ${row(finding, width)}`);
  }
  if (report.blocked > 0) {
    console.log(
      `\n ${pc.dim(`${report.blocked} match(es) are git-tracked or project files: listed in scans, never removable.`)}`,
    );
  }
  console.log("");
}

export function printInitNextSteps(configPath: string, written: boolean): void {
  const shown = sanitizeTerminalText(configPath);
  console.log(
    written ? ` ${pc.green("✓")} Wrote ${shown}` : ` ${pc.dim("Dry run: nothing written.")}`,
  );
  console.log(`\n ${pc.bold("Next")}`);
  console.log(`   ${pc.cyan("sweep --dry-run")}   ${pc.dim("see exactly what would be removed")}`);
  console.log(`   ${pc.cyan("sweep ui")}          ${pc.dim("review and choose interactively")}`);
  console.log(`   ${pc.cyan("sweep --trash")}     ${pc.dim("clean, keeping a way back")}\n`);
}
