import { bold, fg, t } from "@opentui/core";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { Component, type ReactNode } from "react";
import { darkTheme } from "./theme.js";

function styledContentFallback(message: string, closing: boolean): ReactNode {
  // Renders when the app crashed before (or without) theme context - always
  // uses the dark palette directly rather than resolving a mode.
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      padding={1}
      backgroundColor={darkTheme.bg}
    >
      <text
        content={t`${bold(fg(darkTheme.danger)("◆ sweep"))} ${fg(darkTheme.textMuted)("hit an error in the interactive view")}`}
      />
      <text content="" />
      <text content={sanitizeTerminalText(message).slice(0, 4096)} fg={darkTheme.text} />
      <text content="" />
      <text
        content={
          closing
            ? "Closing the view; waiting for any active apply report."
            : "Press Ctrl+C to exit."
        }
        fg={darkTheme.textDim}
      />
    </box>
  );
}

export class UiErrorBoundary extends Component<
  { children: ReactNode; onError?: (error: Error) => void },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode; onError?: (error: Error) => void }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return styledContentFallback(this.state.error.message, this.props.onError !== undefined);
    }
    return this.props.children;
  }
}
