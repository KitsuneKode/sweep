import type { BoxRenderable, MouseEvent } from "@opentui/core";
import { useRef, useState } from "react";
import type { ThemeTokens } from "./theme.js";

/** Mouse release and keyboard commands use the same caller-owned action.
 * A drag, right click or release over a different control never activates it. */
export function ActionButton({
  label,
  tokens,
  onPress,
  disabled = false,
  active = false,
  danger = false,
  framed = true,
}: {
  label: string;
  tokens: ThemeTokens;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  framed?: boolean;
}) {
  const pressed = useRef(false);
  const element = useRef<BoxRenderable | null>(null);
  const [hovered, setHovered] = useState(false);
  const down = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    pressed.current = !disabled && event.button === 0 && !event.isDragging;
  };
  const up = (event: MouseEvent) => {
    event.stopPropagation();
    const box = element.current;
    // OpenTUI 0.2.16 marks even a stationary text-selection release as dragging.
    // Actual drag events disarm below; also reject captured releases outside us.
    const inside =
      box !== null &&
      event.x >= box.x &&
      event.x < box.x + box.width &&
      event.y >= box.y &&
      event.y < box.y + box.height;
    const activate = pressed.current && !disabled && event.button === 0 && inside;
    pressed.current = false;
    if (activate) onPress();
  };
  return (
    <box
      ref={element}
      height={1}
      flexShrink={0}
      backgroundColor={
        active ? tokens.selectionBg : hovered && !disabled ? tokens.hoverBg : tokens.surface
      }
      onMouseDown={down}
      onMouseUp={up}
      onMouseDrag={() => {
        pressed.current = false;
      }}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => {
        pressed.current = false;
        setHovered(false);
      }}
    >
      <text
        content={framed ? `[${label}]` : label}
        wrapMode="none"
        fg={
          disabled
            ? tokens.textDim
            : active
              ? tokens.selectionText
              : danger
                ? tokens.danger
                : tokens.text
        }
      />
    </box>
  );
}
