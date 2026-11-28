import { formatBytes } from "@kitsunekode/sweep-display";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { bold, fg, t, type MouseEvent, type StyledText } from "@opentui/core";
import { dirname } from "node:path";
import { useRef, type ReactNode } from "react";
import { formatAge, RECENT_WINDOW_MS } from "./age.js";
import { filterAdvice } from "./filter-query.js";
import { buildIdleInsight, pickInsight } from "./insights.js";
import { Meter, ScanMeter, StackBar, useCountUp } from "./Meter.js";
import type { StackSegment } from "./meter-draw.js";
import { useMotionEnabled } from "./motion.js";
import { rebuildFor, type CostShare, type RebuildCost } from "./project-details.js";
import { ProjectDetails } from "./ProjectDetails.js";
import {
  categoryGlyph,
  concatStyled,
  keycap,
  primaryKeycap,
  QUEUE_GLYPH,
  queueState,
  resolveIconMode,
  type IconMode,
} from "./presentation.js";
import { SECTION_TITLE, diskGainedText, type Project, type ProjectRow } from "./projects.js";
import { cellWidth, clipCells, clipStart } from "./text-cells.js";
import { costColors, mixHex, ROW_BAR_SOFT, ROW_BAR_STRONG, type ThemeTokens } from "./theme.js";

export interface ProjectsViewProps {
  tokens: ThemeTokens;
  width: number;
  height: number;
  target: string;
  rows: readonly ProjectRow[];
  cursor: number;
  now: number;
  scanning: boolean;
  /** 0..1, already monotonic. */
  sizedLabel: string;
  reclaimableBytes: number;
  /** Estimated freed bytes excluding shared hardlinks (pnpm/Bun stores). */
  uniqueReclaimableBytes?: number | undefined;
  /** True when bounded hardlink tracking hit its cap; fall back to apparent + qualifier. */
  uniqueBytesPartial?: boolean | undefined;
  /** Dangerous and blocked bytes: found, never part of the total above. */
  guardedBytes?: number | undefined;
  /** Why each item of the last removal failed, by path; shown on its row. */
  failures?: ReadonlyMap<string, string> | undefined;
  /** What the reclaimable bytes cost to bring back; the hero bar is drawn from it. */
  byCost?: readonly CostShare[] | undefined;
  /** Some reclaimable (safe + caution) sizes are still being measured (a "~" on the headline). */
  reclaimablePartial?: boolean | undefined;
  /** Some guarded (dangerous + blocked) sizes are still being measured (a "~" on "+guarded"). */
  guardedPartial?: boolean | undefined;
  /** Legacy alias for `reclaimablePartial` when callers pass a single flag. */
  partial?: boolean | undefined;
  /** The scan stopped short: whatever is shown is not the whole tree. */
  incomplete?: boolean | undefined;
  /** Safe bytes in projects idle 30+ days: the easy win, one key away. */
  idleBytes: number;
  projectCount: number;
  selectedBytes: number;
  /** Estimated freed bytes for queued items excluding shared hardlinks. */
  uniqueSelectedBytes?: number | undefined;
  selectedCount: number;
  selectedIds: ReadonlySet<string>;
  diskFree: number | null;
  /** Modes that change what an apply does are always named in the header. */
  dryRun?: boolean;
  trash?: boolean;
  filter: string;
  searchFocused: boolean;
  /**
   * Filters that narrow this list without being typed here (a risk tier or a
   * folder scope carried over from the full view). Said in the answer line, so
   * a total is never read as the whole scan.
   */
  narrowing?: string | undefined;
  /** One line under the list: a notice when there is one, else the key hints. */
  footer: ReactNode;
  /** What the last removal gave back; the answer line says it until the next queue. */
  receipt?: ProjectsReceipt | null | undefined;
  /** One transient line above the footer; the hints never give way to it. */
  notice?: StyledText | undefined;
  onFilterInput: (value: string) => void;
  onFilterSubmit: () => void;
  onRowPress: (index: number, onMark: boolean) => void;
  /** Wheel moves the cursor, never the viewport alone (ux-principles). */
  onCursorDelta: (delta: number) => void;
}

export interface ProjectsReceipt {
  freedBytes: number;
  /** Measured change in free space on the volume; absent when it could not be read. */
  diskGained?: number | undefined;
  removed: number;
  failed: number;
  /** Items the apply never reached (stopped early); they stay queued. */
  unattempted?: number | undefined;
  trash: boolean;
  stopped: boolean;
}

const COST_NOCOLOR_GLYPH: Record<RebuildCost, string> = {
  cache: "⣿",
  install: "⣶",
  build: "⣤",
  unknown: "⠒",
};

/**
 * The hero bar's parts: each cost in order, queued bytes solid and the rest
 * receding once anything is queued; solid throughout while nothing is.
 */
function heroSegments(
  byCost: readonly CostShare[],
  color: Record<RebuildCost, string>,
): StackSegment[] {
  const anyQueued = byCost.some((share) => share.queuedBytes > 0);
  return byCost.flatMap((share): StackSegment[] => {
    const noColorGlyph = COST_NOCOLOR_GLYPH[share.cost];
    if (!anyQueued) return [{ fraction: share.bytes, color: color[share.cost], noColorGlyph }];
    const rest = share.bytes - share.queuedBytes;
    return [
      ...(share.queuedBytes > 0
        ? [{ fraction: share.queuedBytes, color: color[share.cost], noColorGlyph }]
        : []),
      ...(rest > 0 ? [{ fraction: rest, color: color[share.cost], dim: true, noColorGlyph }] : []),
    ];
  });
}

/** "● cache 2.1 GiB   ● install 38.6 GiB": whole entries only, 1-cell category icons. */
function costLegend(
  byCost: readonly CostShare[],
  color: Record<RebuildCost, string>,
  tokens: ThemeTokens,
  width: number,
  iconMode: IconMode,
  isNoColor: boolean,
): StyledText {
  let out = t``;
  let used = 0;
  for (const share of byCost) {
    const label = share.cost === "unknown" ? "custom" : share.cost;
    const sizeStr = formatBytes(share.bytes);
    const glyph = categoryGlyph(share.cost, iconMode, isNoColor);
    const text = `${label} ${sizeStr}`;
    const cost = (used > 0 ? 3 : 0) + cellWidth(glyph) + 1 + cellWidth(text);
    if (used + cost > width) break;
    out = concatStyled(
      out,
      t`${used > 0 ? "   " : ""}${fg(color[share.cost])(glyph)} ${fg(tokens.text)(label)} ${fg(tokens.textSecondary)(sizeStr)}`,
    );
    used += cost;
  }
  return out;
}

/**
 * The success state, said once in the answer line's place: a check, the
 * bytes counting up to what came back, and the disk as it is now.
 */
function ReceiptLine({
  receipt,
  diskFree,
  tokens,
}: {
  receipt: ProjectsReceipt;
  diskFree: number | null;
  tokens: ThemeTokens;
}) {
  const motion = useMotionEnabled();
  const counted = useCountUp(receipt.freedBytes, motion);
  const clean = receipt.failed === 0 && !receipt.stopped;
  const mark = clean ? fg(tokens.positive)("✓ ") : fg(tokens.warning)("! ");
  const verb = receipt.trash ? " moved to trash" : " freed";
  const rest = [
    plural(receipt.removed, "item"),
    receipt.failed > 0 ? `${receipt.failed} failed, still queued` : "",
    receipt.unattempted ? `${receipt.unattempted} not attempted` : "",
    receipt.stopped ? "stopped early" : "",
    receipt.diskGained !== undefined && !receipt.trash ? diskGainedText(receipt) : "",
    diskFree !== null && !receipt.trash ? `${formatBytes(diskFree)} free now` : "",
  ].filter(Boolean);
  return (
    <text
      content={t`${mark}${bold(fg(clean ? tokens.positive : tokens.text)(`~${formatBytes(Math.round(counted))}`))}${fg(tokens.text)(verb)}${fg(tokens.textMuted)(`  ·  ${rest.join("  ·  ")}`)}`}
      wrapMode="none"
    />
  );
}

/**
 * Width budgets across 80 / 100 / 120+ column terminals:
 * - >= 116 cols (120-col terminal): list + C+ right ProjectDetails card margin
 * - 88..115 cols (100-col terminal): full-width list with size bars, where, and kinds
 * - < 88 cols (80-col terminal): compact list shedding bars while preserving every label
 */
const CONTENT_MAX = 116;
const LIST_MAX = 104;
const LEAD = 5; // "› ○  " - cursor, checkbox, gap
const SIZE_W = 10;
const IDLE_W = 5;
const BAR_W = 8;
const PANEL_LIST_MIN = 72;
const PANEL_MIN = 38;
const PANEL_MAX = 48;
const PANEL_GAP = 2;
const GIB = 1024 ** 3;

/** A row in three parts, so the size bar sits cleanly between name/size and trailing metadata. */
interface RowParts {
  lead: StyledText;
  bar?: { fraction: number; color: string };
  tail?: StyledText;
}

function padCells(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - cellWidth(text)));
}
function styledWidth(text: StyledText): number {
  return text.chunks.reduce((sum, chunk) => sum + cellWidth(chunk.text), 0);
}
function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}
function riskLabel(project: Project): string {
  return project.dangerous > 0
    ? `✗ ${project.dangerous} dangerous`
    : project.caution > 0
      ? `! ${project.caution} caution`
      : "";
}
/** "node_modules · .next +2": the biggest two, then how many more. */
function kindSummary(project: Project, width: number): string {
  for (let count = Math.min(2, project.kinds.length); count >= 1; count--) {
    const rest = project.kinds.length - count;
    const text = `${project.kinds.slice(0, count).join(" · ")}${rest > 0 ? ` +${rest}` : ""}`;
    if (cellWidth(text) <= width) return text;
  }
  return width >= 6 ? clipCells(project.kinds[0] ?? "", width) : "";
}

/**
 * Direction C+ (Refined Clove) Projects view and Storage Card.
 *
 * Top: elevated Storage Card answering "how much can come back, by rebuild cost"
 * with one bold tabular headline number, a dithered dot-matrix bar (Kitty pixels
 * with Braille fallback), colored 1-cell category icons in the legend, and a
 * width-tiered insight sentence that never truncates at 80, 100, or 120 cols.
 *
 * Body: grouped project list (Finished worktrees, Idle 30+ days, Worked on
 * recently) with a boxed C+ details margin on >= 120-column terminals.
 */
export function ProjectsView(props: ProjectsViewProps) {
  const { tokens, width, height, rows, cursor, now, scanning, footer, filter, searchFocused } =
    props;
  const isNoColor = Boolean(process.env.NO_COLOR);
  const iconMode = resolveIconMode();

  // Outer app box pads 1 cell/side; this view pads 1 cell/side plus 2-cell right breathing room.
  const usable = Math.max(20, Math.min(CONTENT_MAX, width - 6));
  const panelW =
    usable >= PANEL_LIST_MIN + PANEL_GAP + PANEL_MIN
      ? Math.min(PANEL_MAX, usable - PANEL_GAP - PANEL_LIST_MIN)
      : 0;
  const listInner = Math.max(
    20,
    Math.min(LIST_MAX, panelW > 0 ? usable - panelW - PANEL_GAP : usable),
  );
  // Storage Card spans full usable width above the list + details columns.
  const useCardSurface = height >= 20 && usable >= 56;
  const cardBg = useCardSurface ? tokens.surface : tokens.bg;
  const cardInner = Math.max(20, usable - (useCardSurface ? 2 : 0));

  const focusRow = rows[cursor];
  const focusProject = focusRow && "project" in focusRow ? focusRow.project : null;
  const showSearch = searchFocused || filter.length > 0;
  const advice = showSearch ? filterAdvice(filter) : null;

  const byCost = props.byCost ?? [];
  const showLegend = !scanning && byCost.length > 0 && height >= 20;

  // Count idle projects and finished worktrees for the tied insight sentence.
  let idleProjectCount = 0;
  let finishedWorktreeCount = 0;
  for (const row of rows) {
    if (row.kind === "section") {
      if (row.section === "idle") idleProjectCount = row.count;
      else if (row.section === "finished") finishedWorktreeCount = row.count;
    }
  }
  const showInsightRow =
    !scanning &&
    props.selectedCount === 0 &&
    !props.receipt &&
    props.idleBytes > 0 &&
    height >= 22 &&
    usable >= 56;

  // Chrome budget: card rows (brand, headline, bar, optional legend, optional insight) + spacer + search + notice + footer.
  const cardRows = 3 + (showLegend ? 1 : 0) + (showInsightRow ? 1 : 0);
  const chrome = cardRows + 1 + (showSearch ? (advice ? 3 : 2) : 0) + 2;
  const room = Math.max(3, height - chrome);

  // Keep the cursor in view without jumping the page on every move.
  const topRef = useRef(0);
  let top = topRef.current;
  if (cursor < top + 1) top = Math.max(0, cursor - 1);
  if (cursor > top + room - 2) top = Math.min(Math.max(0, rows.length - room), cursor - room + 2);
  top = Math.max(0, Math.min(top, Math.max(0, rows.length - room)));
  topRef.current = top;
  const shown = rows.slice(top, top + room);

  const projectRows = rows.flatMap((row) => (row.kind === "project" ? [row.project] : []));
  const longestName = Math.max(
    10,
    ...projectRows.map((project) => cellWidth(project.name)),
    ...rows.flatMap((row) => (row.kind === "artifact" ? [cellWidth(row.candidate.name) + 4] : [])),
  );
  // Show size bars when the list has comfortable room beside metadata.
  const barW = listInner >= 84 ? BAR_W : 0;
  const barGap = barW > 0 ? barW + 2 : 0;
  const nameW = Math.min(
    26,
    longestName,
    Math.max(10, listInner - LEAD - SIZE_W - barGap - IDLE_W - 6),
  );
  const detailW = Math.max(0, listInner - LEAD - nameW - 2 - SIZE_W - 2 - barGap - IDLE_W - 3);
  const largest = Math.max(1, ...projectRows.map((project) => project.queueableBytes));
  const riskColW = Math.max(
    0,
    ...projectRows.map((project) => {
      const label = riskLabel(project);
      return label ? cellWidth(label) + 2 : 0;
    }),
  );
  const longestWhere = Math.max(0, ...projectRows.map((project) => cellWidth(project.parent)));
  const restW = Math.max(0, detailW - riskColW);
  const whereW = restW >= 30 ? Math.min(longestWhere, Math.floor(restW * 0.55)) : 0;

  const costColor = costColors(tokens);
  const barSoft = mixHex(tokens.meterTrack, tokens.textMuted, ROW_BAR_SOFT);
  const barStrong = mixHex(tokens.meterTrack, tokens.textMuted, ROW_BAR_STRONG);

  // ── Storage Card Header ─────────────────────────────────────────────────
  const modes = [props.dryRun ? "DRY RUN" : "", props.trash ? "TRASH" : ""].filter(Boolean);
  const rightMeta = scanning
    ? t`${fg(tokens.info)(props.sizedLabel)}`
    : props.selectedCount > 0
      ? t`${bold(fg(tokens.accent)(`${props.selectedCount.toLocaleString()} queued`))}`
      : props.diskFree !== null
        ? t`${fg(tokens.textSecondary)(`${formatBytes(props.diskFree)} free`)}`
        : t``;
  const status =
    modes.length > 0
      ? concatStyled(
          t`${bold(fg(tokens.warning)(modes.join(" · ")))}${fg(tokens.textDim)("  ")}`,
          rightMeta,
        )
      : rightMeta;
  const brand = t`${bold(fg(tokens.accent)("◆ sweep"))}  ${fg(tokens.textSecondary)(
    clipCells(
      sanitizeTerminalText(props.target),
      Math.max(8, cardInner - styledWidth(status) - 11),
      true,
    ),
  )}`;

  // One bold tabular headline number per card (reclaimable = safe + caution only).
  // Each subtotal carries "~" strictly from its own partial flag (aligned with LedgerBand).
  const reclaimablePartial = props.reclaimablePartial ?? props.partial ?? false;
  const guardedPartial = props.guardedPartial ?? false;
  const approx = scanning || reclaimablePartial || props.incomplete ? "~" : "";
  const guardedApprox = scanning || guardedPartial || props.incomplete ? "~" : "";
  const uniquePartial = !scanning && props.uniqueBytesPartial === true;
  const selectedHasShared =
    !scanning &&
    !uniquePartial &&
    props.uniqueSelectedBytes !== undefined &&
    props.uniqueSelectedBytes < props.selectedBytes;
  const reclaimHasShared =
    !scanning &&
    !uniquePartial &&
    props.uniqueReclaimableBytes !== undefined &&
    props.uniqueReclaimableBytes < props.reclaimableBytes;
  const partialQualifier = uniquePartial ? " (shared hardlinks not fully counted)" : "";
  const answer =
    props.selectedCount > 0
      ? selectedHasShared
        ? t`${bold(fg(tokens.accent)(`about ${formatBytes(props.uniqueSelectedBytes!)} freed`))}${fg(
            tokens.textMuted,
          )(
            ` (${formatBytes(props.selectedBytes)} apparent)  ·  ${plural(props.selectedCount, "item")}  `,
          )}`
        : t`${bold(fg(tokens.accent)(formatBytes(props.selectedBytes)))}${fg(tokens.text)(
            " queued",
          )}${fg(tokens.textMuted)(`${partialQualifier}  ·  ${plural(props.selectedCount, "item")}  `)}`
      : props.reclaimableBytes > 0 || !scanning
        ? reclaimHasShared
          ? t`${bold(fg(tokens.text)(`about ${formatBytes(props.uniqueReclaimableBytes!)} freed`))}${fg(
              tokens.textMuted,
            )(
              ` (${approx}${formatBytes(props.reclaimableBytes)} apparent)  ·  ${plural(props.projectCount, "project")}`,
            )}`
          : t`${bold(fg(tokens.text)(`${approx}${formatBytes(props.reclaimableBytes)}`))}${fg(
              tokens.textSecondary,
            )(
              scanning ? " so far" : " you can reclaim",
            )}${fg(tokens.textMuted)(`${partialQualifier}  ·  ${plural(props.projectCount, "project")}`)}`
        : t`${fg(tokens.textMuted)("Looking for build output…")}`;

  const reviewActionChip =
    props.selectedCount > 0 ? t`${primaryKeycap("c", tokens)}${fg(tokens.text)(" review")}` : null;
  const narrowingHint = props.narrowing
    ? t`${fg(tokens.textMuted)("  ·  ")}${fg(tokens.warning)(
        clipCells(
          sanitizeTerminalText(props.narrowing),
          Math.max(8, cardInner - styledWidth(answer) - 14),
          true,
        ),
      )}${fg(tokens.textMuted)(" · ")}${fg(tokens.text)("esc")}${fg(tokens.textMuted)(" clears")}`
    : null;
  const guardedHint =
    props.selectedCount === 0 && !scanning && (props.guardedBytes ?? 0) > 0
      ? t`${fg(tokens.textMuted)("  ·  ")}${fg(tokens.textDim)(
          `+${guardedApprox}${formatBytes(props.guardedBytes ?? 0)} guarded`,
        )}`
      : null;
  const incompleteHint =
    props.incomplete && !scanning
      ? t`${fg(tokens.textMuted)("  ·  ")}${fg(tokens.warning)("scan incomplete")}${fg(tokens.textMuted)(" · ")}${fg(tokens.text)("r")}${fg(tokens.textMuted)(" retries")}`
      : null;

  let answerLine = answer;
  for (const extra of [reviewActionChip, incompleteHint, guardedHint, narrowingHint]) {
    if (extra && styledWidth(answerLine) + styledWidth(extra) <= cardInner) {
      answerLine = concatStyled(answerLine, extra);
    }
  }

  // Width-tiered insight sentence + keycap (never truncates with `…` at 80/100/120 cols).
  const insightAction = t`${keycap("i", tokens)}${fg(tokens.textSecondary)(" queue idle")}`;
  const insightBudget = Math.max(20, cardInner - styledWidth(insightAction) - 3);
  const idleInsight = buildIdleInsight(
    props.idleBytes,
    idleProjectCount,
    finishedWorktreeCount,
    formatBytes,
  );
  const insightText = pickInsight(idleInsight, insightBudget);
  const insightLine = concatStyled(
    t`${fg(tokens.textSecondary)(insightText)}${" ".repeat(
      Math.max(2, cardInner - cellWidth(insightText) - styledWidth(insightAction)),
    )}`,
    insightAction,
  );

  // ── Rows ────────────────────────────────────────────────────────────────
  const line = (index: number, row: ProjectRow): RowParts => {
    const isCursor = index === cursor;
    const pointer = fg(tokens.accent)(isCursor ? "›" : " ");
    if (row.kind === "spacer") return { lead: t`` };
    if (row.kind === "section") {
      const label = SECTION_TITLE[row.section];
      const size = `${row.reclaimablePartial ? "~" : ""}${formatBytes(row.bytes)}`;
      const guard =
        row.guardedBytes > 0
          ? `  ·  +${row.guardedPartial ? "~" : ""}${formatBytes(row.guardedBytes)} guarded`
          : "";
      const fits = (text: string) => cellWidth(label) + 2 + cellWidth(text) <= listInner;
      const full = `${plural(row.count, "project")}  ·  ${size}`;
      const meta = fits(`${full}${guard}`)
        ? `${full}${guard}`
        : fits(full)
          ? full
          : fits(`${size}${guard}`) && guard
            ? `${size}${guard}`
            : size;
      const gap = Math.max(2, listInner - cellWidth(label) - cellWidth(meta));
      return {
        lead: t`${fg(tokens.headerText)(label)}${" ".repeat(gap)}${fg(tokens.textMuted)(meta)}`,
      };
    }
    if (row.kind === "more") {
      const label = `+ ${plural(row.count, "more project")}  ·  ${formatBytes(row.bytes)}`;
      return {
        lead: t`${pointer}    ${fg(tokens.textMuted)(label)}${fg(tokens.textDim)(
          isCursor ? "   enter shows them" : "",
        )}`,
      };
    }
    if (row.kind === "moreArtifacts") {
      const label = `+ ${plural(row.count, "smaller item")}  ·  ${formatBytes(row.bytes)}`;
      return {
        lead: t`${pointer}      ${fg(tokens.textMuted)(label)}${fg(tokens.textDim)(
          isCursor ? "   enter lists them" : "",
        )}`,
      };
    }
    if (row.kind === "project") {
      const p = row.project;
      const state = p.queueable.length === 0 ? null : queueState(p.selected, p.queueable.length);
      const mark = state
        ? fg(
            state === "none"
              ? tokens.textDim
              : state === "some"
                ? tokens.textSecondary
                : tokens.accent,
          )(QUEUE_GLYPH[state])
        : fg(tokens.textDim)("·");
      const nameText = padCells(clipCells(sanitizeTerminalText(p.name), nameW, true), nameW);
      const name = isCursor ? bold(fg(tokens.text)(nameText)) : fg(tokens.text)(nameText);
      const size = `${p.reclaimablePartial ? "~" : ""}${formatBytes(p.queueableBytes)}`.padStart(
        SIZE_W,
      );
      // One bold headline per card: row sizes use luminance hierarchy (bright for >= 1 GiB).
      const sizeColor =
        state === "all"
          ? tokens.accent
          : p.queueableBytes >= GIB
            ? tokens.text
            : tokens.textSecondary;
      const unknownIdle = p.section === "unknown" || p.activeMs === undefined;
      const idle = (unknownIdle ? "?" : formatAge(p.activeMs, now)).padStart(IDLE_W);
      const recent =
        !unknownIdle && p.activeMs !== undefined && now - p.activeMs < RECENT_WINDOW_MS;
      const idleColor = unknownIdle ? tokens.textDim : recent ? tokens.info : tokens.textMuted;
      const risk = riskLabel(p);
      const where = p.parent ? sanitizeTerminalText(p.parent) : "";
      const clipWhere = (maxW: number) =>
        p.worktreeOf !== undefined ? clipCells(where, maxW, true) : clipStart(where, maxW);
      const detail = (() => {
        if (restW <= 0) return "";
        if (!where) return kindSummary(p, restW);
        if (p.worktreeOf !== undefined) {
          const wtLabel = clipWhere(restW);
          const kindRoom = restW - cellWidth(wtLabel) - 2;
          const kinds = kindRoom >= 8 ? kindSummary(p, kindRoom) : "";
          return kinds ? `${wtLabel}  ${kinds}` : wtLabel;
        }
        if (whereW >= 8 && restW > whereW + 8) {
          const kinds = kindSummary(p, restW - whereW - 2);
          return kinds ? `${padCells(clipWhere(whereW), whereW)}  ${kinds}` : clipWhere(restW);
        }
        return kindSummary(p, restW) || clipWhere(restW);
      })();
      return {
        lead: t`${pointer} ${mark}  ${name}  ${fg(sizeColor)(size)}  `,
        ...(barW > 0
          ? {
              bar: {
                fraction: p.queueableBytes / largest,
                color: state === "all" ? tokens.accent : isCursor ? barStrong : barSoft,
              },
            }
          : {}),
        tail: t`${barW > 0 ? "  " : ""}${fg(idleColor)(idle)}   ${fg(
          p.dangerous > 0 ? tokens.danger : tokens.warning,
        )(padCells(risk, riskColW))}${fg(tokens.textDim)(detail)}`,
      };
    }

    // An opened project's artifact: colored 1-cell category icon + name + tabular size + cost/folder.
    const c = row.candidate;
    const queued = props.selectedIds.has(c.id);
    const rebuild = rebuildFor(c.kind, row.project.key, c.name);
    const catGlyph = categoryGlyph(rebuild.cost, iconMode, isNoColor);
    const catColor = c.riskTier === "blocked" ? tokens.blocked : costColor[rebuild.cost];
    const mark =
      c.riskTier === "blocked"
        ? fg(tokens.blocked)("⊘")
        : fg(queued ? tokens.accent : tokens.textDim)(queued ? "●" : "○");
    const inside = c.path.startsWith(`${row.project.key}/`)
      ? c.path.slice(row.project.key.length + 1)
      : c.name;
    const folder = dirname(inside) === "." ? "" : sanitizeTerminalText(dirname(inside));
    const kindColW = Math.max(4, nameW - 4);
    const kindText = padCells(clipCells(sanitizeTerminalText(c.name), kindColW, true), kindColW);
    const size = `${c.bytesKnown === false ? "~" : ""}${formatBytes(c.estimatedBytes)}`.padStart(
      SIZE_W,
    );
    const sizeColor = queued
      ? tokens.accent
      : c.estimatedBytes >= GIB
        ? tokens.text
        : tokens.textSecondary;
    const riskText = c.riskTier === "safe" ? "" : c.riskTier;
    const riskTone =
      c.riskTier === "dangerous"
        ? tokens.danger
        : c.riskTier === "caution"
          ? tokens.warning
          : tokens.blocked;
    const riskW = row.project.artifacts.some((a) => a.riskTier === "dangerous")
      ? 11
      : row.project.artifacts.some((a) => a.riskTier !== "safe")
        ? 9
        : 0;
    const where = clipStart(folder, Math.max(0, detailW - riskW));
    const failure = props.failures?.get(c.path);
    const failedTail = failure
      ? t`${barW > 0 ? "  " : ""}${fg(tokens.danger)(
          `✗ ${clipCells(sanitizeTerminalText(failure), Math.max(8, detailW + IDLE_W - 2), true)}`,
        )}`
      : null;
    const nameStyled =
      c.riskTier === "blocked"
        ? fg(tokens.blocked)(kindText)
        : c.riskTier === "dangerous"
          ? fg(tokens.danger)(kindText)
          : isCursor
            ? bold(fg(tokens.text)(kindText))
            : fg(tokens.textSecondary)(kindText);
    return {
      lead: t`${pointer}   ${mark} ${fg(catColor)(catGlyph)} ${nameStyled}  ${fg(sizeColor)(size)}  `,
      ...(barW > 0
        ? {
            bar: {
              fraction: c.estimatedBytes / Math.max(1, row.project.bytes),
              color: queued ? tokens.accent : isCursor ? barStrong : barSoft,
            },
          }
        : {}),
      tail:
        failedTail ??
        t`${barW > 0 ? "  " : ""}${" ".repeat(IDLE_W)}   ${fg(riskTone)(
          padCells(riskText, riskW),
        )}${fg(tokens.textDim)(where)}`,
    };
  };

  return (
    <box width={usable + 2} height="100%" flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Direction C+ Storage Card header */}
      <box
        width={usable}
        flexDirection="column"
        flexShrink={0}
        backgroundColor={cardBg}
        paddingLeft={useCardSurface ? 1 : 0}
        paddingRight={useCardSurface ? 1 : 0}
      >
        <box height={1} width={cardInner} flexDirection="row" justifyContent="space-between">
          <text content={brand} wrapMode="none" />
          <text content={status} wrapMode="none" />
        </box>
        {props.receipt && props.selectedCount === 0 && !scanning ? (
          <ReceiptLine receipt={props.receipt} diskFree={props.diskFree} tokens={tokens} />
        ) : (
          <text content={answerLine} wrapMode="none" />
        )}
        {scanning ? (
          <ScanMeter
            width={cardInner}
            fill={tokens.info}
            track={tokens.meterTrack}
            background={cardBg}
          />
        ) : byCost.length > 0 ? (
          <StackBar
            width={cardInner}
            segments={heroSegments(byCost, costColor)}
            trackColor={tokens.meterTrack}
            dimColor={tokens.textDim}
            background={cardBg}
            isNoColor={isNoColor}
            variant="dots"
          />
        ) : (
          <text content="" />
        )}
        {showLegend ? (
          <text
            content={costLegend(byCost, costColor, tokens, cardInner, iconMode, isNoColor)}
            wrapMode="none"
          />
        ) : null}
        {showInsightRow ? <text content={insightLine} wrapMode="none" /> : null}
      </box>
      <text content="" />
      {showSearch ? (
        <>
          <box height={1} flexDirection="row">
            <text content={t`${fg(tokens.accent)("/ ")}`} wrapMode="none" />
            <box flexGrow={1} height={1}>
              <input
                focused={searchFocused}
                value={filter}
                maxLength={512}
                placeholder="project, kind:target, >100MiB, older:30d"
                backgroundColor={tokens.bg}
                focusedBackgroundColor={tokens.bg}
                textColor={tokens.text}
                placeholderColor={tokens.textDim}
                cursorColor={tokens.accent}
                onInput={props.onFilterInput}
                onSubmit={props.onFilterSubmit}
              />
            </box>
          </box>
          {advice ? (
            <text content={sanitizeTerminalText(advice)} fg={tokens.warning} wrapMode="none" />
          ) : null}
          <text content="" />
        </>
      ) : null}
      <box flexGrow={1} minHeight={0} flexDirection="row">
        <box
          width={listInner}
          flexShrink={0}
          flexDirection="column"
          onMouseScroll={(event: MouseEvent) => {
            const direction = event.scroll?.direction;
            if (direction === "up") props.onCursorDelta(-3);
            else if (direction === "down") props.onCursorDelta(3);
          }}
        >
          {shown.length === 0 ? (
            <text
              content={t`${fg(tokens.textMuted)(
                scanning
                  ? "Nothing yet. Projects appear here as they are found."
                  : filter
                    ? "No project matches. Esc clears the search."
                    : props.narrowing
                      ? `Nothing here for ${props.narrowing}. Esc clears it.`
                      : "Nothing to clean here. dist, out and coverage are opt-in: b, then p adds them.",
              )}`}
            />
          ) : (
            shown.map((row, offset) => {
              const index = top + offset;
              const parts = line(index, row);
              return (
                <box
                  key={`${index}-${row.kind}`}
                  height={1}
                  flexDirection="row"
                  backgroundColor={index === cursor ? tokens.selectionSoftBg : tokens.bg}
                  onMouseDown={(event: MouseEvent) =>
                    props.onRowPress(index, event.x - 1 <= LEAD - 1)
                  }
                >
                  <text content={parts.lead} wrapMode="none" flexShrink={0} />
                  {parts.bar ? (
                    <Meter
                      width={barW}
                      value={parts.bar.fraction}
                      fill={parts.bar.color}
                      previewColor={parts.bar.color}
                      track={null}
                      animate={false}
                      variant="blocks"
                      thickness={0.42}
                      background={index === cursor ? tokens.selectionSoftBg : tokens.bg}
                    />
                  ) : null}
                  {parts.tail ? <text content={parts.tail} wrapMode="none" flexShrink={1} /> : null}
                </box>
              );
            })
          )}
        </box>
        {panelW > 0 ? (
          <>
            <box width={PANEL_GAP} flexShrink={0} />
            <ProjectDetails
              project={focusProject}
              focusName={focusRow?.kind === "artifact" ? focusRow.candidate.name : undefined}
              selectedIds={props.selectedIds}
              tokens={tokens}
              width={panelW}
              height={room}
              now={now}
            />
          </>
        ) : null}
      </box>
      <text content={props.notice ?? ""} wrapMode="none" />
      <box height={1} flexShrink={0} flexDirection="row">
        {footer}
      </box>
    </box>
  );
}
