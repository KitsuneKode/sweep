import type { Writable } from "node:stream";

let jsonStdoutActive = false;
export function isJsonStdoutActive(): boolean {
  return jsonStdoutActive;
}

/** Bounded JSON stdout with one error listener and shared, finite drain waits. */
export class JsonOutput {
  private failure: Error | undefined;
  private pending: Promise<void> | undefined;
  private blocked = false;
  private blockedBytes = 0;
  /**
   * Settles when the most recent real write is handed to the OS. Write
   * callbacks run in order, so this is a receipt for every byte before it.
   * Bun fires a zero-byte write's callback before earlier writes reach a slow
   * pipe reader, so `write("", cb)` cannot serve as that receipt.
   */
  private lastWrite: Promise<Error | null | undefined> = Promise.resolve(undefined);
  private readonly onError = (error: Error) => {
    this.failure ??= error;
  };
  private readonly onDrain = () => {
    this.blocked = false;
    this.blockedBytes = 0;
  };

  constructor(
    private readonly out: Writable,
    private readonly timeoutMs = 30_000,
    private readonly maxQueuedBytes = 64 * 1024 * 1024,
  ) {
    out.on("error", this.onError);
    // Producers can yield between write() and wait(). Observe drains for
    // the writer's whole lifetime so an already completed drain is not lost.
    out.on("drain", this.onDrain);
  }

  write(chunk: string): void {
    if (this.out === process.stdout) jsonStdoutActive = true;
    this.assertWritable();
    const bytes = Buffer.byteLength(chunk);
    if (Math.max(this.out.writableLength, this.blockedBytes) + bytes > this.maxQueuedBytes) {
      this.failure = new Error("JSON output buffer limit exceeded; output is incomplete.");
      throw this.failure;
    }
    // Bun stdout can return false while writableNeedDrain/Length stay false/0.
    // The return value is the authoritative backpressure signal.
    const wasBlocked = this.blocked;
    let accepted = true;
    this.lastWrite = new Promise((resolve) => {
      accepted = this.out.write(chunk, resolve);
    });
    if (!accepted) this.blocked = true;
    if (wasBlocked) this.blockedBytes += bytes;
    else if (this.blocked) {
      this.blockedBytes = Math.max(this.out.writableHighWaterMark, this.out.writableLength, bytes);
    }
  }

  private assertWritable(): void {
    if (this.failure) throw this.failure;
    if (this.out.destroyed || this.out.writableEnded) {
      this.failure = new Error("JSON output closed before completion; output is incomplete.");
      throw this.failure;
    }
  }

  /** Pause producers only when the Writable's own high-water mark is reached. */
  waitForConsumer(): Promise<void> | undefined {
    this.assertWritable();
    if (!this.blocked && !this.out.writableNeedDrain) return undefined;
    return this.wait();
  }

  /** Await every buffered byte before an explicit process.exit. */
  async flush(): Promise<void> {
    this.assertWritable();
    // A drain is a producer backpressure signal, not a delivery receipt.
    // Queue a callback behind every preceding write, even when Bun reports
    // zero writableLength for a pending stdout write.
    await this.wait(true);
    this.assertWritable();
  }

  private wait(delivery = false): Promise<void> {
    if (!delivery && this.pending) return this.pending;
    const pending = new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.out.removeListener("drain", onDrain);
        this.out.removeListener("error", onFailure);
        this.out.removeListener("close", onClose);
      };
      const done = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          this.failure ??= error;
          reject(this.failure);
        } else {
          this.blocked = false;
          this.blockedBytes = 0;
          resolve();
        }
      };
      const onDrain = () => done();
      const onFailure = (error: Error) => done(error);
      const onClose = () =>
        done(new Error("JSON output closed before completion; output is incomplete."));
      const timer = setTimeout(
        () =>
          done(
            new Error(
              `JSON output stalled for ${this.timeoutMs / 1000} seconds; output is incomplete.`,
            ),
          ),
        this.timeoutMs,
      );
      if (!delivery) this.out.once("drain", onDrain);
      this.out.once("error", onFailure);
      this.out.once("close", onClose);
      if (delivery) {
        // Two receipts, both required. The last write's own callback covers
        // Bun, which acknowledges an empty write early. The empty write covers
        // bytes written to the stream directly (human receipts), and surfaces
        // a closed pipe even when this writer has written nothing itself.
        let pendingReceipts = 2;
        const receipt = (error?: Error | null) => {
          if (error) done(error);
          else if (--pendingReceipts === 0) done();
        };
        void this.lastWrite.then(receipt);
        this.out.write("", receipt);
      }
      // Not blocked: nothing to wait for beyond what is already queued.
      else if (!this.blocked && !this.out.writableNeedDrain) done();
    });
    if (delivery) return pending;
    this.pending = pending.finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** Tests and non-process-lifetime owners can release the fixed listener. */
  dispose(): void {
    this.out.removeListener("error", this.onError);
    this.out.removeListener("drain", this.onDrain);
  }
}
