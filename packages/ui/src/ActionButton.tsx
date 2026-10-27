import type { BoxRenderable, MouseEvent } from "@opentui/core";
import { fg, t } from "@opentui/core";
import { useRef, useState } from "react";
import type { ThemeTokens } from "./theme.js";

/**
 * Press semantics shared by every clickable control: arm on a left press,
 * fire on a release inside the same box, disarm on drag or leaving.
 */
export function usePress(onPress: () => void, disabled = false) {
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
  return {
    hovered: hovered && !disabled,
    props: {
      ref: element,
      onMouseDown: down,
      onMouseUp: up,
      onMouseDrag: () => {
        pressed.current = false;
      },
      onMouseOver: () => setHovered(true),
      onMouseOut: () => {
        pressed.current = false;
        setHovered(false);
      },
    },
  };
}

/** Mouse release and keyboard commands use the same caller-owned action.
 * A drag, right click or release over a different control never activates it.
 * `primary` marks the screen's next step; it only shows while enabled, so a
 * dead action is never advertised. A framed button is a filled pill one step
 * above its surface; `hint` names its shortcut in a quieter voice. */
export function ActionButton({
  label,
  tokens,
  onPress,
  disabled = false,
  active = false,
  danger = false,
  primary = false,
  framed = true,
  hint,
  color,
}: {
  label: string;
  /** Overrides the resting label colour, e.g. a queue mark's state. */
  color?: string | undefined;
  hint?: string | undefined;
  tokens: ThemeTokens;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  primary?: boolean;
  framed?: boolean;
}) {
  const press = usePress(onPress, disabled);
  const lead = primary && !disabled && !active;
  const rest = framed ? tokens.controlBg : tokens.surface;
  const labelColor = disabled
    ? tokens.textDim
    : active
      ? tokens.selectionText
      : lead
        ? tokens.accentContrast
        : danger
          ? tokens.danger
          : (color ?? tokens.text);
  const hintColor = lead ? tokens.accentContrast : disabled ? tokens.textDim : tokens.textMuted;
  return (
    <box
      {...press.props}
      height={1}
      flexShrink={0}
      backgroundColor={
        active
          ? tokens.selectionBg
          : lead
            ? tokens.accent
            : press.hovered
              ? framed
                ? tokens.border
                : tokens.hoverBg
              : rest
      }
    >
      <text
        content={
          framed
            ? hint
              ? t` ${fg(labelColor)(label)} ${fg(hintColor)(hint)} `
              : t` ${fg(labelColor)(label)} `
            : t`${fg(labelColor)(label)}`
        }
        wrapMode="none"
      />
    </box>
  );
}
