import pc from "picocolors";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠣", "⠏"] as const;

export interface Spinner {
  update: (text: string) => void;
  stop: () => void;
}

/** Create a TTY spinner. In non-TTY environments, emits a single static line. */
export function createSpinner(initialText: string): Spinner {
  if (!process.stdout.isTTY) {
    process.stdout.write(`sweep: ${initialText}\n`);
    return {
      update: () => {},
      stop: () => {},
    };
  }

  let current = initialText;
  let frameIdx = 0;
  let stopped = false;

  const paint = () => {
    const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length] ?? "⠋";
    // One line, never wrapped: a wrapped line cannot be redrawn with `\r`.
    const room = Math.max(8, (process.stdout.columns ?? 80) - 3);
    const text = current.length > room ? `${current.slice(0, room - 1)}…` : current;
    process.stdout.write(`\r\x1b[2K${pc.cyan(frame)} ${text}`);
  };

  const id = setInterval(() => {
    paint();
    frameIdx++;
  }, 80);
  id.unref();

  return {
    update: (text: string) => {
      current = text;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(id);
      // Clear the spinner line so stdout writes do not bleed into an alternate-screen TUI.
      process.stdout.write("\r\x1b[2K");
    },
  };
}
