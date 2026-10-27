import { formatBytes } from "@kitsunekode/sweep-display";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { bold, fg, t, type MouseEvent, type StyledText } from "@opentui/core";
import { useRef } from "react";
import { formatAge } from "./age.js";
import { buildQueueRule } from "./LedgerBand.js";
import { concatStyled, QUEUE_GLYPH, queueState } from "./presentation.js";
import { SECTION_TITLE, type Project, type ProjectRow } from "./projects.js";
import { cellWidth, clipCells, clipStart } from "./text-cells.js";
import type { ThemeTokens } from "./theme.js";

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
  sizedFraction: number;
  sizedLabel: string;
  reclaimableBytes: number;
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
  /** One line under the list: a notice when there is one, else the key hints. */
  footer: StyledText;
  onFilterInput: (value: string) => void;
  onFilterSubmit: () => void;
  onRowPress: (index: number, onMark: boolean) => void;
  /** Wheel moves the cursor, never the viewport alone (ux-principles). */
  onCursorDelta: (delta: number) => void;
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
const RECENT_MS = 7 * 86_400_000;

function padCells(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - cellWidth(text)));
}
function styledWidth(text: StyledText): number {
  return text.chunks.reduce((sum, chunk) => sum + cellWidth(chunk.text), 0);
}
function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}
/** "node_modules · .next +2": the biggest two, then how many more. */
function kindSummary(project: Project, width: number): string {
  // As many whole names as fit, biggest first; never a name cut mid-word.
  for (let count = Math.min(2, project.kinds.length); count >= 1; count--) {
    const rest = project.kinds.length - count;
    const text = `${project.kinds.slice(0, count).join(" · ")}${rest > 0 ? ` +${rest}` : ""}`;
    if (cellWidth(text) <= width) return text;
  }
  return clipCells(project.kinds[0] ?? "", width);
}

/**
 * The calm default screen. No boxes and no column headers. A sentence answers
 * "how much can I get back"; projects follow in two groups, what nobody is
 * using and what someone is, the biggest few of each with the rest folded.
 * Each row leads with what decides it (name, size, idle) and trails the
 * quiet detail (where it lives, what it holds).
 */
export function ProjectsView(props: ProjectsViewProps) {
  const { tokens, width, height, rows, cursor, now, scanning, footer, filter, searchFocused } =
    props;
  // The app frame and this view each pad one cell per side.
  const inner = Math.max(20, Math.min(CONTENT_MAX, width - 6));
  const showSearch = searchFocused || filter.length > 0;
  // Header (brand, blank, answer, meter-or-blank), search, the list, blank, footer.
  const chrome = 4 + (showSearch ? 2 : 0) + 2;
  const room = Math.max(3, height - chrome);

  // Keep the cursor in view without jumping the page on every move.
  const topRef = useRef(0);
  let top = topRef.current;
  if (cursor < top + 1) top = Math.max(0, cursor - 1);
  if (cursor > top + room - 2) top = Math.min(Math.max(0, rows.length - room), cursor - room + 2);
  top = Math.max(0, Math.min(top, Math.max(0, rows.length - room)));
  topRef.current = top;
  const shown = rows.slice(top, top + room);

  const longestName = Math.max(
    10,
    ...rows.flatMap((row) => (row.kind === "project" ? [cellWidth(row.project.name)] : [])),
  );
  const nameW = Math.min(26, longestName, Math.max(10, inner - LEAD - SIZE_W - IDLE_W - 6));
  const detailW = Math.max(0, inner - LEAD - nameW - 2 - SIZE_W - 2 - IDLE_W - 3);
  // The location column only when the detail has room for both; it fits the
  // longest location shown, up to just over half the detail.
  const longestWhere = Math.max(
    0,
    ...rows.flatMap((row) => (row.kind === "project" ? [cellWidth(row.project.parent)] : [])),
  );
  const whereW = detailW >= 36 ? Math.min(longestWhere, Math.floor(detailW * 0.55)) : 0;

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

  const answer =
    props.selectedCount > 0
      ? t`${bold(fg(tokens.accent)(formatBytes(props.selectedBytes)))}${fg(tokens.text)(
          " queued",
        )}${fg(tokens.textMuted)(`  ·  ${plural(props.selectedCount, "item")}  ·  `)}${fg(
          tokens.text,
        )("ctrl+enter")}${fg(tokens.textMuted)(" to review")}`
      : props.reclaimableBytes > 0 || !scanning
        ? t`${bold(fg(tokens.text)(formatBytes(props.reclaimableBytes)))}${fg(tokens.text)(
            " you can reclaim",
          )}${fg(tokens.textMuted)(`  ·  ${plural(props.projectCount, "project")}`)}`
        : t`${fg(tokens.textMuted)("Looking for build output…")}`;
  // The easy win, named and one key away - only when it fits whole.
  const idleHint = t`${fg(tokens.textMuted)("  ·  ")}${fg(tokens.text)(
    formatBytes(props.idleBytes),
  )}${fg(tokens.textMuted)(" idle 30+ days, ")}${fg(tokens.accent)("i")}${fg(tokens.textMuted)(
    " queues it",
  )}`;
  const answerLine =
    props.selectedCount === 0 &&
    !scanning &&
    props.idleBytes > 0 &&
    styledWidth(answer) + styledWidth(idleHint) <= inner
      ? concatStyled(answer, idleHint)
      : answer;

  // ── Rows ────────────────────────────────────────────────────────────────
  const line = (index: number, row: ProjectRow): StyledText => {
    const isCursor = index === cursor;
    const pointer = fg(tokens.accent)(isCursor ? "›" : " ");
    if (row.kind === "spacer") return t``;
    if (row.kind === "section") {
      const label = SECTION_TITLE[row.section];
      const meta = `${plural(row.count, "project")}  ·  ${formatBytes(row.bytes)}`;
      const gap = Math.max(2, inner - cellWidth(label) - cellWidth(meta));
      return t`${bold(fg(tokens.textSecondary)(label))}${" ".repeat(gap)}${fg(tokens.textMuted)(meta)}`;
    }
    if (row.kind === "more") {
      const label = `+ ${plural(row.count, "more project")}  ·  ${formatBytes(row.bytes)}`;
      return t`${pointer}    ${fg(tokens.textMuted)(label)}${fg(tokens.textDim)(
        isCursor ? "   enter shows them" : "",
      )}`;
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
      const size = `${p.partial ? "~" : ""}${formatBytes(p.bytes)}`.padStart(SIZE_W);
      const idle = formatAge(p.activeMs, now).padStart(IDLE_W);
      const recent = p.activeMs !== undefined && now - p.activeMs < RECENT_MS;
      // Quiet detail: the specific end of where it lives, then what it holds.
      // One fixed location column so the kinds line up down the list.
      const where = p.parent ? sanitizeTerminalText(p.parent) : "";
      // Risk leads the detail when there is any: it changes what Space does
      // (dangerous items stay out of a project-level queue) and needs a look.
      const riskText =
        p.dangerous > 0
          ? `✗ ${p.dangerous} dangerous`
          : p.caution > 0
            ? `! ${p.caution} caution`
            : "";
      const riskColor = p.dangerous > 0 ? tokens.danger : tokens.warning;
      const riskW = riskText ? cellWidth(riskText) + 2 : 0;
      const restW = Math.max(0, detailW - riskW);
      const detail =
        restW <= 0
          ? ""
          : whereW >= 8 && restW > whereW + 6
            ? `${padCells(clipStart(where, whereW), whereW)}  ${kindSummary(p, restW - whereW - 2)}`
            : kindSummary(p, restW);
      return t`${pointer} ${mark}  ${name}  ${fg(tokens.textSecondary)(size)}  ${fg(
        recent ? tokens.info : tokens.textMuted,
      )(idle)}   ${fg(riskColor)(riskText ? `${riskText}  ` : "")}${fg(tokens.textDim)(detail)}`;
    }
    // An opened project's artifact: the path inside it, under the name column.
    const c = row.candidate;
    const queued = props.selectedIds.has(c.id);
    const mark =
      c.riskTier === "blocked"
        ? fg(tokens.textDim)("·")
        : fg(queued ? tokens.accent : tokens.textDim)(queued ? "●" : "○");
    const inside = c.path.startsWith(`${row.project.key}/`)
      ? c.path.slice(row.project.key.length + 1)
      : c.name;
    const pathText = padCells(clipCells(sanitizeTerminalText(inside), nameW - 2, true), nameW - 2);
    const size = `${c.bytesKnown === false ? "~" : ""}${formatBytes(c.estimatedBytes)}`.padStart(
      SIZE_W,
    );
    const risk =
      c.riskTier === "safe"
        ? fg(tokens.textDim)("")
        : c.riskTier === "caution"
          ? fg(tokens.warning)("caution")
          : c.riskTier === "dangerous"
            ? fg(tokens.danger)("dangerous")
            : fg(tokens.textDim)("blocked · never removed");
    return t`${pointer}   ${mark}  ${
      isCursor ? bold(fg(tokens.text)(pathText)) : fg(tokens.textSecondary)(pathText)
    }  ${fg(tokens.textMuted)(size)}  ${" ".repeat(IDLE_W)}   ${risk}`;
  };

  return (
    <box width={inner + 2} height="100%" flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text content={brand} wrapMode="none" />
        <text content={status} wrapMode="none" />
      </box>
      <text content="" />
      <text content={answerLine} wrapMode="none" />
      {scanning ? (
        <text
          content={buildQueueRule(props.sizedFraction, 1, inner, tokens.info, tokens.borderSoft)}
          wrapMode="none"
        />
      ) : (
        <text content="" />
      )}
      {showSearch ? (
        <>
          <box height={1} flexDirection="row">
            <text content={t`${fg(tokens.accent)("/ ")}`} wrapMode="none" />
            <box flexGrow={1} height={1}>
              <input
                focused={searchFocused}
                value={filter}
                maxLength={512}
                placeholder="project, kind:target, >100MiB, idle:30d"
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
          <text content="" />
        </>
      ) : null}
      <box
        flexGrow={1}
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
                  : "Nothing to clean here.",
            )}`}
          />
        ) : (
          shown.map((row, offset) => {
            const index = top + offset;
            return (
              <box
                key={`${index}-${row.kind}`}
                height={1}
                backgroundColor={index === cursor ? tokens.selectionSoftBg : tokens.bg}
                onMouseDown={(event: MouseEvent) =>
                  props.onRowPress(index, event.x - 1 <= LEAD - 1)
                }
              >
                <text content={line(index, row)} wrapMode="none" />
              </box>
            );
          })
        )}
      </box>
      <text content="" />
      <text content={footer} wrapMode="none" />
    </box>
  );
}
