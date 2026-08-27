import type { BoxProps } from "@opentui/react";
import { type ReactNode, useCallback, useState } from "react";
import type { ThemeTokens } from "./theme.js";

export interface SelectableRowProps {
  width?: number | `${number}%`;
  /** The cursor is on this row. */
  selected: boolean;
  /** Row is the applied choice, but the cursor is elsewhere. */
  emphasized?: boolean;
  hovered: boolean;
  tokens: ThemeTokens;
  onSelect: () => void;
  onHoverChange: (hovered: boolean) => void;
  children: ReactNode;
}

/**
 * Cursor and applied-selection are different states and must look different:
 * the cursor is where the next keystroke lands, the applied row is what the
 * rest of the UI is filtered to. One background for both makes the pane
 * unreadable the moment focus moves away.
 */
function rowBackground(
  selected: boolean,
  emphasized: boolean,
  hovered: boolean,
  tokens: ThemeTokens,
): string | undefined {
  if (selected) return tokens.selectionBg;
  if (emphasized) return tokens.selectionSoftBg;
  if (hovered) return tokens.hoverBg;
  return undefined;
}

/** ghui-style row wrapper: shared hover/selection background + mouse handlers. */
export function SelectableRow({
  width = "100%",
  selected,
  emphasized = false,
  hovered,
  tokens,
  onSelect,
  onHoverChange,
  children,
}: SelectableRowProps) {
  const backgroundColor = rowBackground(selected, emphasized, hovered, tokens);

  const mouseProps = {
    selectable: true,
    onMouseDown: onSelect,
    onMouseOver: () => onHoverChange(true),
    onMouseOut: () => onHoverChange(false),
  } as BoxProps;

  return (
    <box
      width={width}
      height={1}
      flexGrow={0}
      flexShrink={0}
      flexDirection="row"
      {...(backgroundColor ? { backgroundColor } : {})}
      {...mouseProps}
    >
      {children}
    </box>
  );
}

export function useHoverState<K extends string | number>() {
  const [hovered, setHovered] = useState<K | null>(null);

  const isHovered = useCallback((key: K) => hovered === key, [hovered]);

  const onHoverChange = useCallback(
    (key: K) => (next: boolean) => {
      setHovered((current) => {
        if (next) return key;
        return current === key ? null : current;
      });
    },
    [],
  );

  return { isHovered, onHoverChange };
}
