import { bg, bold, fg, t } from "@opentui/core";
import { usePress } from "./ActionButton.js";
import type { KeyInput } from "./keymap.js";
import type { FooterHint } from "./presentation.js";
import type { ThemeTokens } from "./theme.js";

/**
 * The statusline hints as buttons. A click sends the hint's key through the
 * same handler a keypress takes, so the mouse can never do something the
 * keyboard would not. "caps" draws keys as filled keycaps (the full view);
 * "plain" keeps the calm view's quiet key-then-label voice. Hover lifts the
 * whole hint one step, with no motion: these are pressed many times a session.
 */
export function KeyHints({
  hints,
  tokens,
  onPress,
  variant = "caps",
}: {
  hints: FooterHint[];
  tokens: ThemeTokens;
  onPress: (key: KeyInput) => void;
  variant?: "caps" | "plain";
}) {
  return (
    <box flexDirection="row" flexShrink={1} minWidth={0}>
      {hints.map((hint, index) => (
        <box key={`${hint.key}:${hint.label}`} flexDirection="row" flexShrink={0}>
          {index > 0 ? <text content={variant === "plain" ? "   " : "  "} /> : null}
          <Hint hint={hint} tokens={tokens} onPress={onPress} variant={variant} />
        </box>
      ))}
    </box>
  );
}

function Hint({
  hint,
  tokens,
  onPress,
  variant,
}: {
  hint: FooterHint;
  tokens: ThemeTokens;
  onPress: (key: KeyInput) => void;
  variant: "caps" | "plain";
}) {
  const sent = hint.press;
  const press = usePress(() => {
    if (sent) onPress(sent);
  }, sent === undefined);
  const lit = press.hovered;
  const content =
    variant === "caps"
      ? t`${bg(lit ? tokens.border : tokens.controlBg)(fg(tokens.text)(` ${hint.key} `))}${fg(lit ? tokens.text : tokens.textMuted)(` ${hint.label}`)}`
      : hint.next
        ? t`${bold(fg(tokens.accent)(hint.key))}${fg(lit ? tokens.text : tokens.accent)(` ${hint.label}`)}`
        : t`${fg(lit ? tokens.text : tokens.textSecondary)(hint.key)}${fg(lit ? tokens.textSecondary : tokens.textDim)(` ${hint.label}`)}`;
  return (
    <box {...press.props} height={1} flexShrink={0}>
      <text content={content} wrapMode="none" />
    </box>
  );
}
