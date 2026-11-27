import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants, type Dir, type Dirent } from "node:fs";
import { open, opendir, type FileHandle } from "node:fs/promises";
import { GuardrailError } from "./guardrails.js";
import { ResourceBudget, ResourceLimitError } from "./resource-budget.js";

/**
 * Raised when Bun's incremental JS directory reader cannot launch or keep its
 * Node worker running. Distinct from `ResourceLimitError` so users are told to
 * install Node or use the Rust engine rather than scanning a smaller tree.
 */
export class DirectoryReaderRuntimeError extends GuardrailError {
  constructor(message: string) {
    super(message, 2);
    this.name = "DirectoryReaderRuntimeError";
  }
}

// Bun 1.4's fs.Dir.read/readSync materialize readdir arrays and ignore the
// bufferSize bound. Node's libuv directory handle is genuinely incremental.
// One worker per operation, with one requested batch per live directory.
const WORKER = String.raw`
// Never accept Bun masquerading as Node: its directory API retains arrays.
if (process.versions.bun) process.exit(2);
const { constants } = require("node:fs");
const { open, opendir } = require("node:fs/promises");
const { createInterface } = require("node:readline");
const dirs = new Map();
const nodeParts = (process.versions.node || "").split(".").map(Number);
let useHex = nodeParts[0] === 20 && nodeParts[1] >= 3 && nodeParts[1] < 8;
async function openHandle(rawPath, hex) {
  if (!hex) {
    return { dir: await opendir(rawPath, { encoding: "buffer", bufferSize: 32 }), hex: false, rawPath };
  }
  const utf8 = rawPath.toString("utf8");
  if (Buffer.from(utf8, "utf8").equals(rawPath)) {
    return { dir: await opendir(utf8, { encoding: "hex", bufferSize: 32 }), hex: true, rawPath };
  }
  const fh = await open(rawPath, constants.O_RDONLY | constants.O_DIRECTORY);
  const fdPath = process.platform === "linux" ? "/proc/self/fd/" + fh.fd : "/dev/fd/" + fh.fd;
  try {
    return { dir: await opendir(fdPath, { encoding: "hex", bufferSize: 32 }), hex: true, fh, rawPath };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}
async function closeState(state) {
  try {
    await state.dir.close();
  } finally {
    if (state.fh) await state.fh.close().catch(() => {});
  }
}
async function request(req) {
  if (req.op === "open") {
    if (dirs.size >= 32) throw new Error("directory handle limit exceeded");
    const rawPath = Buffer.from(req.path, "base64");
    dirs.set(req.handle, await openHandle(rawPath, useHex));
    return {};
  }
  let state = dirs.get(req.handle);
  if (req.op === "close") {
    if (state) { dirs.delete(req.handle); await closeState(state); }
    return {};
  }
  if (!state) throw new Error("unknown directory handle");
  const entries = [];
  for (let i = 0; i < 128; i++) {
    let item;
    try {
      item = await state.dir.read();
    } catch (err) {
      if (!state.hex && entries.length === 0 && !state.hasRead && err && err.code === "ERR_INVALID_ARG_TYPE") {
        useHex = true;
        await closeState(state).catch(() => {});
        state = await openHandle(state.rawPath, true);
        dirs.set(req.handle, state);
        item = await state.dir.read();
      } else {
        throw err;
      }
    }
    state.hasRead = true;
    if (!item) return { entries, done: true };
    const type = item.isDirectory() ? "d" : item.isFile() ? "f" : item.isSymbolicLink() ? "l" : "?";
    const buf = state.hex ? Buffer.from(item.name, "hex") : Buffer.from(item.name);
    entries.push({ name: buf.toString("base64"), type });
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
  await Promise.allSettled([...dirs.values()].map(state => closeState(state)));
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
  private stderr = Buffer.alloc(0);
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
    this.proc.on("error", (err: NodeJS.ErrnoException) =>
      this.fail(
        new DirectoryReaderRuntimeError(
          `Node.js runtime unavailable for Bun's incremental directory reader (${err.code ?? err.message}); install Node or use the Rust engine`,
        ),
      ),
    );
    this.proc.on("close", (code, signal) => {
      this.signal?.removeEventListener("abort", this.abort);
      if (!this.failure) {
        const stderrText = this.stderr.toString("utf8").trim();
        this.fail(
          new DirectoryReaderRuntimeError(
            `incremental directory reader stopped (${signal ?? code ?? "unknown status"}); ${stderrText || "install Node or use the Rust engine"}`,
          ),
        );
      }
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
    // Retain a bounded diagnostic tail; a generic stopped-reader message
    // hides the distinction between missing runtime, crash and denied I/O.
    this.proc.stderr.on("data", (chunk: Buffer) => {
      const tail = chunk.subarray(-4096);
      const retained = this.stderr.subarray(Math.max(0, this.stderr.length + tail.length - 4096));
      this.stderr = Buffer.concat([retained, tail]);
    });
    this.proc.stdin.on("error", (error) => this.fail(error));
    if (signal?.aborted) this.abort();
  }

  private fail(error: Error): void {
    // Transport/protocol failures invalidate the entire listing. Treating
    // EPIPE or malformed JSON as an ordinary per-directory I/O error lets
    // discovery silently skip its unread tail and finalize a partial plan.
    this.failure ??=
      error instanceof ResourceLimitError ||
      error instanceof DirectoryReaderRuntimeError ||
      error.name === "AbortError"
        ? error
        : new DirectoryReaderRuntimeError(
            `incremental directory reader failed (${error.message}); install Node or use the Rust engine`,
          );
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

/**
 * Node 20.3.0–20.7.0 had a bug in `Dir.processReadResult` (`node:internal/fs/dir`)
 * where `path.join(this[kDirPath], name)` threw `ERR_INVALID_ARG_TYPE` whenever
 * `encoding: "buffer"` or a `Buffer` directory path was passed to `opendir()`.
 * Using `encoding: "hex"` returns lossless string names, and opening raw non-UTF-8
 * directory paths via an fd (`/proc/self/fd/<fd>`) avoids passing a `Buffer` path.
 */
function isNodeBufferOpendirBroken(
  nodeVersion: string | undefined = process.versions.node,
): boolean {
  if (!nodeVersion) return false;
  const [major, minor] = nodeVersion.split(".").map(Number);
  return major === 20 && minor !== undefined && minor >= 3 && minor < 8;
}

let preferHexOpendir = isNodeBufferOpendirBroken();

interface OpenedDirectoryHandle {
  handle: Dir;
  hex: boolean;
  fdHandle?: FileHandle;
}

async function openDirectoryHandle(
  path: string | Buffer,
  useHex: boolean,
): Promise<OpenedDirectoryHandle> {
  if (!useHex) {
    // @ts-expect-error Node runtime supports raw filename encoding.
    const handle = await opendir(path, { encoding: "buffer", bufferSize: 32 });
    return { handle, hex: false };
  }

  if (typeof path === "string") {
    const handle = await opendir(path, { encoding: "hex", bufferSize: 32 });
    return { handle, hex: true };
  }

  const utf8 = path.toString("utf8");
  if (Buffer.from(utf8, "utf8").equals(path)) {
    const handle = await opendir(utf8, { encoding: "hex", bufferSize: 32 });
    return { handle, hex: true };
  }

  const fdHandle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  const fdPath =
    process.platform === "linux" ? `/proc/self/fd/${fdHandle.fd}` : `/dev/fd/${fdHandle.fd}`;
  try {
    const handle = await opendir(fdPath, { encoding: "hex", bufferSize: 32 });
    return { handle, hex: true, fdHandle };
  } catch (error) {
    await fdHandle.close().catch(() => {});
    throw error;
  }
}

async function closeDirectoryHandle(opened: OpenedDirectoryHandle): Promise<void> {
  try {
    await opened.handle.close();
  } finally {
    if (opened.fdHandle) await opened.fdHandle.close().catch(() => {});
  }
}

/** @internal Exposed for unit-testing the Node 20.3–20.7 hex+fd compatibility path directly. */
export async function* enumerateDirectoryHexForTest(
  path: string | Buffer,
  signal?: AbortSignal,
): AsyncGenerator<{ name: Buffer; type: string }> {
  const opened = await openDirectoryHandle(path, true);
  try {
    while (true) {
      if (signal?.aborted) {
        const error = new Error("Directory enumeration cancelled");
        error.name = "AbortError";
        throw error;
      }
      const item = await opened.handle.read();
      if (!item) return;
      yield {
        name: Buffer.from(item.name, "hex"),
        type: item.isDirectory() ? "d" : item.isFile() ? "f" : item.isSymbolicLink() ? "l" : "?",
      };
    }
  } finally {
    await closeDirectoryHandle(opened);
  }
}

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

  let opened = await openDirectoryHandle(path, preferHexOpendir);
  let yieldedAny = false;
  try {
    while (true) {
      if (signal?.aborted) {
        const error = new Error("Directory enumeration cancelled");
        error.name = "AbortError";
        throw error;
      }
      let item: Dirent<string | Buffer> | null;
      try {
        item = (await opened.handle.read()) as Dirent<string | Buffer> | null;
      } catch (error) {
        if (
          !opened.hex &&
          !yieldedAny &&
          (error as NodeJS.ErrnoException | undefined)?.code === "ERR_INVALID_ARG_TYPE"
        ) {
          preferHexOpendir = true;
          await closeDirectoryHandle(opened).catch(() => {});
          opened = await openDirectoryHandle(path, true);
          item = (await opened.handle.read()) as Dirent<string | Buffer> | null;
        } else {
          throw error;
        }
      }
      if (!item) return;
      yieldedAny = true;
      yield {
        name:
          opened.hex && typeof item.name === "string"
            ? Buffer.from(item.name, "hex")
            : Buffer.from(item.name),
        type: item.isDirectory() ? "d" : item.isFile() ? "f" : item.isSymbolicLink() ? "l" : "?",
      };
    }
  } finally {
    await closeDirectoryHandle(opened);
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
