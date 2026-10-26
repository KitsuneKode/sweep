import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { JsonOutput } from "./json-output.js";

test("flush waits for write completion even when a drain arrives early", async () => {
  let delivered = false;
  const out = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      setTimeout(() => out.emit("drain"), 1);
      setTimeout(() => {
        delivered = true;
        callback();
      }, 20);
    },
  });
  const writer = new JsonOutput(out, 1000);
  try {
    writer.write("payload");
    await writer.flush();
    expect(delivered).toBe(true);
  } finally {
    writer.dispose();
    out.destroy();
  }
});

test("a consumer that drains before the producer waits does not falsely stall", async () => {
  const out = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      setTimeout(callback, 1);
    },
  });
  const writer = new JsonOutput(out, 20);
  try {
    const drained = new Promise<void>((resolve) => out.once("drain", resolve));
    writer.write("payload");
    await drained;
    expect(out.writableLength).toBe(0);
    await writer.flush();
    expect(writer.waitForConsumer()).toBeUndefined();
  } finally {
    writer.dispose();
    out.destroy();
  }
});

test("slow consumers preserve all JSON and drain listeners do not accumulate", async () => {
  const chunks: string[] = [];
  const out = new Writable({
    highWaterMark: 4,
    write(chunk, _encoding, callback) {
      setTimeout(() => {
        chunks.push(chunk.toString());
        callback();
      }, 2);
    },
  });
  const writer = new JsonOutput(out, 1000);
  try {
    for (let i = 0; i < 25; i++) {
      writer.write(`${JSON.stringify({ i })}\n`);
      const wait = writer.waitForConsumer();
      if (wait) await wait;
      expect(out.listenerCount("drain")).toBe(1);
      expect(out.listenerCount("close")).toBe(0);
      expect(out.listenerCount("error")).toBe(1);
    }
    await writer.flush();
    expect(
      chunks
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).i),
    ).toEqual(Array.from({ length: 25 }, (_, i) => i));
  } finally {
    writer.dispose();
    out.destroy();
  }
});

test("stalled consumers fail within the deadline and release temporary listeners", async () => {
  const out = new Writable({ highWaterMark: 1, write() {} });
  const writer = new JsonOutput(out, 10);
  writer.write("payload");
  await expect(writer.flush()).rejects.toThrow("output is incomplete");
  expect(out.listenerCount("drain")).toBe(1);
  expect(out.listenerCount("close")).toBe(0);
  expect(() => writer.write("more")).toThrow();
  writer.dispose();
  out.destroy();
});

test("a closed pipe is an explicit failure rather than successful final flush", async () => {
  const out = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      setTimeout(() => callback(new Error("EPIPE")), 2);
    },
  });
  const writer = new JsonOutput(out, 1000);
  writer.write("payload");
  await expect(writer.flush()).rejects.toThrow("EPIPE");
  expect(out.listenerCount("drain")).toBe(1);
  writer.dispose();
});

test("queued output has a hard byte ceiling including Unicode", () => {
  const out = new Writable({ write() {} });
  const writer = new JsonOutput(out, 1000, 6);
  writer.write("猫");
  expect(() => writer.write("猫猫")).toThrow("buffer limit");
  writer.dispose();
  out.destroy();
});

test("stdout false return is honored even when Bun reports no buffered length or needDrain", async () => {
  const out = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      setTimeout(callback, 10);
    },
  });
  Object.defineProperty(out, "writableNeedDrain", { get: () => false });
  Object.defineProperty(out, "writableLength", { get: () => 0 });
  const writer = new JsonOutput(out, 1000);
  writer.write("payload");
  const pending = writer.waitForConsumer();
  expect(pending).toBeInstanceOf(Promise);
  await pending;
  expect(out.listenerCount("drain")).toBe(1);
  writer.dispose();
  out.destroy();
});

test("queued-byte bounds also hold when Bun stdout hides its buffered length", () => {
  const out = new Writable({ highWaterMark: 1, write() {} });
  Object.defineProperty(out, "writableLength", { get: () => 0 });
  const writer = new JsonOutput(out, 1000, 6);
  writer.write("猫");
  writer.write("猫");
  expect(() => writer.write("x")).toThrow("buffer limit");
  writer.dispose();
  out.destroy();
});

test("flush waits for the data itself, not a zero-byte write that completes early", async () => {
  // Bun's stdout acknowledges `write("", cb)` before earlier bytes reach a
  // slow pipe reader; exiting on that receipt truncated piped --json output.
  let delivered = 0;
  const out = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (chunk.length === 0) return callback();
      setTimeout(() => {
        delivered += chunk.length;
        callback();
      }, 20);
    },
  });
  const realWrite = out.write.bind(out);
  // Model the runtime: an empty write's callback fires at once.
  out.write = ((chunk: unknown, ...rest: unknown[]) => {
    const callback = rest.find((value) => typeof value === "function") as
      | ((error?: Error | null) => void)
      | undefined;
    if (chunk === "" && callback) {
      queueMicrotask(() => callback());
      return true;
    }
    return realWrite(chunk as string, ...(rest as []));
  }) as typeof out.write;
  const writer = new JsonOutput(out, 1000);
  try {
    writer.write("a".repeat(1000));
    writer.write("b".repeat(1000));
    await writer.flush();
    expect(delivered).toBe(2000);
  } finally {
    writer.dispose();
    out.destroy();
  }
});

test("flush still surfaces a closed pipe when only direct stream writes happened", async () => {
  // Human receipts write to stdout directly; a lost receipt must still fail.
  const out = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    },
  });
  out.on("error", () => {});
  const writer = new JsonOutput(out, 1000);
  try {
    out.write("receipt\n");
    await expect(writer.flush()).rejects.toThrow();
  } finally {
    writer.dispose();
    out.destroy();
  }
});
