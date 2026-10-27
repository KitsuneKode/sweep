import { dirname } from "node:path";
import { formatBytes } from "@kitsunekode/sweep-display";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { bold, fg, type StyledText, t } from "@opentui/core";
import { concatStyled } from "./presentation.js";
import { describeAge } from "./age.js";
import { Meter, StackBar } from "./Meter.js";
import { projectFacts, type RebuildCost } from "./project-details.js";
import type { Project } from "./projects.js";
import { cellWidth, clipCells, clipStart } from "./text-cells.js";
import { mixHex, type ThemeTokens } from "./theme.js";

const LABEL_W = 11;
const BAR_W = 6;

/**
 * The cursor's project, beside the list on a wide terminal: where it lives,
 * when it was last worked on, which branch, and per kind of artifact what it
 * weighs and what bringing it back costs. Read-only and quiet: no border, one
 * hairline rule on its left edge so it reads as a margin note, not a pane.
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
  // The name is the line above; this says where it lives.
  const parent = dirname(project.key);
  const where = home && parent.startsWith(`${home}/`) ? `~${parent.slice(home.length)}` : parent;
  const field = (label: string, value: StyledText) => (
    <text
      key={label}
      content={concatStyled(t`${fg(tokens.textDim)(label.padEnd(LABEL_W))}`, value)}
      wrapMode="none"
    />
  );
  const costColor: Record<RebuildCost, string> = {
    cache: tokens.positive,
    install: tokens.info,
    build: tokens.textSecondary,
    unknown: tokens.textMuted,
  };
  const barColor = mixHex(tokens.meterTrack, tokens.textMuted, 0.6);
  const queuedCount = facts.groups.reduce((sum, group) => sum + group.queued, 0);
  const age = describeAge(project.activeMs, now);

  // Header (name, path, blank, three fields, blank, title) is 8 lines; each
  // kind takes two, and the risk note one more with its gap.
  const risk =
    project.dangerous > 0
      ? `✗ ${project.dangerous} dangerous, never queued by a project`
      : project.caution > 0
        ? `! ${project.caution} caution: enter on one says why`
        : "";
  // The stack bar, its key and a breath after it add three lines.
  const fixed = 11 + (risk ? 2 : 0);
  const fit = Math.max(1, Math.floor((height - fixed) / 2));
  const groups = facts.groups.slice(0, fit);
  // Cheapest to bring back first, so the left of the bar is the easy win.
  const costOrder: RebuildCost[] = ["cache", "install", "build", "unknown"];
  const byCost = costOrder
    .map((cost) => ({
      cost,
      bytes: facts.groups
        .filter((group) => group.rebuild.cost === cost)
        .reduce((sum, group) => sum + group.bytes, 0),
    }))
    .filter((entry) => entry.bytes > 0);
  const costKey = byCost.map(
    (entry) => `${entry.cost === "unknown" ? "custom" : entry.cost} ${formatBytes(entry.bytes)}`,
  );
  const hidden = facts.groups.length - groups.length;

  return (
    <Margin tokens={tokens} width={width} height={height}>
      <text
        content={t`${bold(fg(tokens.text)(clipCells(sanitizeTerminalText(project.name), inner, true)))}`}
        wrapMode="none"
      />
      <text
        content={t`${fg(tokens.textMuted)(clipStart(`in ${sanitizeTerminalText(where)}`, inner))}`}
        wrapMode="none"
      />
      <text content="" />
      {field("worked on", t`${fg(tokens.text)(age || "unknown")}`)}
      {facts.branch === null
        ? field("git", t`${fg(tokens.textMuted)("not a repository")}`)
        : field(
            "branch",
            t`${fg(tokens.text)(clipCells(facts.branch || "linked work tree", inner - LABEL_W, true))}`,
          )}
      {field(
        "queued",
        queuedCount > 0
          ? t`${fg(tokens.accent)(formatBytes(facts.queuedBytes))}${fg(tokens.textMuted)(
              `  ${queuedCount} of ${project.artifacts.length}`,
            )}`
          : t`${fg(tokens.textMuted)(`nothing of ${project.artifacts.length}`)}`,
      )}
      <text content="" />
      <text
        content={t`${fg(tokens.textSecondary)(`${formatBytes(project.bytes)} in ${project.artifacts.length} item${project.artifacts.length === 1 ? "" : "s"}`)}`}
        wrapMode="none"
      />
      <StackBar
        width={inner}
        segments={byCost.map((entry) => ({ fraction: entry.bytes, color: costColor[entry.cost] }))}
        background={tokens.bg}
      />
      <text
        content={concatStyled(
          ...byCost.flatMap((entry, index) => [
            t`${fg(tokens.textDim)(index > 0 ? "  " : "")}`,
            t`${fg(costColor[entry.cost])(costKey[index] ?? "")}`,
          ]),
        )}
        wrapMode="none"
      />
      <text content="" />
      {groups.map((group) => {
        const lifted = group.name === focusName;
        const nameW = Math.max(6, inner - BAR_W - 2 - 11);
        const name = clipCells(sanitizeTerminalText(group.name), nameW, true);
        const size = formatBytes(group.bytes).padStart(10);
        return (
          <box key={group.name} flexDirection="column" flexShrink={0}>
            <box height={1} flexDirection="row">
              <Meter
                width={BAR_W}
                value={project.bytes > 0 ? group.bytes / project.bytes : 0}
                fill={lifted ? tokens.textSecondary : barColor}
                previewColor={barColor}
                track={null}
                animate={false}
                variant="blocks"
                thickness={0.42}
                background={tokens.bg}
              />
              <text
                content={t`  ${lifted ? bold(fg(tokens.text)(name)) : fg(tokens.textSecondary)(name)}${" ".repeat(
                  Math.max(1, nameW - cellWidth(name)),
                )}${fg(tokens.textSecondary)(size)}`}
                wrapMode="none"
              />
            </box>
            <text
              content={t`${" ".repeat(BAR_W + 2)}${fg(costColor[group.rebuild.cost])(group.rebuild.cost === "unknown" ? "custom" : group.rebuild.cost)}${fg(
                tokens.textDim,
              )(
                `  ${clipCells(
                  `${group.count > 1 ? `${group.count}× · ` : ""}${group.rebuild.how}`,
                  Math.max(4, inner - BAR_W - 4 - group.rebuild.cost.length),
                  true,
                )}`,
              )}`}
              wrapMode="none"
            />
          </box>
        );
      })}
      {hidden > 0 ? (
        <text
          content={t`${fg(tokens.textDim)(`${" ".repeat(BAR_W + 2)}+ ${hidden} more kinds`)}`}
        />
      ) : null}
      {risk ? <text content="" /> : null}
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
      overflow="hidden"
    >
      {children}
    </box>
  );
}
