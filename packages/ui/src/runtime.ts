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
   */
  const onStdinData = (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (!bytes.includes(0x03)) return;
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
