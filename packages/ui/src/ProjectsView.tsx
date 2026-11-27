import { formatBytes } from "@kitsunekode/sweep-display";
import { IDLE_WINDOW_DAYS, sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { bold, fg, t, type MouseEvent, type StyledText } from "@opentui/core";
import { dirname } from "node:path";
import { type ReactNode, useRef } from "react";
import { formatAge, RECENT_WINDOW_MS } from "./age.js";
import { filterAdvice } from "./filter-query.js";
import { Meter, ScanMeter, StackBar, useCountUp } from "./Meter.js";
import type { StackSegment } from "./meter-draw.js";
import type { CostShare, RebuildCost } from "./project-details.js";
import { useMotionEnabled } from "./motion.js";
import { ProjectDetails } from "./ProjectDetails.js";
import { concatStyled, QUEUE_GLYPH, queueState } from "./presentation.js";
import { SECTION_TITLE, diskGainedText, type Project, type ProjectRow } from "./projects.js";
import { cellWidth, clipCells, clipStart } from "./text-cells.js";
import { mixHex, ROW_BAR_SOFT, ROW_BAR_STRONG, type ThemeTokens } from "./theme.js";

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
  /** Dangerous and blocked bytes: found, never part of the total above. */
  guardedBytes?: number | undefined;
  /** Why each item of the last removal failed, by path; shown on its row. */
  failures?: ReadonlyMap<string, string> | undefined;
  /** What the reclaimable bytes cost to bring back; the hero bar is drawn from it. */
  byCost?: readonly CostShare[] | undefined;
  /** Some sizes are still being measured (a "~" on the total). */
  partial?: boolean | undefined;
  /** The scan stopped short: whatever is shown is not the whole tree. */
  incomplete?: boolean | undefined;
  /** Safe bytes in projects idle 30+ days: the easy win, one key away. */
  idleBytes: number;
  projectCount: number;
  selectedBytes: number;
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
    if (!anyQueued) return [{ fraction: share.bytes, color: color[share.cost] }];
    const rest = share.bytes - share.queuedBytes;
    return [
      ...(share.queuedBytes > 0 ? [{ fraction: share.queuedBytes, color: color[share.cost] }] : []),
      ...(rest > 0 ? [{ fraction: rest, color: color[share.cost], dim: true }] : []),
    ];
  });
}

/** "● cache 0.4 GiB  ● install 6.0 GiB": whole entries only, as many as fit. */
function costLegend(
  byCost: readonly CostShare[],
  color: Record<RebuildCost, string>,
  tokens: ThemeTokens,
  width: number,
): StyledText {
  let out = t``;
  let used = 0;
  for (const share of byCost) {
    const label = share.cost === "unknown" ? "custom" : share.cost;
    const text = `${label} ${formatBytes(share.bytes)}`;
    const cost = (used > 0 ? 2 : 0) + 2 + cellWidth(text);
    if (used + cost > width) break;
    out = concatStyled(
      out,
      t`${used > 0 ? "  " : ""}${fg(color[share.cost])("● ")}${fg(tokens.textMuted)(text)}`,
    );
    used += cost;
  }
  return out;
}

/**
 * The success state, said once in the answer line's place: a check, the
 * bytes counting up to what came back, and the disk as it is now. A short
 * count is the delight; a removal is rare enough to earn it.
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
 * A line of this view never runs wider than this: on a wide terminal the name,
 * its size and its idle time stay within one glance instead of spreading
 * across 200 columns.
 */
const CONTENT_MAX = 104;
const LEAD = 5; // "› ○  " - cursor, checkbox, gap
const SIZE_W = 10;
const IDLE_W = 5;
const BAR_W = 8;
/** The details margin: shown once the list keeps its size bars beside it. */
const PANEL_LIST_MIN = 84;
const PANEL_MIN = 38;
const PANEL_MAX = 52;
const PANEL_GAP = 3;

/** A row in three parts, so the size bar between them can be drawn in pixels. */
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
  // As many whole names as fit, biggest first; never a name cut mid-word.
  for (let count = Math.min(2, project.kinds.length); count >= 1; count--) {
    const rest = project.kinds.length - count;
    const text = `${project.kinds.slice(0, count).join(" · ")}${rest > 0 ? ` +${rest}` : ""}`;
    if (cellWidth(text) <= width) return text;
  }
  // A one- or two-letter stub ("n…") says nothing; leave the column empty.
  return width >= 6 ? clipCells(project.kinds[0] ?? "", width) : "";
}

/**
 * The calm default screen. No boxes and no column headers. A sentence answers
 * "how much can I get back"; projects follow in two groups, what nobody is
 * using and what someone is, the biggest few of each with the rest folded.
 * Each row leads with what decides it (name, size as a number and as length,
 * idle) and trails the quiet detail (risk, where it lives, what it holds).
 */
export function ProjectsView(props: ProjectsViewProps) {
  const { tokens, width, height, rows, cursor, now, scanning, footer, filter, searchFocused } =
    props;
  // The app frame and this view each pad one cell per side. A wide terminal
  // gives the cursor's project a details margin; the list keeps its bars.
  const panelW =
    width - 6 >= PANEL_LIST_MIN + PANEL_GAP + PANEL_MIN
      ? Math.min(PANEL_MAX, width - 6 - PANEL_GAP - PANEL_LIST_MIN)
      : 0;
  const inner = Math.max(
    20,
    Math.min(CONTENT_MAX, width - 6 - (panelW > 0 ? panelW + PANEL_GAP : 0)),
  );
  const focusRow = rows[cursor];
  const focusProject = focusRow && "project" in focusRow ? focusRow.project : null;
  const showSearch = searchFocused || filter.length > 0;
  const advice = showSearch ? filterAdvice(filter) : null;
  // Header (brand, blank, answer, meter), search (+ optional advice), the list, blank, footer.
  // The cost legend under the bar is the first thing to go when height is short.
  const byCost = props.byCost ?? [];
  const showLegend = !scanning && byCost.length > 0 && height >= 20;
  const chrome = 4 + (showSearch ? (advice ? 3 : 2) : 0) + 2 + (showLegend ? 1 : 0);
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
  // Opened items sit two cells deeper, and must fit as whole names too:
  // short project names left "node_modules" clipped to "node…les".
  const longestName = Math.max(
    10,
    ...projectRows.map((project) => cellWidth(project.name)),
    ...rows.flatMap((row) => (row.kind === "artifact" ? [cellWidth(row.candidate.name) + 2] : [])),
  );
  // The size bar only where the detail keeps room to say something.
  const barW = inner >= 84 ? BAR_W : 0;
  const barGap = barW > 0 ? barW + 2 : 0;
  const nameW = Math.min(
    26,
    longestName,
    Math.max(10, inner - LEAD - SIZE_W - barGap - IDLE_W - 6),
  );
  const detailW = Math.max(0, inner - LEAD - nameW - 2 - SIZE_W - 2 - barGap - IDLE_W - 3);
  // One scale for every project row, so lengths compare down the list.
  const largest = Math.max(1, ...projectRows.map((project) => project.queueableBytes));
  // Risk is its own column when any row carries it, so what follows lines up.
  const riskColW = Math.max(
    0,
    ...projectRows.map((project) => {
      const label = riskLabel(project);
      return label ? cellWidth(label) + 2 : 0;
    }),
  );
  // The location column only when the detail has room for both; it fits the
  // longest location shown, up to just over half of what is left.
  const longestWhere = Math.max(0, ...projectRows.map((project) => cellWidth(project.parent)));
  const restW = Math.max(0, detailW - riskColW);
  const whereW = restW >= 30 ? Math.min(longestWhere, Math.floor(restW * 0.55)) : 0;
  // Bars are quiet: a step above the meter track, louder only under the cursor.
  const costColor: Record<RebuildCost, string> = {
    cache: tokens.positive,
    install: tokens.info,
    build: tokens.textSecondary,
    unknown: tokens.textMuted,
  };
  const barSoft = mixHex(tokens.meterTrack, tokens.textMuted, ROW_BAR_SOFT);
  const barStrong = mixHex(tokens.meterTrack, tokens.textMuted, ROW_BAR_STRONG);

  // ── Header ──────────────────────────────────────────────────────────────
  const modes = [props.dryRun ? "DRY RUN" : "", props.trash ? "TRASH" : ""].filter(Boolean);
  const progress = scanning
    ? t`${fg(tokens.info)(props.sizedLabel)}`
    : props.diskFree !== null
      ? t`${fg(tokens.textMuted)(`${formatBytes(props.diskFree)} free`)}`
      : t``;
  const status =
    modes.length > 0
      ? concatStyled(
          t`${bold(fg(tokens.warning)(modes.join(" · ")))}${fg(tokens.textDim)("   ")}`,
          progress,
        )
      : progress;
  const brand = t`${bold(fg(tokens.accent)("sweep"))}  ${fg(tokens.textMuted)(
    clipCells(
      sanitizeTerminalText(props.target),
      Math.max(8, inner - styledWidth(status) - 10),
      true,
    ),
  )}`;

  // A total is exact only once every size is measured and the scan finished
  // whole: until then it says "~" (or "so far"), and an incomplete scan says so.
  const approx = scanning || props.partial || props.incomplete ? "~" : "";
  const answer =
    props.selectedCount > 0
      ? t`${bold(fg(tokens.accent)(formatBytes(props.selectedBytes)))}${fg(tokens.text)(
          " queued",
        )}${fg(tokens.textMuted)(`  ·  ${plural(props.selectedCount, "item")}  ·  `)}${fg(
          tokens.text,
        )("c")}${fg(tokens.textMuted)(" to review")}`
      : props.reclaimableBytes > 0 || !scanning
        ? t`${bold(fg(tokens.text)(`${approx}${formatBytes(props.reclaimableBytes)}`))}${fg(
            tokens.text,
          )(
            scanning ? " so far" : " you can reclaim",
          )}${fg(tokens.textMuted)(`  ·  ${plural(props.projectCount, "project")}`)}`
        : t`${fg(tokens.textMuted)("Looking for build output…")}`;
  // The easy win, named and one key away - only when it fits whole.
  const idleHint = t`${fg(tokens.textMuted)("  ·  ")}${fg(tokens.text)(
    formatBytes(props.idleBytes),
  )}${fg(tokens.textMuted)(` idle ${IDLE_WINDOW_DAYS}+ days, `)}${fg(tokens.accent)("i")}${fg(
    tokens.textMuted,
  )(" queues it")}`;
  const narrowingHint = props.narrowing
    ? t`${fg(tokens.textMuted)("  ·  ")}${fg(tokens.warning)(
        clipCells(
          sanitizeTerminalText(props.narrowing),
          Math.max(8, inner - styledWidth(answer) - 14),
          true,
        ),
      )}${fg(tokens.textMuted)(" · ")}${fg(tokens.text)("esc")}${fg(tokens.textMuted)(" clears")}`
    : null;
  const guardedHint =
    props.selectedCount === 0 && !scanning && (props.guardedBytes ?? 0) > 0
      ? t`${fg(tokens.textMuted)("  ·  ")}${fg(tokens.textDim)(
          `+${formatBytes(props.guardedBytes ?? 0)} guarded`,
        )}`
      : null;
  const incompleteHint =
    props.incomplete && !scanning
      ? t`${fg(tokens.textMuted)("  ·  ")}${fg(tokens.warning)("scan incomplete")}${fg(tokens.textMuted)(" · ")}${fg(tokens.text)("r")}${fg(tokens.textMuted)(" retries")}`
      : null;
  let answerBase = answer;
  for (const extra of [incompleteHint, guardedHint, narrowingHint]) {
    if (extra && styledWidth(answerBase) + styledWidth(extra) <= inner)
      answerBase = concatStyled(answerBase, extra);
  }
  const answerLine =
    props.selectedCount === 0 &&
    !scanning &&
    props.idleBytes > 0 &&
    styledWidth(answerBase) + styledWidth(idleHint) <= inner
      ? concatStyled(answerBase, idleHint)
      : answerBase;

  // ── Rows ────────────────────────────────────────────────────────────────
  const line = (index: number, row: ProjectRow): RowParts => {
    const isCursor = index === cursor;
    const pointer = fg(tokens.accent)(isCursor ? "›" : " ");
    if (row.kind === "spacer") return { lead: t`` };
    if (row.kind === "section") {
      const label = SECTION_TITLE[row.section];
      // Whole parts drop, never characters: the count goes first, the size
      // is what the section is for.
      // Reclaimable only (safe + caution): the same number the top line uses.
      // What is guarded is named after it, never added to it.
      const size = formatBytes(row.bytes);
      const guard = row.guardedBytes > 0 ? `  ·  +${formatBytes(row.guardedBytes)} guarded` : "";
      const fits = (text: string) => cellWidth(label) + 2 + cellWidth(text) <= inner;
      const full = `${plural(row.count, "project")}  ·  ${size}`;
      const meta = fits(`${full}${guard}`)
        ? `${full}${guard}`
        : fits(full)
          ? full
          : fits(`${size}${guard}`) && guard
            ? `${size}${guard}`
            : size;
      const gap = Math.max(2, inner - cellWidth(label) - cellWidth(meta));
      return {
        lead: t`${bold(fg(tokens.textSecondary)(label))}${" ".repeat(gap)}${fg(tokens.textMuted)(meta)}`,
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
      const size = `${p.partial ? "~" : ""}${formatBytes(p.queueableBytes)}`.padStart(SIZE_W);
      const idle = formatAge(p.activeMs, now).padStart(IDLE_W);
      const recent = p.activeMs !== undefined && now - p.activeMs < RECENT_WINDOW_MS;
      // Risk leads the detail when there is any: it changes what Space does
      // (dangerous items stay out of a project-level queue) and needs a look.
      const risk = riskLabel(p);
      const where = p.parent ? sanitizeTerminalText(p.parent) : "";
      // With the details margin open, what a project holds is said there.
      const detail =
        restW <= 0
          ? ""
          : panelW > 0
            ? restW >= 16
              ? clipStart(where, restW)
              : ""
            : whereW >= 8 && restW > whereW + 6
              ? `${padCells(clipStart(where, whereW), whereW)}  ${kindSummary(p, restW - whereW - 2)}`
              : kindSummary(p, restW);
      return {
        lead: t`${pointer} ${mark}  ${name}  ${fg(tokens.textSecondary)(size)}  `,
        ...(barW > 0
          ? {
              bar: {
                fraction: p.queueableBytes / largest,
                color: state === "all" ? tokens.accent : isCursor ? barStrong : barSoft,
              },
            }
          : {}),
        tail: t`${barW > 0 ? "  " : ""}${fg(recent ? tokens.info : tokens.textMuted)(idle)}   ${fg(
          p.dangerous > 0 ? tokens.danger : tokens.warning,
        )(padCells(risk, riskColW))}${fg(tokens.textDim)(detail)}`,
      };
    }
    // An opened project's artifact: what it is under the name column, its
    // share of the project as length, and where inside the project it sits.
    const c = row.candidate;
    const queued = props.selectedIds.has(c.id);
    const mark =
      c.riskTier === "blocked"
        ? fg(tokens.textDim)("·")
        : fg(queued ? tokens.accent : tokens.textDim)(queued ? "●" : "○");
    const inside = c.path.startsWith(`${row.project.key}/`)
      ? c.path.slice(row.project.key.length + 1)
      : c.name;
    const folder = dirname(inside) === "." ? "" : sanitizeTerminalText(dirname(inside));
    const kindText = padCells(clipCells(sanitizeTerminalText(c.name), nameW - 2, true), nameW - 2);
    const size = `${c.bytesKnown === false ? "~" : ""}${formatBytes(c.estimatedBytes)}`.padStart(
      SIZE_W,
    );
    const riskText = c.riskTier === "safe" ? "" : c.riskTier;
    const riskTone =
      c.riskTier === "dangerous"
        ? tokens.danger
        : c.riskTier === "caution"
          ? tokens.warning
          : tokens.textDim;
    // One risk column per opened project, so the folders line up under it.
    const riskW = row.project.artifacts.some((a) => a.riskTier === "dangerous")
      ? 11
      : row.project.artifacts.some((a) => a.riskTier !== "safe")
        ? 9
        : 0;
    const where = clipStart(folder, Math.max(0, detailW - riskW));
    // A removal that failed says why on its own row, until the next apply.
    const failure = props.failures?.get(c.path);
    const failedTail = failure
      ? t`${barW > 0 ? "  " : ""}${fg(tokens.danger)(
          `✗ ${clipCells(sanitizeTerminalText(failure), Math.max(8, detailW + IDLE_W - 2), true)}`,
        )}`
      : null;
    return {
      lead: t`${pointer}   ${mark}  ${
        isCursor ? bold(fg(tokens.text)(kindText)) : fg(tokens.textSecondary)(kindText)
      }  ${fg(tokens.textMuted)(size)}  `,
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
    <box
      width={inner + 2 + (panelW > 0 ? panelW + PANEL_GAP : 0)}
      height="100%"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box height={1} width={inner} flexDirection="row" justifyContent="space-between">
        <text content={brand} wrapMode="none" />
        <text content={status} wrapMode="none" />
      </box>
      <text content="" />
      {props.receipt && props.selectedCount === 0 && !scanning ? (
        <ReceiptLine receipt={props.receipt} diskFree={props.diskFree} tokens={tokens} />
      ) : (
        <text content={answerLine} wrapMode="none" />
      )}
      {scanning ? (
        // The end of a scan is unknown until it arrives: the bar glides and
        // claims no fraction; "N of M sized" above is the only number.
        <ScanMeter
          width={inner}
          fill={tokens.info}
          track={tokens.meterTrack}
          background={tokens.bg}
        />
      ) : byCost.length > 0 ? (
        // Done scanning: where the space is, by what it costs to get back.
        // Once something is queued, the queued share of each part is solid and
        // the rest recedes, so one bar says what is there and what is chosen.
        // It follows the keyboard, so it changes at once and never eases.
        <StackBar width={inner} segments={heroSegments(byCost, costColor)} background={tokens.bg} />
      ) : (
        <text content="" />
      )}
      {showLegend ? (
        <text content={costLegend(byCost, costColor, tokens, inner)} wrapMode="none" />
      ) : null}
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
          width={inner}
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
                      // Kitty fills an image's clear pixels with the terminal's
                      // colour, so the bar carries the row's own behind it.
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
