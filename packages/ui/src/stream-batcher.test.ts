import { describe, expect, test } from "bun:test";
import { StreamBatcher } from "./stream-batcher.js";

describe("stream batching", () => {
  test("reveals the first item immediately, then coalesces updates", () => {
    const frames: number[][] = [];
    const batcher = new StreamBatcher<number, number>((items) => frames.push(items), 60, 200);
    batcher.record("first", 1);
    batcher.record("second", 2);
    batcher.record("second", 3);
    batcher.record("third", 4);
    expect(frames).toEqual([[1]]);
    batcher.finish();
    expect(frames).toEqual([[1], [3, 4]]);
  });

  test("bounds burst batches and includes the latest progress", () => {
    const frames: Array<{ items: number[]; progress: number | null }> = [];
    const batcher = new StreamBatcher<number, number>(
      (items, progress) => frames.push({ items, progress }),
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
    batcher.finish();
    expect(frames).toHaveLength(2);
  });

  test("cancel discards buffered data and scheduled callbacks", async () => {
    const frames: number[][] = [];
    const batcher = new StreamBatcher<number, number>((items) => frames.push(items), 10);
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
    const batcher = new StreamBatcher<number, number>((items) => frames.push(items), 10);
    batcher.record("first", 1);
    batcher.record("second", 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frames).toEqual([[1], [2]]);
    batcher.record("third", 3);
    batcher.finish();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frames).toEqual([[1], [2], [3]]);
  });
});
