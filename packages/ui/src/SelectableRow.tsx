import type { BoxProps } from "@opentui/react";
import { type ReactNode, useCallback, useState } from "react";
import type { ThemeTokens } from "./theme.js";

export interface SelectableRowProps {
  width?: number | `${number}%`;
  selected: boolean;
  hovered: boolean;
  tokens: ThemeTokens;
  onSelect: () => void;
  onHoverChange: (hovered: boolean) => void;
  children: ReactNode;
}

function rowBackground(
  selected: boolean,
  hovered: boolean,
  tokens: ThemeTokens,
): string | undefined {
  if (selected) return tokens.selectionBg;
  if (hovered) return tokens.hoverBg;
  return undefined;
}

/** ghui-style row wrapper: shared hover/selection background + mouse handlers. */
export function SelectableRow({
  width = "100%",
  selected,
  hovered,
  tokens,
  onSelect,
  onHoverChange,
  children,
}: SelectableRowProps) {
  const backgroundColor = rowBackground(selected, hovered, tokens);

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
