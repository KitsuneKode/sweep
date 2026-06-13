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

  const id = setInterval(() => {
    const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length] ?? "⠋";
    process.stdout.write(`\r${pc.cyan(frame)} ${current}`);
    frameIdx++;
  }, 80);

  return {
    update: (text: string) => {
      current = text;
    },
    stop: () => {
      clearInterval(id);
      process.stdout.write("\r\x1b[K");
    },
  };
}
