import { describe, expect, test } from "bun:test";
import { StreamBatcher, scanBatchCap } from "./stream-batcher.js";

describe("stream batching", () => {
  test("growing batch caps preserve first reveal, latest updates and the quiet tail", async () => {
    expect(scanBatchCap(0)).toBe(200);
    expect(scanBatchCap(10000)).toBe(1000);
    expect(scanBatchCap(1000000)).toBe(2000);
    const frames: number[][] = [];
    let limit = 2;
    const batcher = new StreamBatcher<number, number>(
      (items) => {
        frames.push(items);
      },
      1,
      () => limit,
    );
    batcher.record("first", 1);
    limit = 4;
    for (let n = 2; n <= 4; n++) batcher.record(String(n), n);
    expect(frames).toEqual([[1]]);
    batcher.record("5", 5);
    expect(frames).toEqual([[1], [2, 3, 4, 5]]);
    batcher.record("6", 6);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(frames).toEqual([[1], [2, 3, 4, 5], [6]]);
    await batcher.finish();
  });
  test("a synchronous failure in a timed frame is returned to the producer", async () => {
    let frames = 0;
    const batcher = new StreamBatcher<number, number>(() => {
      if (++frames === 2) throw new Error("consumer failed synchronously");
    }, 1);
    batcher.record("first", 1);
    await batcher.waitForConsumer();
    batcher.record("second", 2);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await expect(batcher.waitForConsumer()).rejects.toThrow("consumer failed synchronously");
    await expect(batcher.finish()).rejects.toThrow("consumer failed synchronously");
    batcher.cancel();
  });
  test("cancellation releases a stalled commit and discards its queued frame", async () => {
    const frames: number[][] = [];
    const batcher = new StreamBatcher<number, number>(
      (items) => {
        frames.push(items);
        return new Promise<void>(() => {});
      },
      1,
      2,
    );
    batcher.record("first", 1);
    const pending = batcher.waitForConsumer();
    batcher.record("second", 2);
    batcher.cancel();
    await pending;
    await batcher.finish();
    expect(frames).toEqual([[1]]);
  });

  test("a rejected commit fails the scan instead of publishing more frames", async () => {
    const frames: number[][] = [];
    const batcher = new StreamBatcher<number, number>((items) => {
      frames.push(items);
      return Promise.reject(new Error("consumer failed"));
    });
    batcher.record("first", 1);
    batcher.record("second", 2);
    await expect(batcher.waitForConsumer()).rejects.toThrow("consumer failed");
    await expect(batcher.finish()).rejects.toThrow("consumer failed");
    expect(frames).toEqual([[1]]);
    batcher.cancel();
  });
  test("a slow UI commit holds the producer and coalesces subsequent frames", async () => {
    const frames: number[][] = [];
    let commit!: () => void;
    const receipt = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const batcher = new StreamBatcher<number, number>(
      (items) => {
        frames.push(items);
        return frames.length === 1 ? receipt : undefined;
      },
      1,
      2,
    );
    batcher.record("first", 1);
    let admitted = false;
    const pending = batcher.waitForConsumer()?.then(() => {
      admitted = true;
    });
    batcher.record("second", 2);
    batcher.record("third", 3);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(admitted).toBe(false);
    expect(frames).toEqual([[1]]);
    commit();
    await pending;
    await batcher.finish();
    expect(frames).toEqual([[1], [2, 3]]);
  });
  test("a delivered frame yields before admitting more backend work", async () => {
    const frames: number[][] = [];
    const batcher = new StreamBatcher<number, number>((items) => {
      frames.push(items);
    });
    expect(batcher.waitForConsumer()).toBeUndefined();
    batcher.record("first", 1);
    const pending = batcher.waitForConsumer();
    expect(pending).toBeInstanceOf(Promise);
    expect(batcher.waitForConsumer()).toBe(pending);
    let inputHandled = false;
    setImmediate(() => {
      inputHandled = true;
    });
    await pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inputHandled).toBe(true);
    expect(batcher.waitForConsumer()).toBeUndefined();
    batcher.cancel();
    expect(frames).toEqual([[1]]);
  });
  test("reveals the first item immediately, then coalesces updates", async () => {
    const frames: number[][] = [];
    const batcher = new StreamBatcher<number, number>(
      (items) => {
        frames.push(items);
      },
      60,
      200,
    );
    batcher.record("first", 1);
    batcher.record("second", 2);
    batcher.record("second", 3);
    batcher.record("third", 4);
    expect(frames).toEqual([[1]]);
    await batcher.finish();
    expect(frames).toEqual([[1], [3, 4]]);
  });

  test("bounds burst batches and includes the latest progress", async () => {
    const frames: Array<{ items: number[]; progress: number | null }> = [];
    const batcher = new StreamBatcher<number, number>(
      (items, progress) => {
        frames.push({ items, progress });
      },
      60,
      2,
    );
    batcher.record("first", 1);
    batcher.progress(2);
    batcher.progress(3);
    batcher.record("second", 2);
    batcher.record("third", 3);
    expect(frames).toEqual([
      { items: [1], progress: null },
      { items: [2, 3], progress: 3 },
    ]);
    await batcher.finish();
    expect(frames).toHaveLength(2);
  });

  test("cancel discards buffered data and scheduled callbacks", async () => {
    const frames: number[][] = [];
    const batcher = new StreamBatcher<number, number>((items) => {
      frames.push(items);
    }, 10);
    batcher.record("first", 1);
    batcher.record("second", 2);
    batcher.cancel();
    batcher.record("third", 3);
    batcher.progress(4);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frames).toEqual([[1]]);
  });

  test("timed delivery continues after the first frame and finish cancels the timer", async () => {
    const frames: number[][] = [];
    const batcher = new StreamBatcher<number, number>((items) => {
      frames.push(items);
    }, 10);
    batcher.record("first", 1);
    batcher.record("second", 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frames).toEqual([[1], [2]]);
    batcher.record("third", 3);
    await batcher.finish();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frames).toEqual([[1], [2], [3]]);
  });
});
