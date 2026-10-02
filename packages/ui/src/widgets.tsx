import { StyledText, TextAttributes, fg } from "@opentui/core";
import type { TextChunk } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DOT_GRID, dotFrame, dotRamp, dotStrip, type DotPattern } from "./dot-matrix.js";
import type { ThemeTokens } from "./theme.js";

/**
 * Full-screen scrim + centered dialog. Children render inside a rounded,
 * bordered card; the scrim dims and swallows attention behind it.
 *
 * The card is clamped to the viewport on both axes. A fixed-size box centered
 * in a terminal smaller than the box gets negative layout offsets on both
 * axes, and that combination crashes the native renderer outright - so the
 * clamp is a hard correctness requirement, not cosmetic. Content that does not
 * fit scrolls inside the card rather than overflowing it.
 */
export function Modal({
  tokens,
  title,
  titleColor,
  width,
  children,
}: {
  tokens: ThemeTokens;
  title: string;
  titleColor?: string;
  width: number;
  children: ReactNode;
}) {
  const { width: screenWidth, height: screenHeight } = useTerminalDimensions();
  const modalWidth = Math.max(4, Math.min(width, Math.max(4, screenWidth - 2)));
  const maxHeight = Math.max(3, screenHeight - 2);

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      justifyContent="center"
      alignItems="center"
      backgroundColor={tokens.overlayBackdrop}
    >
      <box
        width={modalWidth}
        maxHeight={maxHeight}
        border
        borderStyle="rounded"
        borderColor={titleColor ?? tokens.borderFocus}
        title={` ${title} `}
        backgroundColor={tokens.surface}
        paddingX={3}
        paddingY={1}
        flexDirection="column"
      >
        <scrollbox
          // No flexGrow: the card hugs content height. flexShrink still lets
          // the scrollbox compress and scroll once the card hits maxHeight.
          flexShrink={1}
          minHeight={0}
          width="100%"
          scrollX={false}
          stickyScroll={false}
          // Reserve the scrollbar's column: content is laid out at the full
          // scrollbox width, so without this the last cells of every line sit
          // under the scrollbar and long rows clip instead of wrapping.
          contentOptions={{ flexDirection: "column", paddingRight: 2 }}
        >
          {children}
        </scrollbox>
      </box>
    </box>
  );
}

/** Vim-style statusline mode segment - inverse accent block. */
export function ModeChip({ label, tokens }: { label: string; tokens: ThemeTokens }) {
  return (
    <box backgroundColor={tokens.accent} paddingLeft={2} paddingRight={2} flexShrink={0}>
      <text
        content={label}
        fg={tokens.accentContrast}
        attributes={TextAttributes.BOLD}
        wrapMode="none"
      />
    </box>
  );
}

/** ~16fps frame counter. Only ticks while `active`, so idle costs nothing. */
export function useDotFrame(active = true, intervalMs = 60): number {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((value) => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  return active ? frame : 0;
}

/** The dot itself. Fixed glyph, animated brightness - the dots never move. */
const DOT = "•";

/**
 * 5x5 dot-matrix loader. Renders as `DOT_GRID` stacked text rows so it keeps
 * its square proportions; each cell is `dot + space` so it reads as a grid and
 * not as a word.
 */
export function DotMatrix({
  tokens,
  pattern = "pulseRings",
  active = true,
  frame,
}: {
  tokens: ThemeTokens;
  pattern?: DotPattern;
  active?: boolean;
  frame?: number;
}) {
  const internal = useDotFrame(active && frame === undefined);
  const current = frame ?? internal;
  const ramp = useMemo(() => dotRamp(tokens.meterTrack, tokens.accent), [tokens]);
  const grid = useMemo(() => dotFrame(pattern, current), [pattern, current]);

  return (
    <box flexDirection="column" flexShrink={0}>
      {grid.map((row, y) => (
        <text
          // Row position in a fixed-size grid is the identity here.
          key={`dot-row-${y}`}
          content={dotRowText(row, ramp)}
          wrapMode="none"
        />
      ))}
    </box>
  );
}

function dotRowText(levels: number[], ramp: string[]): StyledText {
  const chunks: TextChunk[] = [];
  for (let x = 0; x < levels.length; x++) {
    const color = ramp[levels[x] ?? 0] ?? ramp[0] ?? "#666666";
    // Cell = dot + gap, so the grid reads as a matrix rather than a word.
    chunks.push(fg(color)(x < levels.length - 1 ? `${DOT} ` : DOT));
  }
  return new StyledText(chunks);
}

/** One-row dot sweep for dense chrome (statusline, pane headers). */
export function DotStrip({
  tokens,
  width = DOT_GRID,
  pattern = "scan",
  active = true,
  frame,
  dim,
  bright,
}: {
  tokens: ThemeTokens;
  width?: number;
  pattern?: DotPattern;
  active?: boolean;
  frame?: number;
  dim?: string;
  bright?: string;
}) {
  const internal = useDotFrame(active && frame === undefined);
  const current = frame ?? internal;
  const ramp = useMemo(
    () => dotRamp(dim ?? tokens.meterTrack, bright ?? tokens.accent),
    [tokens, dim, bright],
  );
  const levels = useMemo(() => dotStrip(pattern, current, width), [pattern, current, width]);

  return <text content={dotRowText(levels, ramp)} wrapMode="none" />;
}

/**
 * SCANNING statusline segment. A static badge reads as frozen, so the mode
 * block carries a live dot sweep next to the word.
 */
export function ScanModeChip({ tokens }: { tokens: ThemeTokens }) {
  return (
    <box
      backgroundColor={tokens.accent}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      gap={1}
    >
      <text
        content="SCANNING"
        fg={tokens.accentContrast}
        attributes={TextAttributes.BOLD}
        wrapMode="none"
      />
      <DotStrip
        tokens={tokens}
        width={5}
        pattern="scan"
        dim={tokens.accent}
        bright={tokens.accentContrast}
      />
    </box>
  );
}
