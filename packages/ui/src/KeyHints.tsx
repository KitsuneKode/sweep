import { bg, bold, fg, t } from "@opentui/core";
import { usePress } from "./ActionButton.js";
import type { KeyInput } from "./keymap.js";
import type { FooterHint } from "./presentation.js";
import type { ThemeTokens } from "./theme.js";

/**
 * The statusline hints as buttons. A click sends the hint's key through the
 * same handler a keypress takes, so the mouse can never do something the
 * keyboard would not. "caps" draws keys as filled keycaps (primary next steps
 * use the Clove blue accent fill, secondary hints use the neutral control fill);
 * "plain" keeps a quiet key-then-label voice. Hover lifts one step with no motion.
 */
export function KeyHints({
  hints,
  tokens,
  onPress,
  variant = "caps",
  wrap = false,
}: {
  hints: FooterHint[];
  tokens: ThemeTokens;
  onPress: (key: KeyInput) => void;
  variant?: "caps" | "plain";
  /** Allow keycap rows to wrap cleanly inside narrow modals instead of clipping. */
  wrap?: boolean;
}) {
  if (wrap) {
    return (
      <box
        flexDirection="row"
        flexWrap="wrap"
        columnGap={variant === "plain" ? 3 : 2}
        flexShrink={1}
        minWidth={0}
      >
        {hints.map((hint) => (
          <Hint
            key={`${hint.key}:${hint.label}`}
            hint={hint}
            tokens={tokens}
            onPress={onPress}
            variant={variant}
          />
        ))}
      </box>
    );
  }
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
  const disabled = hint.disabled === true;
  const press = usePress(
    () => {
      if (!disabled && sent) onPress(sent);
    },
    disabled || sent === undefined,
  );
  const lit = press.hovered;
  const toneBg =
    hint.tone === "danger"
      ? tokens.danger
      : hint.tone === "warning"
        ? tokens.warning
        : tokens.accent;
  const emphasized = !disabled && (hint.next === true || hint.tone !== undefined);
  const content =
    variant === "caps"
      ? disabled
        ? t`${bg(tokens.controlBg)(fg(tokens.textDim)(` ${hint.key} `))}${fg(tokens.textDim)(` ${hint.label}`)}`
        : emphasized
          ? t`${bg(toneBg)(bold(fg(tokens.accentContrast)(` ${hint.key} `)))}${fg(tokens.text)(` ${hint.label}`)}`
          : t`${bg(lit ? tokens.border : tokens.controlBg)(fg(tokens.text)(` ${hint.key} `))}${fg(lit ? tokens.text : tokens.textSecondary)(` ${hint.label}`)}`
      : disabled
        ? t`${fg(tokens.textDim)(`${hint.key} ${hint.label}`)}`
        : emphasized
          ? t`${bold(fg(toneBg)(hint.key))}${fg(lit ? tokens.text : toneBg)(` ${hint.label}`)}`
          : t`${fg(lit ? tokens.text : tokens.textSecondary)(hint.key)}${fg(lit ? tokens.textSecondary : tokens.textDim)(` ${hint.label}`)}`;
  return (
    <box {...press.props} height={1} flexShrink={0}>
      <text content={content} wrapMode="none" />
    </box>
  );
}
