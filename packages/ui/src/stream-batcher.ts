/** Grow burst frames to amortize whole-view derivation as scans get larger.
 * Timed reveal still bounds quiet tails; this does not change scan budgets. */
export function scanBatchCap(records: number): number {
  return Math.min(2000, Math.max(200, Math.floor(records / 10)));
}

/** Coalesce a scan generation without delaying its first visible result. */
export class StreamBatcher<T, P> {
  private readonly pending = new Map<string, T>();
  private pendingProgress: P | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revealed = false;
  private closed = false;
  private yieldNeeded = false;
  private yielding: Promise<void> | undefined;
  private delivery: Promise<void> | undefined;
  private releaseDelivery: (() => void) | undefined;
  private failure: { error: unknown } | undefined;
  private finishing = false;

  constructor(
    private readonly onFrame: (items: T[], progress: P | null) => void | Promise<void>,
    private readonly windowMs = 60,
    private readonly maxItems: number | (() => number) = 200,
  ) {}

  record(id: string, item: T): void {
    if (this.closed || this.finishing || this.failure) return;
    this.pending.set(id, item);
    const limit = typeof this.maxItems === "number" ? this.maxItems : this.maxItems();
    if (!this.revealed || this.pending.size >= limit) {
      this.revealed = true;
      this.flush();
    } else {
      this.schedule();
    }
  }

  progress(progress: P): void {
    if (this.closed || this.finishing || this.failure) return;
    this.pendingProgress = progress;
    this.schedule();
  }

  /** Await the consumer's commit receipt when supplied, then let input run.
   * Both engines consult this hook before admitting further backend work. */
  waitForConsumer(): Promise<void> | undefined {
    if (this.failure) return Promise.reject(this.failure.error);
    if (this.delivery)
      return this.delivery.then(() => {
        if (this.failure) throw this.failure.error;
      });
    if (this.yielding) return this.yielding;
    if (!this.yieldNeeded || this.closed) return undefined;
    this.yieldNeeded = false;
    this.yielding = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      this.yielding = undefined;
    });
    return this.yielding;
  }

  async finish(): Promise<void> {
    if (this.closed) return;
    this.finishing = true;
    this.flush();
    while (this.delivery) {
      await this.delivery;
      this.flush();
    }
    this.closed = true;
    if (this.failure) throw this.failure.error;
  }

  cancel(): void {
    this.closed = true;
    this.clearTimer();
    this.pending.clear();
    this.pendingProgress = null;
    this.releaseDelivery?.();
  }

  private schedule(): void {
    if (this.delivery || this.closed || this.finishing || this.failure) return;
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), this.windowMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private flush(): void {
    this.clearTimer();
    if (this.closed || this.delivery || this.failure) return;
    if (this.pending.size === 0 && this.pendingProgress === null) return;
    const items = [...this.pending.values()];
    const progress = this.pendingProgress;
    this.pending.clear();
    this.pendingProgress = null;
    let receipt: void | Promise<void>;
    try {
      receipt = this.onFrame(items, progress);
    } catch (error) {
      this.failure = { error };
      return;
    }
    this.yieldNeeded = true;
    if (receipt) {
      const cancelled = new Promise<void>((resolve) => {
        this.releaseDelivery = resolve;
      });
      // Observe rejection even when a timer delivered the frame. Surface it at
      // the next producer wait/finish, rather than an unhandled rejection.
      this.delivery = Promise.race([receipt, cancelled])
        .then(
          () => {},
          (error: unknown) => {
            this.failure = { error };
          },
        )
        .then(() => {
          this.delivery = undefined;
          this.releaseDelivery = undefined;
          if (this.pending.size > 0 || this.pendingProgress !== null) this.schedule();
        });
    }
  }
}
