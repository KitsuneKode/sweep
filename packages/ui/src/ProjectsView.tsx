import { formatBytes } from "@kitsunekode/sweep-display";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { bold, fg, t, type StyledText } from "@opentui/core";
import { useRef } from "react";
import { formatAge } from "./age.js";
import { buildQueueRule } from "./LedgerBand.js";
import { concatStyled, QUEUE_GLYPH, queueState } from "./presentation.js";
import { SECTION_TITLE, type ProjectRow } from "./projects.js";
import { cellWidth, clipCells } from "./text-cells.js";

/** Pad to a width in terminal cells (CJK and emoji take two). */
function padCells(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - cellWidth(text)));
}
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
}

const MARK_COL = 4; // "› ○ " - the cursor and the checkbox

function spaced(bytes: number): string {
  return formatBytes(bytes);
}

/**
 * The calm default screen. No boxes, no column headers: a sentence that
 * answers "how much can I get back", then projects in two groups - what
 * nobody is using, and what someone is - one row each. Detail is one key away
 * and never in the way.
 */
export function ProjectsView(props: ProjectsViewProps) {
  const { tokens, width, height, rows, cursor, now, scanning, footer, filter, searchFocused } =
    props;
  // The app frame and this view each pad one cell per side.
  const inner = Math.max(20, width - 6);
  const showSearch = searchFocused || filter.length > 0;
  // Header (brand, blank, answer, meter-or-blank), search, then the list, then footer.
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

  const sizeW = 10;
  const idleW = 5;
  // Columns: name | where it lives (dim) | what it holds | size | idle.
  // The name column fits the longest name shown, up to 28 cells, so short
  // lists sit tight and long names truncate in the middle.
  const longestName = Math.max(
    8,
    ...rows.flatMap((row) => (row.kind === "project" ? [cellWidth(row.project.name)] : [])),
  );
  const nameW = Math.min(28, longestName);
  const flex = Math.max(0, inner - MARK_COL - 1 - nameW - 2 - sizeW - 2 - idleW - 2);
  const whereW = inner >= 90 ? Math.floor(flex * 0.45) : 0;
  const kindsW = Math.max(0, flex - whereW - (whereW > 0 ? 2 : 0));

  const brand = t`${bold(fg(tokens.accent)("sweep"))}  ${fg(tokens.textMuted)(
    clipCells(sanitizeTerminalText(props.target), Math.max(8, inner - 30), true),
  )}`;
  const progress = scanning
    ? t`${fg(tokens.info)(props.sizedLabel)}`
    : props.diskFree !== null
      ? t`${fg(tokens.textMuted)(`${spaced(props.diskFree)} free`)}`
      : t``;
  const modes = [props.dryRun ? "DRY RUN" : "", props.trash ? "TRASH" : ""].filter(Boolean);
  const status =
    modes.length > 0
      ? concatStyled(
          t`${bold(fg(tokens.warning)(modes.join(" · ")))}${fg(tokens.textDim)("   ")}`,
          progress,
        )
      : progress;

  const answer =
    props.selectedCount > 0
      ? t`${bold(fg(tokens.accent)(spaced(props.selectedBytes)))}${fg(tokens.text)(" queued")}${fg(
          tokens.textMuted,
        )(
          `  ·  ${props.selectedCount.toLocaleString()} item${props.selectedCount === 1 ? "" : "s"}  ·  `,
        )}${fg(tokens.text)("ctrl+enter")}${fg(tokens.textMuted)(" to review")}`
      : props.reclaimableBytes > 0 || !scanning
        ? t`${bold(fg(tokens.text)(spaced(props.reclaimableBytes)))}${fg(tokens.text)(
            " you can reclaim",
          )}${fg(tokens.textMuted)(
            `  ·  ${props.projectCount.toLocaleString()} project${props.projectCount === 1 ? "" : "s"}`,
          )}`
        : t`${fg(tokens.textMuted)("Looking for build output…")}`;
  // The easy win, named and one key away - only when it fits whole.
  const idleHint = t`${fg(tokens.textMuted)("  ·  ")}${fg(tokens.text)(spaced(props.idleBytes))}${fg(
    tokens.textMuted,
  )(" idle 30+ days, ")}${fg(tokens.accent)("i")}${fg(tokens.textMuted)(" queues it")}`;
  const styledWidth = (text: StyledText) =>
    text.chunks.reduce((sum, chunk) => sum + cellWidth(chunk.text), 0);
  const answerLine =
    props.selectedCount === 0 &&
    !scanning &&
    props.idleBytes > 0 &&
    styledWidth(answer) + styledWidth(idleHint) <= inner
      ? concatStyled(answer, idleHint)
      : answer;

  const line = (index: number, row: ProjectRow): StyledText => {
    const isCursor = index === cursor;
    const pointer = fg(tokens.accent)(isCursor ? "›" : " ");
    if (row.kind === "spacer") return t``;
    if (row.kind === "section") {
      const label = SECTION_TITLE[row.section];
      const meta = `${row.count.toLocaleString()} project${row.count === 1 ? "" : "s"}  ${spaced(row.bytes)}`;
      const gap = Math.max(1, inner - label.length - meta.length);
      return t`${bold(fg(tokens.textSecondary)(label))}${" ".repeat(gap)}${fg(tokens.textMuted)(meta)}`;
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
      // Where it lives, dimmed: worktree and package names alone are cryptic.
      const where =
        whereW > 0
          ? `  ${padCells(clipCells(sanitizeTerminalText(p.parent), whereW, true), whereW)}`
          : "";
      const name = isCursor ? bold(fg(tokens.text)(nameText)) : fg(tokens.text)(nameText);
      const kinds = clipCells(p.kinds.join(" · "), kindsW, false);
      const size = `${p.partial ? "~" : ""}${spaced(p.bytes)}`.padStart(sizeW);
      const idle = formatAge(p.activeMs, now).padStart(idleW);
      const recent = p.activeMs !== undefined && now - p.activeMs < 7 * 86_400_000;
      return t`${pointer} ${mark}  ${name}${fg(tokens.textDim)(where)}  ${fg(tokens.textMuted)(
        padCells(kinds, kindsW),
      )}  ${fg(tokens.textSecondary)(size)}  ${fg(recent ? tokens.info : tokens.textMuted)(idle)}`;
    }
    // An opened project's artifact: indented under it, risk named only when it matters.
    const c = row.candidate;
    const selectable = c.riskTier !== "blocked";
    const queued = props.selectedIds.has(c.id);
    const mark = !selectable
      ? fg(tokens.textDim)("·")
      : fg(queued ? tokens.accent : tokens.textDim)(queued ? "●" : "○");
    const risk =
      c.riskTier === "safe"
        ? ""
        : c.riskTier === "caution"
          ? fg(tokens.warning)("  caution")
          : c.riskTier === "dangerous"
            ? fg(tokens.danger)("  dangerous")
            : fg(tokens.textDim)("  blocked");
    const nameW2 = Math.max(8, inner - MARK_COL - 3 - sizeW - idleW - 12);
    // Inside a project, the path says which one: apps/web/node_modules.
    const inside = c.path.startsWith(`${row.project.key}/`)
      ? c.path.slice(row.project.key.length + 1)
      : c.name;
    const name = clipCells(sanitizeTerminalText(inside), nameW2, true);
    const size = `${c.bytesKnown === false ? "~" : ""}${spaced(c.estimatedBytes)}`.padStart(sizeW);
    const riskWidth = c.riskTier === "safe" ? 0 : c.riskTier.length + 2;
    return t`${pointer}    ${mark}  ${isCursor ? bold(fg(tokens.text)(name)) : fg(tokens.textSecondary)(name)}${risk}${" ".repeat(
      Math.max(1, inner - MARK_COL - 3 - name.length - riskWidth - sizeW - idleW - 2),
    )}${fg(tokens.textMuted)(size)}`;
  };

  return (
    <box width="100%" height="100%" flexDirection="column" paddingLeft={1} paddingRight={1}>
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
      <box flexGrow={1} flexDirection="column">
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
                onMouseDown={(event) => props.onRowPress(index, event.x - 1 <= MARK_COL)}
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
