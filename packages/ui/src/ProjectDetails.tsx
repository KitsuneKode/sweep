import { basename, dirname } from "node:path";
import { formatBytes } from "@kitsunekode/sweep-display";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { bold, fg, type StyledText, t } from "@opentui/core";
import { describeAge, isRecent } from "./age.js";
import { StackBar } from "./Meter.js";
import { categoryGlyph, concatStyled, resolveIconMode } from "./presentation.js";
import { projectFacts, type RebuildCost } from "./project-details.js";
import { WORKTREE_STATE_DETAIL, type Project } from "./projects.js";
import { compactBytesLabel } from "./sidebar.js";
import { cellWidth, clipCells, clipStart } from "./text-cells.js";
import { costColors, type ThemeTokens } from "./theme.js";

const LABEL_W = 11;

const COST_NOCOLOR_GLYPH: Record<RebuildCost, string> = {
  cache: "⣿",
  install: "⣶",
  build: "⣤",
  unknown: "⠒",
};

/**
 * Direction C+ details margin beside the project list on >= 120-col terminals:
 * project location, glacier-cyan recent age, git branch/worktree state,
 * dithered rebuild-cost dot bar, and a boxed inner artifact list with colored
 * 1-cell category icons, distinct rebuild-cost hues, and tabular binary sizes.
 */
export function ProjectDetails({
  project,
  focusName,
  selectedIds,
  tokens,
  width,
  height,
  now,
}: {
  project: Project | null;
  /** The artifact under the cursor, when it is one: its kind is lifted. */
  focusName?: string | undefined;
  selectedIds: ReadonlySet<string>;
  tokens: ThemeTokens;
  width: number;
  height: number;
  now: number;
}) {
  const isNoColor = Boolean(process.env.NO_COLOR);
  const iconMode = resolveIconMode();
  const inner = Math.max(10, width - 3);
  if (!project) {
    return (
      <Margin tokens={tokens} width={width} height={height}>
        <text content={t`${fg(tokens.textDim)("Move onto a project for its details.")}`} />
      </Margin>
    );
  }
  const facts = projectFacts(project, selectedIds);
  const home = process.env.HOME;
  const parent = dirname(project.key);
  const where = home && parent.startsWith(`${home}/`) ? `~${parent.slice(home.length)}` : parent;
  const field = (label: string, value: StyledText) => (
    <text
      key={label}
      content={concatStyled(t`${fg(tokens.textDim)(label.padEnd(LABEL_W))}`, value)}
      wrapMode="none"
    />
  );
  const costColor = costColors(tokens);
  const queuedCount = facts.groups.reduce((sum, group) => sum + group.queued, 0);
  const age = describeAge(project.activeMs, now);
  const recent = isRecent(project.activeMs, now);

  const risk =
    project.dangerous > 0
      ? `✗ ${project.dangerous} dangerous, never queued by a project`
      : project.caution > 0
        ? `! ${project.caution} caution: enter on one says why`
        : "";
  const worktreeRepo =
    project.worktreeOf !== undefined
      ? sanitizeTerminalText(basename(project.worktreeOf) || project.worktreeOf)
      : undefined;
  const worktreeNote =
    project.worktreeState !== undefined ? WORKTREE_STATE_DETAIL[project.worktreeState] : undefined;

  // Boxed inner list needs 2 frame lines + 2 lines per kind (+1 divider between kinds).
  const fixed = 12 + (worktreeRepo ? 1 : 0) + (worktreeNote ? 1 : 0) + (risk ? 2 : 0);
  const fit = Math.max(1, Math.floor((height - fixed) / 3));
  const groups = facts.groups.slice(0, fit);

  const costOrder: RebuildCost[] = ["cache", "install", "build", "unknown"];
  const byCost = costOrder
    .map((cost) => ({
      cost,
      bytes: facts.groups
        .filter((group) => group.rebuild.cost === cost)
        .reduce((sum, group) => sum + group.bytes, 0),
    }))
    .filter((entry) => entry.bytes > 0);
  const hidden = facts.groups.length - groups.length;

  // Rest on a kind and its share of the bar stays lit while others recede.
  const focusCost = facts.groups.find((group) => group.name === focusName)?.rebuild.cost;
  const focused =
    focusCost === undefined ? -1 : byCost.findIndex((entry) => entry.cost === focusCost);

  const boxW = inner;
  const boxInner = Math.max(8, boxW - 4);
  const boxTitle = ` ${formatBytes(project.queueableBytes)} reclaimable `;
  const boxTitleClipped = clipCells(boxTitle, Math.max(4, boxW - 4));
  const boxTopTail = Math.max(1, boxW - 3 - cellWidth(boxTitleClipped));

  const renderDetailsLegend = (): StyledText => {
    const build = (compact: boolean): StyledText => {
      let out = t``;
      let used = 0;
      byCost.forEach((entry, index) => {
        const label = entry.cost === "unknown" ? "custom" : entry.cost;
        const glyph = categoryGlyph(entry.cost, iconMode, isNoColor);
        const bytesText = compact ? compactBytesLabel(entry.bytes) : formatBytes(entry.bytes);
        const part = `${label} ${bytesText}`;
        const gap = used > 0 ? 2 : 0;
        const step = gap + cellWidth(glyph) + 1 + cellWidth(part);
        if (used + step > inner && used > 0) return;
        const isLit = index === focused;
        out = concatStyled(
          out,
          t`${gap > 0 ? "  " : ""}${fg(costColor[entry.cost])(glyph)} `,
          isLit ? t`${bold(fg(tokens.text)(part))}` : t`${fg(tokens.textSecondary)(part)}`,
        );
        used += step;
      });
      return out;
    };
    const fullNeeded = byCost.reduce(
      (sum, entry, i) =>
        sum +
        (i > 0 ? 2 : 0) +
        2 +
        cellWidth(
          `${entry.cost === "unknown" ? "custom" : entry.cost} ${formatBytes(entry.bytes)}`,
        ),
      0,
    );
    return build(fullNeeded > inner);
  };

  return (
    <Margin tokens={tokens} width={width} height={height}>
      <text
        content={t`${bold(fg(tokens.text)(clipCells(sanitizeTerminalText(project.name), inner, true)))}`}
        wrapMode="none"
      />
      <text
        content={t`${fg(tokens.textMuted)(`in ${clipStart(sanitizeTerminalText(where), inner - 3)}`)}`}
        wrapMode="none"
      />
      <text content="" />
      {field("worked on", t`${fg(recent ? tokens.info : tokens.text)(age || "unknown")}`)}
      {facts.branch === null
        ? field("git", t`${fg(tokens.textMuted)("not a repository")}`)
        : field(
            "branch",
            t`${fg(tokens.text)(clipCells(sanitizeTerminalText(facts.branch) || "linked work tree", inner - LABEL_W, true))}`,
          )}
      {worktreeRepo
        ? field("worktree", t`${fg(tokens.text)(clipCells(worktreeRepo, inner - LABEL_W, true))}`)
        : null}
      {worktreeNote ? (
        <text
          content={t`${fg(project.worktreeState === "upstream_gone" ? tokens.warning : tokens.positive)(clipCells(worktreeNote, inner, true))}`}
          wrapMode="none"
        />
      ) : null}
      {field(
        "queued",
        queuedCount > 0
          ? t`${fg(tokens.accent)(formatBytes(facts.queuedBytes))}${fg(tokens.textMuted)(
              `  ${queuedCount} of ${project.artifacts.length}`,
            )}`
          : t`${fg(tokens.textMuted)(`nothing of ${project.artifacts.length}`)}`,
      )}
      <text content="" />
      <StackBar
        width={inner}
        segments={byCost.map((entry, index) => ({
          fraction: entry.bytes,
          color: costColor[entry.cost],
          noColorGlyph: COST_NOCOLOR_GLYPH[entry.cost],
          ...(focused >= 0 && index !== focused ? { dim: true } : {}),
        }))}
        trackColor={tokens.meterTrack}
        dimColor={tokens.textDim}
        background={tokens.surface}
        isNoColor={isNoColor}
        variant="dots"
      />
      <text content={renderDetailsLegend()} wrapMode="none" />
      <text content="" />
      {/* Boxed inner artifact list (Direction C+ concentric card style) */}
      <text
        content={t`${fg(tokens.border)("┌─")}${fg(tokens.textSecondary)(boxTitleClipped)}${fg(tokens.border)(`${"─".repeat(boxTopTail)}┐`)}`}
        wrapMode="none"
      />
      {groups.map((group, idx) => {
        const lifted = group.name === focusName;
        const sizeStr = formatBytes(group.bytes);
        const glyph = categoryGlyph(group.rebuild.cost, iconMode, isNoColor);
        const nameBudget = Math.max(4, boxInner - cellWidth(sizeStr) - 3);
        const name = clipCells(sanitizeTerminalText(group.name), nameBudget, true);
        const nameGap = Math.max(1, boxInner - 2 - cellWidth(name) - cellWidth(sizeStr));
        const costLabel = group.rebuild.cost === "unknown" ? "custom" : group.rebuild.cost;
        const howRaw = `${group.count > 1 ? `${group.count}× · ` : ""}${group.rebuild.how}`;
        const howBudget = Math.max(0, boxInner - 2 - cellWidth(costLabel) - 2);
        const how = howBudget >= 4 ? clipCells(howRaw, howBudget, true) : "";
        const subTextLen = 2 + cellWidth(costLabel) + (how ? 2 + cellWidth(how) : 0);
        const subGap = Math.max(0, boxInner - subTextLen);
        return (
          <box key={group.name} flexDirection="column" flexShrink={0}>
            {idx > 0 ? (
              <text
                content={t`${fg(tokens.border)(`├${"─".repeat(Math.max(2, boxW - 2))}┤`)}`}
                wrapMode="none"
              />
            ) : null}
            <text
              content={t`${fg(tokens.border)("│ ")}${fg(group.queued > 0 ? tokens.accent : costColor[group.rebuild.cost])(group.queued > 0 ? "●" : glyph)} ${lifted ? bold(fg(tokens.text)(name)) : fg(tokens.text)(name)}${" ".repeat(nameGap)}${fg(group.queued > 0 ? tokens.accent : tokens.textSecondary)(sizeStr)}${fg(tokens.border)(" │")}`}
              wrapMode="none"
            />
            <text
              content={t`${fg(tokens.border)("│ ")}  ${fg(costColor[group.rebuild.cost])(costLabel)}${how ? fg(tokens.textDim)(`  ${how}`) : ""}${" ".repeat(subGap)}${fg(tokens.border)(" │")}`}
              wrapMode="none"
            />
          </box>
        );
      })}
      <text
        content={t`${fg(tokens.border)(`└${"─".repeat(Math.max(2, boxW - 2))}┘`)}`}
        wrapMode="none"
      />
      {hidden > 0 ? (
        <text content={t`${fg(tokens.textDim)(`+ ${hidden} more kinds`)}`} wrapMode="none" />
      ) : null}
      {project.guardedBytes > 0 ? (
        <text
          content={t`${fg(tokens.warning)(
            clipCells(
              `+${project.guardedPartial ? "~" : ""}${formatBytes(project.guardedBytes)} guarded (excluded)`,
              inner,
              true,
            ),
          )}`}
          wrapMode="none"
        />
      ) : null}
      {risk ? (
        <text
          content={t`${fg(project.dangerous > 0 ? tokens.danger : tokens.warning)(clipCells(risk, inner, true))}`}
          wrapMode="none"
        />
      ) : null}
    </Margin>
  );
}

function Margin({
  tokens,
  width,
  height,
  children,
}: {
  tokens: ThemeTokens;
  width: number;
  height: number;
  children: React.ReactNode;
}) {
  return (
    <box
      width={width}
      height={height}
      flexShrink={0}
      flexDirection="column"
      paddingLeft={2}
      border={["left"]}
      borderStyle="single"
      borderColor={tokens.border}
      backgroundColor={tokens.surface}
      overflow="hidden"
    >
      {children}
    </box>
  );
}
