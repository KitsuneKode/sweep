import { StyledText, TextAttributes, fg } from "@opentui/core";
import type { ScrollBoxRenderable, TextChunk } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DOT_GRID, dotFrame, dotRamp, dotStrip, type DotPattern } from "./dot-matrix.js";
import { KeyHints } from "./KeyHints.js";
import type { FooterHint } from "./presentation.js";
import type { ThemeTokens } from "./theme.js";
import { useMotionEnabled } from "./motion.js";

/** One action inside `<ModalFooter>`, rendered with the shared Direction C+ keycap component. */
export interface ModalFooterAction {
  key: string;
  label: string;
  onPress?: (() => void) | undefined;
  /** Primary next step: rendered on the Clove accent fill (or semantic `tone`). */
  primary?: boolean;
  disabled?: boolean;
  tone?: "accent" | "danger" | "warning";
}

/**
 * Shared Direction C+ modal footer: a 1-row `tokens.border` hairline above
 * content-sized keycap actions rendered through the same `KeyHints` component
 * as the Projects footer. Wraps cleanly onto a second row on narrow terminals
 * instead of clipping or stretching controls full-width.
 */
export function ModalFooter({
  tokens,
  actions,
}: {
  tokens: ThemeTokens;
  actions: readonly ModalFooterAction[];
}) {
  const hints: FooterHint[] = actions.map((action, index) => ({
    key: action.key,
    label: action.label,
    ...(action.primary ? { next: true } : {}),
    ...(action.disabled ? { disabled: true } : {}),
    ...(action.tone ? { tone: action.tone } : {}),
    ...(action.onPress ? { press: { name: `modal-action-${index}` } } : {}),
  }));
  return (
    <box
      width="100%"
      flexDirection="column"
      alignItems="flex-start"
      flexShrink={0}
      marginTop={1}
      border={["top"]}
      borderStyle="single"
      borderColor={tokens.border}
    >
      <KeyHints
        variant="caps"
        wrap
        tokens={tokens}
        hints={hints}
        onPress={(pressed) => {
          const match = /^modal-action-(\d+)$/.exec(pressed.name ?? "");
          if (!match) return;
          actions[Number(match[1])]?.onPress?.();
        }}
      />
    </box>
  );
}

/**
 * Full-screen scrim + centered dialog. Children render inside a rounded,
 * bordered card; the scrim dims and swallows attention behind it.
 *
 * When `height` is omitted, the card hugs its content vertically up to a
 * viewport-clamped max height (`rows - 4` on standard terminals) and scrolls
 * internally when content overflows. Fixed-size boxes centered in a terminal
 * smaller than the box get negative layout offsets and crash the native
 * renderer, so percent bounds clamp on both axes in every resize frame.
 */
export function Modal({
  tokens,
  title,
  titleColor,
  width,
  height,
  footer,
  children,
}: {
  tokens: ThemeTokens;
  title: string;
  titleColor?: string;
  width: number;
  /** Explicit compact height; omit to hug content up to the viewport clamp. */
  height?: number;
  /** Consent/stop controls stay visible independently of scrollable details. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { width: screenWidth, height: screenHeight } = useTerminalDimensions();
  // Percent bounds are resolved by native layout in the resize frame, before
  // React's terminal-dimensions hook can commit. Fixed viewport-derived sizes
  // can briefly exceed a shrinking terminal and produce negative offsets.
  const modalWidth = Math.max(1, Math.min(width, Math.max(1, screenWidth - 2)));
  const autoHeight = height === undefined;
  const backdropPadY = screenHeight < 3 ? 0 : autoHeight && screenHeight >= 14 ? 2 : 1;
  const maxHeight = Math.max(1, screenHeight - backdropPadY * 2);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  useKeyboard((key) => {
    const delta = key.name === "pagedown" ? 1 : key.name === "pageup" ? -1 : 0;
    if (delta && scrollRef.current)
      scrollRef.current.scrollBy({ x: 0, y: delta * Math.max(1, scrollRef.current.height - 1) });
  });

  const cleanTitle = title.trim();

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      justifyContent="center"
      alignItems="center"
      paddingX={screenWidth < 3 ? 0 : 1}
      paddingY={backdropPadY}
      backgroundColor={tokens.overlayBackdrop}
    >
      <box
        width="100%"
        maxWidth={width}
        {...(autoHeight ? {} : { height: Math.max(1, height) })}
        maxHeight="100%"
        border
        borderStyle="rounded"
        borderColor={titleColor ?? tokens.borderFocus}
        title={` ${cleanTitle} `}
        backgroundColor={tokens.surface}
        paddingX={modalWidth < 44 ? 1 : 2}
        paddingY={maxHeight < 10 ? 0 : 1}
        flexDirection="column"
      >
        <scrollbox
          ref={scrollRef}
          flexGrow={autoHeight ? 0 : 1}
          // ScrollBoxRenderable defaults viewport to flexGrow=1 and content to
          // minHeight="100%", which stretches auto-height cards to the full
          // terminal. Overriding viewport/content lets short dialogs hug their
          // content while long dialogs still cap at maxHeight and scroll.
          flexShrink={1}
          minHeight={0}
          width="100%"
          scrollX={false}
          stickyScroll={false}
          {...(autoHeight
            ? {
                wrapperOptions: { flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0 },
                viewportOptions: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
              }
            : {})}
          // Reserve the scrollbar's column: content is laid out at the full
          // scrollbox width, so without this the last cells of every line sit
          // under the scrollbar and long rows clip instead of wrapping.
          contentOptions={{
            flexDirection: "column",
            paddingRight: 2,
            ...(autoHeight ? { minHeight: 0 } : {}),
          }}
        >
          {children}
        </scrollbox>
        {footer ? (
          <box flexDirection="column" alignItems="flex-start" flexShrink={0} width="100%">
            {footer}
          </box>
        ) : null}
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

/** Activity changes at 6 Hz; paused/idle loaders allocate no interval. */
export function useDotFrame(active = true, intervalMs = 160): number {
  const [frame, setFrame] = useState(0);
  const enabled = useMotionEnabled();

  useEffect(() => {
    if (!active || !enabled) return;
    const timer = setInterval(() => setFrame((value) => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [active, enabled, intervalMs]);

  return active && enabled ? frame : 0;
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
  const enabled = useMotionEnabled();
  const current = enabled ? (frame ?? internal) : 0;
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
  const enabled = useMotionEnabled();
  const current = enabled ? (frame ?? internal) : 0;
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
