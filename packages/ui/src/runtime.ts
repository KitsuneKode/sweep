import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { SweepUiOutcome } from "./outcome.js";

export interface UiSession {
  root: ReturnType<typeof createRoot>;
  /** Idempotent: restores the terminal, then resolves the session promise. */
  finish: (outcome: SweepUiOutcome) => void;
  done: Promise<SweepUiOutcome>;
}

// The raw-stdin deadman below fires on a timer so the keymap - which sees
// the same ETX byte - can own ctrl+c first (mid-apply abort, normal quit).
// If the React tree is wedged nothing cancels the timer and the session
// still exits; a handled chord clears it via noteCtrlCHandled.
let pendingDeadman: ReturnType<typeof setTimeout> | undefined;

/** Cancel a pending last-resort ctrl+c kill - the app handled the chord. */
export function noteCtrlCHandled(): void {
  if (pendingDeadman !== undefined) {
    clearTimeout(pendingDeadman);
    pendingDeadman = undefined;
  }
}

/**
 * Own Ctrl+C / SIGTERM ourselves. OpenTUI's default `exitOnCtrlC` destroys the
 * renderer without aborting the scan subprocess, which leaves `sweep ui` hung.
 */
export async function openUiSession(): Promise<UiSession> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    screenMode: "alternate-screen",
    useMouse: true,
    targetFps: 30,
  });

  const root = createRoot(renderer);
  let cleanedUp = false;
  let resolveDone!: (outcome: SweepUiOutcome) => void;
  const done = new Promise<SweepUiOutcome>((resolvePromise) => {
    resolveDone = resolvePromise;
  });

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    noteCtrlCHandled();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
    process.stdin.off("data", onStdinData);
    try {
      root.unmount();
    } catch {
      // already torn down with the renderer
    }
    try {
      renderer.destroy();
    } catch {
      // ignore
    }
  };

  const finish = (outcome: SweepUiOutcome) => {
    cleanup();
    resolveDone(outcome);
  };

  const onSignal = () => finish({ type: "abort" });

  /**
   * Last-resort quit path.
   *
   * In raw mode Ctrl+C never becomes SIGINT, so the only way out normally runs
   * through the React keymap. If the tree is mid-render, unmounted, or wedged,
   * that path is dead and `sweep ui` hangs with no way to exit. Reading ETX
   * (0x03) straight off stdin keeps a route out that does not depend on
   * anything above the renderer still working.
   *
   * ETX inside a bracketed paste is payload, not a quit chord - the markers
   * (ESC[200~ / ESC[201~) are tracked across chunk boundaries so pasting
   * binary-ish text can't kill the session. A truncated marker carries its
   * prefix into the next chunk's scan.
   */
  const PASTE_START = Buffer.from("\x1b[200~");
  const PASTE_END = Buffer.from("\x1b[201~");
  let inPaste = false;
  let scanCarry = Buffer.alloc(0);
  const onStdinData = (chunk: Buffer | string) => {
    const bytes = Buffer.concat([
      scanCarry,
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
    ]);
    scanCarry = Buffer.alloc(0);
    let etxSeen = false;
    let i = 0;
    while (i < bytes.length) {
      const byte = bytes[i];
      if (byte === 0x1b && i + 6 <= bytes.length) {
        if (bytes.subarray(i, i + 6).equals(PASTE_START)) {
          inPaste = true;
          i += 6;
          continue;
        }
        if (bytes.subarray(i, i + 6).equals(PASTE_END)) {
          inPaste = false;
          i += 6;
          continue;
        }
      }
      if (byte === 0x03 && !inPaste) etxSeen = true;
      i += 1;
    }
    // The tail could be a truncated marker. Carry only real marker prefixes -
    // they never contain ETX, so no quit byte is ever rescanned or hidden.
    for (let k = Math.min(5, bytes.length); k > 0; k--) {
      const slice = bytes.subarray(bytes.length - k);
      if (PASTE_START.subarray(0, k).equals(slice) || PASTE_END.subarray(0, k).equals(slice)) {
        scanCarry = Buffer.from(slice);
        break;
      }
    }
    if (!etxSeen) return;
    // Defer: the same byte also reaches the keymap, where ctrl+c during an
    // apply means "stop the delete and stay". An immediate finish() would
    // sever the apply mid-syscall with no report and no history entry.
    pendingDeadman ??= setTimeout(() => {
      pendingDeadman = undefined;
      finish({ type: "abort" });
    }, 750);
    pendingDeadman.unref?.();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // SIGHUP = terminal closed: restore alternate-screen/raw mode/mouse
  // capture before exit or the user's shell inherits a mangled terminal.
  process.on("SIGHUP", onSignal);
  process.stdin.on("data", onStdinData);

  return { root, finish, done };
}
