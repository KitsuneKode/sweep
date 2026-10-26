import { formatBytes } from "@kitsunekode/sweep-display";
import { bold, fg, t } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { ActionButton } from "./ActionButton.js";
import {
  FACET_GROUP_LABEL,
  isFacetActive,
  type FacetOption,
  type FacetState,
  type FacetTally,
} from "./filter-facets.js";
import { keycap, riskGlyph } from "./presentation.js";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { clipCells } from "./text-cells.js";
import { riskColor, type ThemeTokens } from "./theme.js";
import { Modal } from "./widgets.js";

type Line =
  | { kind: "section"; label: string }
  | { kind: "option"; index: number; option: FacetOption };

const WIDTH = 60;

export interface FilterPickerProps {
  tokens: ThemeTokens;
  options: readonly FacetOption[];
  tallies: readonly FacetTally[];
  facets: FacetState;
  cursor: number;
  matched: { count: number; total: number; bytes: number };
  onToggle: (index: number) => void;
  onClear: () => void;
  onClose: () => void;
}

/**
 * Facets chosen from a list, the way a CRM filter menu works: every option
 * shows what it alone would match, and the top line answers what the whole
 * filter catches now. Toggling writes the same terms the `/` box accepts.
 */
export function FilterPicker({
  tokens,
  options,
  tallies,
  facets,
  cursor,
  matched,
  onToggle,
  onClear,
  onClose,
}: FilterPickerProps) {
  const { height } = useTerminalDimensions();
  const colors = riskColor(tokens);

  const lines: Line[] = [];
  options.forEach((option, index) => {
    if (index === 0 || options[index - 1]!.group !== option.group) {
      lines.push({ kind: "section", label: FACET_GROUP_LABEL[option.group] });
    }
    lines.push({ kind: "option", index, option });
  });

  // Window the list around the cursor so it never leaves the card, whatever
  // the terminal height. Chrome: border, padding, summary, footer.
  const room = Math.max(4, height - 12);
  const cursorLine = lines.findIndex((line) => line.kind === "option" && line.index === cursor);
  const start = Math.max(0, Math.min(cursorLine - Math.floor(room / 2), lines.length - room));
  const shown = lines.slice(start, start + room);
  const inner = WIDTH - 8;
  const labelWidth = inner - 24;

  const summary =
    matched.count === 0
      ? t`${fg(tokens.warning)("no matches")}${fg(tokens.textDim)(" · loosen a facet")}`
      : t`${bold(fg(tokens.text)(matched.count.toLocaleString()))}${fg(tokens.textMuted)(
          ` of ${matched.total.toLocaleString()} match · `,
        )}${bold(fg(tokens.accent)(formatBytes(matched.bytes)))}`;

  return (
    <Modal
      tokens={tokens}
      title=" filter "
      width={WIDTH}
      height={Math.min(height - 2, shown.length + 9)}
      footer={
        <box flexDirection="column">
          <text
            content={t`${keycap("space", tokens)} ${fg(tokens.textMuted)("toggle")}  ${keycap("c", tokens)} ${fg(tokens.textMuted)("clear")}  ${keycap("enter", tokens)} ${fg(tokens.textMuted)("done")}`}
            wrapMode="none"
          />
          <box flexDirection="row" gap={1}>
            <ActionButton tokens={tokens} label="Clear facets" onPress={onClear} />
            <ActionButton tokens={tokens} label="Done" primary onPress={onClose} />
          </box>
        </box>
      }
    >
      <text content={summary} wrapMode="none" />
      <text content="" />
      {shown.map((line) => {
        if (line.kind === "section") {
          return (
            <text
              key={`s-${line.label}`}
              content={t`${bold(fg(tokens.textSecondary)(line.label.toUpperCase()))}`}
              wrapMode="none"
            />
          );
        }
        const { option, index } = line;
        const active = isFacetActive(facets, option);
        const current = index === cursor;
        const tally = tallies[index] ?? { count: 0, bytes: 0 };
        const empty = tally.count === 0 && !active;
        const glyph =
          option.group === "risk"
            ? fg(colors[option.value as keyof typeof colors] ?? tokens.textMuted)(
                `${riskGlyph[option.value as keyof typeof riskGlyph] ?? " "} `,
              )
            : fg(tokens.textDim)("");
        // Risk rows spend two cells on their glyph; the columns stay aligned.
        const width = option.group === "risk" ? labelWidth - 2 : labelWidth;
        const label = clipCells(sanitizeTerminalText(option.label), width, false).padEnd(width);
        const labelColor = empty ? tokens.textDim : active ? tokens.text : tokens.textSecondary;
        return (
          <box
            key={`o-${option.group}-${option.value}`}
            height={1}
            backgroundColor={current ? tokens.selectionBg : tokens.surface}
            onMouseDown={() => onToggle(index)}
          >
            <text
              content={t`${fg(current ? tokens.accent : tokens.textDim)(current ? "›" : " ")} ${fg(
                active ? tokens.accent : tokens.textDim,
              )(
                active ? "●" : "○",
              )} ${glyph}${active ? bold(fg(labelColor)(label)) : fg(labelColor)(label)}${fg(
                empty ? tokens.textDim : tokens.textMuted,
              )(tally.count.toLocaleString().padStart(7))}${fg(tokens.textDim)(
                (tally.count > 0 ? formatBytes(tally.bytes) : "").padStart(12),
              )}`}
              wrapMode="none"
            />
          </box>
        );
      })}
    </Modal>
  );
}
