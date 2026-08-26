import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { ThemeTokens } from "./theme.js";

/**
 * Full-screen scrim + centered dialog. Children render inside a rounded,
 * bordered card; the scrim dims and swallows attention behind it.
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
        width={width}
        border
        borderStyle="rounded"
        borderColor={titleColor ?? tokens.borderFocus}
        title={` ${title} `}
        backgroundColor={tokens.surface}
        paddingX={3}
        paddingY={1}
        flexDirection="column"
      >
        {children}
      </box>
    </box>
  );
}

/** Vim-style statusline mode segment — inverse accent block. */
export function ModeChip({ label, tokens }: { label: string; tokens: ThemeTokens }) {
  return (
    <box backgroundColor={tokens.accent} paddingLeft={2} paddingRight={2}>
      <text content={label} fg={tokens.accentContrast} attributes={TextAttributes.BOLD} />
    </box>
  );
}
