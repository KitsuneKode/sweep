import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { opendir } from "node:fs/promises";
import { ResourceBudget, ResourceLimitError } from "./resource-budget.js";

// Bun 1.4's fs.Dir.read/readSync materialize readdir arrays and ignore the
// bufferSize bound. Node's libuv directory handle is genuinely incremental.
// One worker per operation, with one requested batch per live directory.
const WORKER = String.raw`
// Never accept Bun masquerading as Node: its directory API retains arrays.
if (process.versions.bun) process.exit(2);
const { opendir } = require("node:fs/promises");
const { createInterface } = require("node:readline");
const dirs = new Map();
async function request(req) {
  if (req.op === "open") {
    if (dirs.size >= 32) throw new Error("directory handle limit exceeded");
    dirs.set(req.handle, await opendir(Buffer.from(req.path, "base64"), { encoding: "buffer", bufferSize: 32 }));
    return {};
  }
  const dir = dirs.get(req.handle);
  if (req.op === "close") {
    if (dir) { dirs.delete(req.handle); await dir.close(); }
    return {};
  }
  if (!dir) throw new Error("unknown directory handle");
  const entries = [];
  for (let i = 0; i < 128; i++) {
    const item = await dir.read();
    if (!item) return { entries, done: true };
    const type = item.isDirectory() ? "d" : item.isFile() ? "f" : item.isSymbolicLink() ? "l" : "?";
    entries.push({ name: Buffer.from(item.name).toString("base64"), type });
  }
  return { entries, done: false };
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  if (line.length > 256 * 1024) process.exit(2);
  const req = JSON.parse(line);
  request(req).then(result => {
    process.stdout.write(JSON.stringify({ id: req.id, ...result }) + "\n");
  }, error => {
    process.stdout.write(JSON.stringify({ id: req.id, error: { message: error.message, code: error.code } }) + "\n");
  });
});
lines.on("close", async () => {
  await Promise.allSettled([...dirs.values()].map(dir => dir.close()));
  dirs.clear();
});
`;

interface Reply {
  id: number;
  entries?: Array<{ name: string; type: string }>;
  done?: boolean;
  error?: { message: string; code?: string };
}

class DirectoryWorker {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >();
  private requestId = 0;
  private handleId = 0;
  private active = 0;
  private buffer = "";
  private failure: Error | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly abort: () => void;

  constructor(private readonly signal?: AbortSignal) {
    this.proc = spawn("node", ["--input-type=commonjs", "-e", WORKER], { stdio: "pipe" });
    this.abort = () => {
      const error = new Error("Directory enumeration cancelled");
      error.name = "AbortError";
      this.fail(error);
    };
    signal?.addEventListener("abort", this.abort, { once: true });
    this.proc.on("error", () =>
      this.fail(
        new ResourceLimitError(
          "incremental directory reader unavailable; install Node or use the Rust engine",
        ),
      ),
    );
    this.proc.on("close", () => {
      this.signal?.removeEventListener("abort", this.abort);
      if (!this.failure)
        this.fail(
          new ResourceLimitError(
            "incremental directory reader stopped; install Node or use the Rust engine",
          ),
        );
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      try {
        this.buffer += chunk;
        let newline: number;
        while ((newline = this.buffer.indexOf("\n")) !== -1) {
          if (newline > 256 * 1024) throw new ResourceLimitError("directory reader response");
          const reply = JSON.parse(this.buffer.slice(0, newline)) as Reply;
          this.buffer = this.buffer.slice(newline + 1);
          const waiting = this.pending.get(reply.id);
          if (!waiting) throw new ResourceLimitError("unexpected directory reader response");
          this.pending.delete(reply.id);
          if (reply.error)
            waiting.reject(
              Object.assign(new Error(reply.error.message), { code: reply.error.code }),
            );
          else waiting.resolve(reply);
        }
        if (this.buffer.length > 256 * 1024)
          throw new ResourceLimitError("directory reader response");
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    // Drain diagnostics without retaining arbitrary stderr data.
    this.proc.stderr.resume();
    this.proc.stdin.on("error", (error) => this.fail(error));
    if (signal?.aborted) this.abort();
  }

  private fail(error: Error): void {
    this.failure ??= error;
    clearTimeout(this.idle);
    for (const waiting of this.pending.values()) waiting.reject(this.failure);
    this.pending.clear();
    this.proc.kill("SIGKILL");
  }

  private request(op: string, handle: number, path?: string | Buffer): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(
        `${JSON.stringify({ id, op, handle, ...(path === undefined ? {} : { path: Buffer.from(path).toString("base64") }) })}\n`,
      );
    });
  }

  async *read(path: string | Buffer): AsyncGenerator<{ name: Buffer; type: string }> {
    clearTimeout(this.idle);
    if (this.active >= 32) throw new ResourceLimitError("directory handles");
    this.active++;
    const handle = ++this.handleId;
    try {
      await this.request("open", handle, path);
      while (true) {
        const reply = await this.request("read", handle);
        if (!Array.isArray(reply.entries) || reply.entries.length > 128)
          throw new ResourceLimitError("directory reader batch");
        for (const item of reply.entries) {
          if (this.failure) throw this.failure;
          if (
            typeof item.name !== "string" ||
            item.name.length > 8192 ||
            !["d", "f", "l", "?"].includes(item.type)
          )
            throw new ResourceLimitError("directory reader entry");
          yield { name: Buffer.from(item.name, "base64"), type: item.type };
        }
        if (reply.done) return;
      }
    } finally {
      try {
        if (!this.failure) await this.request("close", handle);
      } finally {
        this.active--;
        if (this.active === 0) this.idle = setTimeout(() => this.dispose(), 100);
      }
    }
  }

  get available(): boolean {
    return this.failure === undefined;
  }

  dispose(): void {
    clearTimeout(this.idle);
    this.signal?.removeEventListener("abort", this.abort);
    this.fail(new Error("Directory reader disposed"));
  }
}

const workers = new WeakMap<ResourceBudget, DirectoryWorker>();

export function disposeDirectoryReader(budget: ResourceBudget): void {
  workers.get(budget)?.dispose();
  workers.delete(budget);
}

export type DirectoryEntrySource = (
  path: string | Buffer,
  budget: ResourceBudget,
  signal?: AbortSignal,
) => AsyncGenerator<{ name: Buffer; type: string }>;

/** Real bounded enumeration, including under Bun's array-backed fs.Dir. */
async function* enumerateDirectory(
  path: string | Buffer,
  budget: ResourceBudget,
  signal?: AbortSignal,
): AsyncGenerator<{ name: Buffer; type: string }> {
  budget.check();
  if (signal?.aborted) {
    const error = new Error("Directory enumeration cancelled");
    error.name = "AbortError";
    throw error;
  }
  if (process.versions.bun) {
    let worker = workers.get(budget);
    if (!worker?.available) {
      worker = new DirectoryWorker(signal);
      workers.set(budget, worker);
    }
    yield* worker.read(path);
    return;
  }
  // @ts-expect-error Node runtime supports raw filename encoding.
  const handle = await opendir(path, { encoding: "buffer", bufferSize: 32 });
  try {
    while (true) {
      if (signal?.aborted) {
        const error = new Error("Directory enumeration cancelled");
        error.name = "AbortError";
        throw error;
      }
      const item = await handle.read();
      if (!item) return;
      yield {
        name: Buffer.from(item.name),
        type: item.isDirectory() ? "d" : item.isFile() ? "f" : item.isSymbolicLink() ? "l" : "?",
      };
    }
  } finally {
    await handle.close();
  }
}

// Test seam: nothing on a normal filesystem can mint a DT_UNKNOWN dirent, so
// coverage for the "?" arm needs a reader that lies about types.
let entrySource: DirectoryEntrySource = enumerateDirectory;

export function stubDirectoryEntriesForTest(source?: DirectoryEntrySource): void {
  entrySource = source ?? enumerateDirectory;
}

export async function* directoryEntries(
  path: string | Buffer,
  budget: ResourceBudget,
  signal?: AbortSignal,
): AsyncGenerator<{ name: Buffer; type: string }> {
  yield* entrySource(path, budget, signal);
}
