/** Coalesce a scan generation without delaying its first visible result. */
export class StreamBatcher<T, P> {
  private readonly pending = new Map<string, T>();
  private pendingProgress: P | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revealed = false;
  private closed = false;
  private yieldNeeded = false;
  private yielding: Promise<void> | undefined;

  constructor(
    private readonly onFrame: (items: T[], progress: P | null) => void,
    private readonly windowMs = 60,
    private readonly maxItems = 200,
  ) {}

  record(id: string, item: T): void {
    if (this.closed) return;
    this.pending.set(id, item);
    if (!this.revealed || this.pending.size >= this.maxItems) {
      this.revealed = true;
      this.flush();
    } else {
      this.schedule();
    }
  }

  progress(progress: P): void {
    if (this.closed) return;
    this.pendingProgress = progress;
    this.schedule();
  }

  /** Let React and terminal input run after a delivered frame. Both engines
   * consult this hook before taking further input; no unbounded frame queue. */
  waitForConsumer(): Promise<void> | undefined {
    if (this.yielding) return this.yielding;
    if (!this.yieldNeeded || this.closed) return undefined;
    this.yieldNeeded = false;
    this.yielding = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      this.yielding = undefined;
    });
    return this.yielding;
  }

  finish(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
  }

  cancel(): void {
    this.closed = true;
    this.clearTimer();
    this.pending.clear();
    this.pendingProgress = null;
  }

  private schedule(): void {
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), this.windowMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private flush(): void {
    this.clearTimer();
    if (this.pending.size === 0 && this.pendingProgress === null) return;
    const items = [...this.pending.values()];
    const progress = this.pendingProgress;
    this.pending.clear();
    this.pendingProgress = null;
    this.onFrame(items, progress);
    this.yieldNeeded = true;
  }
}
