import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { dirname, relative } from "node:path";
import type { RiskTier, ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { hasCanonicalPathSpelling, isPathWithinRoot } from "./guardrails.js";
import { validatePlan, validateScanEvent } from "./plan.js";
import { checkedBytes } from "./resource-budget.js";
import { resolveRustEngineBinary } from "./rust-engine.js";

const MAX_FRAME = 1024 * 1024;
const MAX_SNAPSHOT = 64 * 1024 * 1024;
const MAX_HOST_CHARGE = 64 * 1024 * 1024;
const MAX_PAGE = 256;
const MAX_RECORDS = 100_000;
const MAX_FOLDER_WORK = 32 * 1024 * 1024;
type RiskCounts = ScanPlan["summary"]["riskCounts"];

export class DiscoveryIndexError extends Error {
  constructor(
    readonly code:
      | "discovery_closed"
      | "discovery_busy"
      | "discovery_refused"
      | "discovery_protocol"
      | "discovery_timeout",
    message: string,
  ) {
    super(message);
    this.name = "DiscoveryIndexError";
  }
}

export interface DiscoverySummary {
  readonly generation: string;
  readonly revision: number;
  readonly candidateCount: number;
  readonly estimatedBytes: number;
  readonly bytesPartial: boolean;
  readonly selectedCount: number;
  readonly selectedBytes: number;
  readonly selectedBytesPartial: boolean;
  readonly selectedRiskCounts: Readonly<RiskCounts>;
  readonly riskCounts: Readonly<RiskCounts>;
  readonly retainedBytes: number;
}

export interface DiscoveryQuery {
  filter?: string;
  scope?: string;
  risk?: RiskTier;
  order?: "discovery" | "size" | "name" | "age";
  offset?: number;
  limit?: number;
  now?: number;
}

export interface DiscoveryPage {
  readonly generation: string;
  readonly revision: number;
  readonly matchingCount: number;
  readonly matchingBytes: number;
  readonly matchingBytesPartial: boolean;
  readonly nextOffset: number | null;
  readonly candidates: readonly ScanCandidate[];
  readonly summary: DiscoverySummary;
}

export interface DiscoveryFolder {
  readonly key: string;
  readonly ownCount: number;
  readonly hasChildren: boolean;
  readonly totals: DiscoverySummary;
}
export interface DiscoveryFolderPage {
  readonly generation: string;
  readonly revision: number;
  readonly scope: string | null;
  readonly offset: number;
  readonly matchingCount: number;
  readonly nextOffset: number | null;
  readonly folders: readonly DiscoveryFolder[];
  readonly summary: DiscoverySummary;
}

function childScope(key: string, parent: string | null): string | null {
  if (parent === "") return null;
  const start = parent === null ? 0 : parent.length + 1;
  if (parent !== null && !key.startsWith(`${parent}/`)) return null;
  const end = key.indexOf("/", start);
  return end < 0 ? key : key.slice(0, end);
}

interface Witness {
  digest: string;
  bytes: number;
  partial: boolean;
  risk: RiskTier;
  selected: boolean;
  scope: string;
}

function normalizedScope(scope: string | null): string | null {
  if (scope === null) return null;
  if (typeof scope !== "string")
    throw new DiscoveryIndexError("discovery_refused", "Invalid review scope");
  const key = process.platform === "win32" ? scope.replaceAll("\\", "/") : scope;
  if (
    Buffer.byteLength(key) > 32_768 ||
    (key !== "" && key.split("/").some((part) => !part || part === "." || part === ".."))
  )
    throw new DiscoveryIndexError("discovery_refused", "Invalid review scope");
  return key;
}
function withinScope(key: string, scope: string | null): boolean {
  return scope === null || key === scope || (scope !== "" && key.startsWith(`${scope}/`));
}

function digest(c: ScanCandidate): string {
  // Field order is independent of the peer's JSON object key order.
  return createHash("sha256")
    .update(
      JSON.stringify([
        c.id,
        c.path,
        c.name,
        c.kind,
        c.riskTier,
        c.reasons,
        c.selectedByDefault,
        c.identity ? [c.identity.platform, c.identity.device, c.identity.inode] : null,
        c.estimatedBytes,
        c.bytesKnown ?? null,
        c.modifiedMs ?? null,
        c.isSymlink,
        c.entryType,
      ]),
    )
    .digest("base64");
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new DiscoveryIndexError("discovery_protocol", "Invalid discovery reply shape");
  return value as Record<string, unknown>;
}
function uint(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One read-only native generation. A broken peer closes it; there is no apply or fallback. */
export class DiscoveryIndexSession {
  private preparingScope = false;
  private pending: Pending | undefined;
  private chunks: Uint8Array[] = [];
  private frameBytes = 0;
  private maxReplyBytes = 0;
  private selectedPartialCount = 0;
  private partialCount = 0;
  private stderr = "";
  private failure: Error | undefined;
  private nextId = 0;
  private latest: DiscoverySummary | undefined;
  private readonly exited: Promise<void>;
  private readonly abort: () => void;
  private readonly onData: (chunk: Buffer) => void;
  private readonly onError: (error: Error) => void;
  private readonly onStderr: (chunk: string) => void;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly generation: string,
    private readonly witnesses: Map<string, Witness>,
    private readonly header: Omit<ScanPlan, "candidates" | "selectedCandidateIds" | "summary"> & {
      summary: ScanPlan["summary"];
    },
    private readonly timeout: number,
    private readonly hostRetainedChargeBytes: number,
    private readonly signal?: AbortSignal,
  ) {
    for (const witness of witnesses.values()) {
      if (witness.partial) this.partialCount++;
      if (witness.selected && witness.partial) this.selectedPartialCount++;
    }
    this.abort = () =>
      this.fail(new DiscoveryIndexError("discovery_closed", "Discovery generation cancelled"));
    this.onError = (error) =>
      this.fail(
        new DiscoveryIndexError(
          "discovery_protocol",
          `Discovery transport failed: ${sanitizeTerminalText(error.message).slice(0, 1024)}`,
        ),
      );
    this.onStderr = (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4096);
    };
    this.onData = (chunk) => {
      try {
        if (
          !this.pending ||
          this.frameBytes + chunk.length > MAX_FRAME ||
          this.chunks.length >= 8192
        )
          throw new DiscoveryIndexError(
            "discovery_protocol",
            "Unexpected or oversized discovery reply",
          );
        this.frameBytes += chunk.length;
        const newline = chunk.indexOf(10);
        this.chunks.push(new Uint8Array(chunk));
        if (newline < 0) return;
        if (newline !== chunk.length - 1)
          throw new DiscoveryIndexError(
            "discovery_protocol",
            "Multiple discovery replies for one request",
          );
        const frame = Buffer.concat(this.chunks, this.frameBytes);
        this.maxReplyBytes = Math.max(this.maxReplyBytes, this.frameBytes);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          frame.subarray(0, frame.length - 1),
        );
        this.chunks = [];
        this.frameBytes = 0;
        const value: unknown = JSON.parse(text);
        const envelope = object(value, [
          "type",
          "requestId",
          "summary",
          "totals",
          "page",
          "code",
          "message",
        ]);
        const reply = object(
          value,
          envelope.type === "index_ready"
            ? ["type", "summary"]
            : envelope.type === "page" || envelope.type === "folders"
              ? ["type", "requestId", "page"]
              : envelope.type === "scope"
                ? ["type", "requestId", "summary", "totals"]
                : envelope.type === "selection" || envelope.type === "retired"
                  ? ["type", "requestId", "summary"]
                  : envelope.type === "index_error"
                    ? ["type", "requestId", "code", "message"]
                    : ["type", "requestId"],
        );
        const waiting = this.pending;
        this.pending = undefined;
        clearTimeout(waiting.timer);
        waiting.resolve(reply);
      } catch (error) {
        this.fail(
          error instanceof DiscoveryIndexError
            ? error
            : new DiscoveryIndexError(
                "discovery_protocol",
                "Invalid JSON or UTF-8 discovery reply",
              ),
        );
      }
    };
    this.exited = new Promise((resolve) =>
      child.once("close", () => {
        this.fail(
          new DiscoveryIndexError(
            "discovery_closed",
            `Discovery engine closed: ${sanitizeTerminalText(this.stderr)}`,
          ),
        );
        resolve();
      }),
    );
    child.once("error", this.onError);
    child.stdin.on("error", this.onError);
    child.stdout.on("data", this.onData);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", this.onStderr);
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  static async open(
    plan: ScanPlan,
    options: {
      command?: readonly [string, ...string[]];
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<DiscoveryIndexSession> {
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000)
      throw new DiscoveryIndexError(
        "discovery_refused",
        "Discovery timeout must be between 1 and 30000 ms",
      );
    if (options.signal?.aborted)
      throw new DiscoveryIndexError("discovery_closed", "Discovery generation cancelled");
    // Detach the snapshot from caller mutations before any asynchronous work.
    validatePlan(plan);
    const rawPlan = JSON.stringify(plan);
    if (Buffer.byteLength(rawPlan) + 128 > MAX_SNAPSHOT)
      throw new DiscoveryIndexError("discovery_refused", "Discovery snapshot exceeds 64 MiB");
    const snapshot = validatePlan(JSON.parse(rawPlan));
    if (snapshot.candidates.length > MAX_RECORDS)
      throw new DiscoveryIndexError("discovery_refused", "Discovery candidate limit exceeded");
    const witnesses = new Map<string, Witness>();
    const scopes = new Map<string, string>();
    const selected = new Set(snapshot.selectedCandidateIds);
    if (selected.size !== snapshot.selectedCandidateIds.length)
      throw new DiscoveryIndexError("discovery_refused", "Duplicate initial selected ID");
    const totals = {
      candidateCount: snapshot.candidates.length,
      estimatedBytes: 0,
      bytesPartial: false,
      selectedCount: 0,
      selectedBytes: 0,
      selectedBytesPartial: false,
      selectedRiskCounts: { safe: 0, caution: 0, dangerous: 0, blocked: 0 },
      riskCounts: { safe: 0, caution: 0, dangerous: 0, blocked: 0 },
    };
    let charged = 0;
    for (const c of snapshot.candidates) {
      const scopeKey = normalizedScope(relative(snapshot.targetDir, dirname(c.path)))!;
      let scope = scopes.get(scopeKey);
      if (scope === undefined) {
        scope = scopeKey;
        scopes.set(scopeKey, scope);
        charged += 96 + scope.length * 4;
      }
      charged += 272 + c.id.length * 4;
      if (
        charged > MAX_HOST_CHARGE ||
        !c.id ||
        c.id.length > 80 ||
        witnesses.has(c.id) ||
        !isPathWithinRoot(c.path, snapshot.targetDir)
      )
        throw new DiscoveryIndexError(
          "discovery_refused",
          "Invalid or oversized discovery snapshot",
        );
      const queued = selected.has(c.id);
      if (queued && c.riskTier === "blocked")
        throw new DiscoveryIndexError("discovery_refused", "Blocked candidate cannot be queued");
      witnesses.set(c.id, {
        digest: digest(c),
        bytes: c.estimatedBytes,
        partial: c.bytesKnown === false,
        risk: c.riskTier,
        selected: queued,
        scope,
      });
      totals.estimatedBytes = checkedBytes(totals.estimatedBytes, c.estimatedBytes);
      totals.bytesPartial ||= c.bytesKnown === false;
      totals.riskCounts[c.riskTier]++;
      if (queued) {
        totals.selectedCount++;
        totals.selectedRiskCounts[c.riskTier]++;
        totals.selectedBytes = checkedBytes(totals.selectedBytes, c.estimatedBytes);
        totals.selectedBytesPartial ||= c.bytesKnown === false;
      }
      if (witnesses.size % 256 === 0) {
        await setImmediate();
        if (options.signal?.aborted)
          throw new DiscoveryIndexError("discovery_closed", "Discovery generation cancelled");
      }
    }
    if (selected.size !== totals.selectedCount)
      throw new DiscoveryIndexError("discovery_refused", "Unknown initial selected ID");
    const { candidates: _, selectedCandidateIds: __, ...header } = snapshot;
    const generation = randomUUID();
    const command = options.command ?? [resolveRustEngineBinary()];
    const child = spawn(command[0], [...command.slice(1), "index"], { stdio: "pipe" });
    const session = new DiscoveryIndexSession(
      child,
      generation,
      witnesses,
      header,
      timeout,
      charged,
      options.signal,
    );
    try {
      const reply = await session.exchange(
        `{"generation":${JSON.stringify(generation)},"plan":${rawPlan}}\n`,
      );
      if (reply.type !== "index_ready" || reply.requestId !== undefined)
        throw new DiscoveryIndexError(
          "discovery_protocol",
          "Discovery engine did not acknowledge the snapshot",
        );
      session.latest = session.checkSummary(reply.summary, 0, totals);
      return session;
    } catch (error) {
      session.fail(error instanceof Error ? error : new Error(String(error)));
      await session.close();
      throw error;
    }
  }

  get summary(): DiscoverySummary {
    if (this.failure || !this.latest)
      throw this.failure ?? new DiscoveryIndexError("discovery_closed", "Discovery is not ready");
    return this.latest;
  }
  isSelected(id: string): boolean {
    if (this.failure) throw this.failure;
    return this.witnesses.get(id)?.selected ?? false;
  }

  /** Qualification counters; logical charges do not measure actual RSS. */
  get diagnostics() {
    return Object.freeze({
      pid: this.child.pid,
      hostRetainedChargeBytes: this.failure ? 0 : this.hostRetainedChargeBytes,
      retainedWitnessCount: this.witnesses.size,
      maxReplyBytes: this.maxReplyBytes,
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = undefined;
    }
    this.chunks = [];
    this.frameBytes = 0;
    this.witnesses.clear();
    this.signal?.removeEventListener("abort", this.abort);
    this.child.kill("SIGKILL");
  }

  private exchange(text: string): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending)
      return Promise.reject(
        new DiscoveryIndexError("discovery_busy", "A discovery request is already running"),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            new DiscoveryIndexError(
              "discovery_timeout",
              "Discovery reply timed out; the generation was closed",
            ),
          ),
        this.timeout,
      );
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(text, (error) => {
        if (error) this.onError(error);
      });
    });
  }

  private async request(
    type: string,
    payload: object,
    preparedScope = false,
  ): Promise<Record<string, unknown>> {
    if (this.preparingScope && !preparedScope)
      throw new DiscoveryIndexError("discovery_busy", "A scope request is already running");
    const requestId = ++this.nextId;
    if (requestId > 0xffff_ffff)
      throw new DiscoveryIndexError("discovery_refused", "Discovery request counter exhausted");
    const text = `${JSON.stringify({ type, requestId, ...payload })}\n`;
    if (Buffer.byteLength(text) > 64 * 1024)
      throw new DiscoveryIndexError("discovery_refused", "Discovery request exceeds 64 KiB");
    const reply = await this.exchange(text);
    try {
      if (reply.requestId !== requestId)
        throw new DiscoveryIndexError("discovery_protocol", "Mismatched discovery request ID");
      if (reply.type === "index_error") {
        if (
          reply.code !== "discovery_refused" ||
          typeof reply.message !== "string" ||
          reply.message.length > 1024
        )
          throw new DiscoveryIndexError("discovery_protocol", "Malformed discovery refusal");
        throw new DiscoveryIndexError("discovery_refused", sanitizeTerminalText(reply.message));
      }
      return reply;
    } catch (error) {
      if (!(error instanceof DiscoveryIndexError) || error.code !== "discovery_refused")
        this.fail(error as Error);
      throw error;
    }
  }

  private checkSummary(
    value: unknown,
    revision: number,
    expected: Omit<DiscoverySummary, "generation" | "revision" | "retainedBytes">,
  ): DiscoverySummary {
    const s = object(value, [
      "generation",
      "revision",
      "candidateCount",
      "estimatedBytes",
      "bytesPartial",
      "selectedCount",
      "selectedBytes",
      "selectedBytesPartial",
      "selectedRiskCounts",
      "riskCounts",
      "retainedBytes",
    ]);
    const risks = object(s.riskCounts, ["safe", "caution", "dangerous", "blocked"]);
    const queuedRisks = object(s.selectedRiskCounts, ["safe", "caution", "dangerous", "blocked"]);
    if (
      s.generation !== this.generation ||
      s.revision !== revision ||
      !uint(s.retainedBytes, MAX_HOST_CHARGE) ||
      s.candidateCount !== expected.candidateCount ||
      s.estimatedBytes !== expected.estimatedBytes ||
      s.bytesPartial !== expected.bytesPartial ||
      s.selectedCount !== expected.selectedCount ||
      s.selectedBytes !== expected.selectedBytes ||
      s.selectedBytesPartial !== expected.selectedBytesPartial ||
      Object.keys(expected.riskCounts).some(
        (key) => risks[key] !== expected.riskCounts[key as RiskTier],
      ) ||
      Object.keys(expected.selectedRiskCounts).some(
        (key) => queuedRisks[key] !== expected.selectedRiskCounts[key as RiskTier],
      )
    )
      throw new DiscoveryIndexError(
        "discovery_protocol",
        "Discovery aggregates disagree with the reviewed snapshot or queue",
      );
    return Object.freeze({
      ...s,
      riskCounts: Object.freeze({ ...risks }),
      selectedRiskCounts: Object.freeze({ ...queuedRisks }),
    }) as unknown as DiscoverySummary;
  }

  async query(options: DiscoveryQuery = {}): Promise<DiscoveryPage> {
    const summary = this.summary;
    const query = {
      generation: summary.generation,
      revision: summary.revision,
      filter: options.filter ?? "",
      scope: normalizedScope(options.scope ?? null),
      risk: options.risk ?? null,
      order: options.order ?? "discovery",
      offset: options.offset ?? 0,
      limit: options.limit ?? MAX_PAGE,
      now: options.now ?? Date.now(),
    };
    if (
      typeof query.filter !== "string" ||
      Buffer.byteLength(query.filter) > 1000 ||
      (query.scope !== null &&
        (typeof query.scope !== "string" || Buffer.byteLength(query.scope) > 32_768)) ||
      ![null, "safe", "caution", "dangerous", "blocked"].includes(query.risk) ||
      !["discovery", "size", "name", "age"].includes(query.order) ||
      !uint(query.offset, MAX_RECORDS) ||
      !uint(query.limit, MAX_PAGE) ||
      query.limit === 0 ||
      !uint(query.now)
    )
      throw new DiscoveryIndexError("discovery_refused", "Discovery query limit exceeded");
    const reply = await this.request("query", { query });
    try {
      if (reply.type !== "page")
        throw new DiscoveryIndexError("discovery_protocol", "Expected a discovery page");
      const p = object(reply.page, [
        "generation",
        "revision",
        "matchingCount",
        "matchingBytes",
        "matchingBytesPartial",
        "nextOffset",
        "candidates",
        "summary",
      ]);
      if (
        p.generation !== summary.generation ||
        p.revision !== summary.revision ||
        !uint(p.matchingCount, summary.candidateCount) ||
        !uint(p.matchingBytes, summary.estimatedBytes) ||
        typeof p.matchingBytesPartial !== "boolean" ||
        !Array.isArray(p.candidates) ||
        p.candidates.length > query.limit
      )
        throw new DiscoveryIndexError("discovery_protocol", "Invalid discovery page counters");
      const ids = new Set<string>();
      let bytes = 0;
      for (const value of p.candidates) {
        object(value, [
          "id",
          "path",
          "name",
          "identity",
          "kind",
          "riskTier",
          "reasons",
          "selectedByDefault",
          "estimatedBytes",
          "bytesKnown",
          "modifiedMs",
          "isSymlink",
          "entryType",
        ]);
        const event = validateScanEvent({ type: "candidate_found", candidate: value });
        const c = (event as { candidate: ScanCandidate }).candidate;
        const witness = this.witnesses.get(c.id);
        if (
          !witness ||
          ids.has(c.id) ||
          !withinScope(witness.scope, query.scope) ||
          (query.risk !== null && witness.risk !== query.risk) ||
          !hasCanonicalPathSpelling(c.path) ||
          !isPathWithinRoot(c.path, this.header.targetDir) ||
          digest(c) !== witness.digest
        )
          throw new DiscoveryIndexError(
            "discovery_protocol",
            "Discovery page changed a reviewed candidate",
          );
        ids.add(c.id);
        bytes = checkedBytes(bytes, c.estimatedBytes);
        Object.freeze(c.reasons);
        if (c.identity) Object.freeze(c.identity);
        Object.freeze(c);
      }
      const next = query.offset + p.candidates.length;
      if (
        bytes > p.matchingBytes ||
        next > Math.max(query.offset, p.matchingCount) ||
        (next < p.matchingCount
          ? p.nextOffset !== next || p.candidates.length === 0
          : p.nextOffset !== null)
      )
        throw new DiscoveryIndexError("discovery_protocol", "Invalid discovery pagination");
      p.summary = this.checkSummary(p.summary, summary.revision, summary);
      Object.freeze(p.candidates);
      return Object.freeze(p) as unknown as DiscoveryPage;
    } catch (error) {
      this.fail(
        error instanceof DiscoveryIndexError
          ? error
          : new DiscoveryIndexError("discovery_protocol", "Invalid candidate in discovery page"),
      );
      throw this.failure;
    }
  }

  /** null includes all scopes; "" includes only artifacts directly in the root. */
  async scopeSummary(scope: string | null): Promise<DiscoverySummary> {
    return this.scopeRequest(normalizedScope(scope));
  }

  /** Immediate folder children. Descendant totals come from the whole generation,
   * not the retained artifact page. Empty scope means root items, with no children. */
  async folders(scope: string | null, offset = 0, limit = MAX_PAGE): Promise<DiscoveryFolderPage> {
    const parent = normalizedScope(scope);
    const before = this.summary;
    if (!uint(offset, MAX_RECORDS) || !uint(limit, MAX_PAGE) || limit === 0)
      throw new DiscoveryIndexError("discovery_refused", "Invalid folder page range");
    if (this.pending || this.preparingScope)
      throw new DiscoveryIndexError("discovery_busy", "A discovery request is already running");
    this.preparingScope = true;
    try {
      const groups = new Map<
        string,
        { firstSeen: number; ownCount: number; hasChildren: boolean; totals: DiscoverySummary }
      >();
      let charged = 0;
      let visited = 0;
      for (const witness of this.witnesses.values()) {
        const key = childScope(witness.scope, parent);
        if (key !== null) {
          let group = groups.get(key);
          if (!group) {
            charged += 512 + key.length * 4;
            if (charged > MAX_FOLDER_WORK)
              throw new DiscoveryIndexError(
                "discovery_refused",
                "Folder aggregation memory limit exceeded",
              );
            group = {
              firstSeen: visited,
              ownCount: 0,
              hasChildren: false,
              totals: {
                ...before,
                candidateCount: 0,
                estimatedBytes: 0,
                bytesPartial: false,
                selectedCount: 0,
                selectedBytes: 0,
                selectedBytesPartial: false,
                riskCounts: { safe: 0, caution: 0, dangerous: 0, blocked: 0 },
                selectedRiskCounts: { safe: 0, caution: 0, dangerous: 0, blocked: 0 },
              },
            };
            groups.set(key, group);
          }
          group.ownCount += Number(witness.scope === key);
          group.hasChildren ||= witness.scope !== key;
          // These are private expected values; public receipts stay immutable.
          const totals = group.totals as {
            -readonly [K in keyof DiscoverySummary]: DiscoverySummary[K];
          };
          totals.candidateCount++;
          totals.estimatedBytes += witness.bytes;
          totals.bytesPartial ||= witness.partial;
          (totals.riskCounts as RiskCounts)[witness.risk]++;
          if (witness.selected) {
            totals.selectedCount++;
            totals.selectedBytes += witness.bytes;
            totals.selectedBytesPartial ||= witness.partial;
            (totals.selectedRiskCounts as RiskCounts)[witness.risk]++;
          }
        }
        if (++visited % 256 === 0) {
          await setImmediate();
          this.summary;
        }
      }
      const ordered = [...groups.entries()].sort(
        ([, a], [, b]) =>
          b.totals.estimatedBytes - a.totals.estimatedBytes || a.firstSeen - b.firstSeen,
      );
      const reply = await this.request(
        "folders",
        { generation: before.generation, revision: before.revision, scope: parent, offset, limit },
        true,
      );
      try {
        if (reply.type !== "folders")
          throw new DiscoveryIndexError("discovery_protocol", "Expected a folder page");
        const p = object(reply.page, [
          "generation",
          "revision",
          "scope",
          "matchingCount",
          "offset",
          "nextOffset",
          "folders",
          "summary",
        ]);
        if (
          p.generation !== before.generation ||
          p.revision !== before.revision ||
          p.scope !== parent ||
          p.offset !== offset ||
          p.matchingCount !== ordered.length ||
          !Array.isArray(p.folders) ||
          p.folders.length > limit
        )
          throw new DiscoveryIndexError(
            "discovery_protocol",
            "Invalid folder page range or generation",
          );
        const folders = p.folders.map((value, index) => {
          const row = object(value, ["key", "ownCount", "hasChildren", "totals"]);
          const expected = ordered[offset + index];
          if (
            !expected ||
            row.key !== expected[0] ||
            row.ownCount !== expected[1].ownCount ||
            row.hasChildren !== expected[1].hasChildren
          )
            throw new DiscoveryIndexError(
              "discovery_protocol",
              "Folder page changed scope or ordering",
            );
          const totals = this.checkSummary(row.totals, before.revision, expected[1].totals);
          if (totals.retainedBytes !== before.retainedBytes)
            throw new DiscoveryIndexError(
              "discovery_protocol",
              "Folder page changed retention accounting",
            );
          return Object.freeze({
            key: row.key,
            ownCount: row.ownCount,
            hasChildren: row.hasChildren,
            totals,
          }) as DiscoveryFolder;
        });
        const next = offset + folders.length;
        if (
          next > Math.max(offset, ordered.length) ||
          (next < ordered.length
            ? p.nextOffset !== next || folders.length === 0
            : p.nextOffset !== null)
        )
          throw new DiscoveryIndexError("discovery_protocol", "Invalid folder pagination");
        p.summary = this.checkSummary(p.summary, before.revision, before);
        p.folders = Object.freeze(folders);
        return Object.freeze(p) as unknown as DiscoveryFolderPage;
      } catch (error) {
        this.fail(error as Error);
        throw error;
      }
    } finally {
      this.preparingScope = false;
    }
  }

  /** Metadata-only bulk action, independent of the visible page or text filter.
   * Clearing includes dangerous rows; queueing them requires explicit inclusion. */
  async selectScope(
    scope: string | null,
    selected: boolean,
    includeDangerous = false,
  ): Promise<DiscoverySummary> {
    if (typeof selected !== "boolean" || typeof includeDangerous !== "boolean")
      throw new DiscoveryIndexError("discovery_refused", "Invalid scope selection policy");
    return this.scopeRequest(normalizedScope(scope), { selected, includeDangerous });
  }

  private async scopeRequest(
    scope: string | null,
    change?: { selected: boolean; includeDangerous: boolean },
  ): Promise<DiscoverySummary> {
    const before = this.summary;
    if (this.pending || this.preparingScope)
      throw new DiscoveryIndexError("discovery_busy", "A discovery request is already running");
    this.preparingScope = true;
    try {
      const expected = change
        ? {
            ...before,
            riskCounts: { ...before.riskCounts },
            selectedRiskCounts: { ...before.selectedRiskCounts },
          }
        : {
            ...before,
            candidateCount: 0,
            estimatedBytes: 0,
            bytesPartial: false,
            selectedCount: 0,
            selectedBytes: 0,
            selectedBytesPartial: false,
            riskCounts: { safe: 0, caution: 0, dangerous: 0, blocked: 0 },
            selectedRiskCounts: { safe: 0, caution: 0, dangerous: 0, blocked: 0 },
          };
      let partialCount = change ? this.selectedPartialCount : 0;
      let changed = false;
      let visited = 0;
      const eligible = (w: Witness) =>
        withinScope(w.scope, scope) &&
        (!change?.selected ||
          (w.risk !== "blocked" && (change.includeDangerous || w.risk !== "dangerous")));
      // Yield without releasing request ownership. No candidates or whole-scope ID
      // batch are reconstructed, even for a global queue of 100k rows.
      for (const witness of this.witnesses.values()) {
        if (eligible(witness)) {
          if (change) {
            if (witness.selected !== change.selected) {
              const delta = change.selected ? 1 : -1;
              changed = true;
              expected.selectedCount += delta;
              expected.selectedBytes += delta * witness.bytes;
              expected.selectedRiskCounts[witness.risk] += delta;
              if (witness.partial) partialCount += delta;
            }
          } else {
            expected.candidateCount++;
            expected.estimatedBytes += witness.bytes;
            expected.bytesPartial ||= witness.partial;
            expected.riskCounts[witness.risk]++;
            if (witness.selected) {
              expected.selectedCount++;
              expected.selectedBytes += witness.bytes;
              expected.selectedRiskCounts[witness.risk]++;
              if (witness.partial) partialCount++;
            }
          }
        }
        if (++visited % 256 === 0) {
          await setImmediate();
          this.summary; // Cancel/close invalidates preparation before transport.
        }
      }
      expected.selectedBytesPartial = partialCount > 0;
      const revision = before.revision + Number(changed);
      const reply = await this.request(
        change ? "select_scope" : "scope",
        {
          generation: before.generation,
          revision: before.revision,
          scope,
          ...change,
        },
        true,
      );
      try {
        if (reply.type !== (change ? "selection" : "scope"))
          throw new DiscoveryIndexError("discovery_protocol", "Expected a scope receipt");
        const summary = this.checkSummary(reply.summary, revision, change ? expected : before);
        const totals = change ? summary : this.checkSummary(reply.totals, revision, expected);
        if (
          summary.retainedBytes !== before.retainedBytes ||
          totals.retainedBytes !== before.retainedBytes
        )
          throw new DiscoveryIndexError(
            "discovery_protocol",
            "Scope receipt changed retention accounting",
          );
        if (change) {
          for (const witness of this.witnesses.values())
            if (eligible(witness)) witness.selected = change.selected;
          this.selectedPartialCount = partialCount;
        }
        this.latest = summary;
        return totals;
      } catch (error) {
        this.fail(error as Error);
        throw error;
      }
    } finally {
      this.preparingScope = false;
    }
  }

  async select(ids: readonly string[], selected: boolean): Promise<DiscoverySummary> {
    const candidateIds = [...ids];
    const before = this.summary;
    const unique = new Set(candidateIds);
    if (
      candidateIds.length > MAX_PAGE ||
      unique.size !== candidateIds.length ||
      typeof selected !== "boolean" ||
      candidateIds.some(
        (id) =>
          typeof id !== "string" ||
          !this.witnesses.has(id) ||
          (selected && this.witnesses.get(id)!.risk === "blocked"),
      )
    )
      throw new DiscoveryIndexError(
        "discovery_refused",
        "Selection requires at most 256 distinct, eligible reviewed IDs",
      );
    const expected = { ...before, selectedRiskCounts: { ...before.selectedRiskCounts } };
    let partialCount = this.selectedPartialCount;
    let changed = false;
    for (const id of candidateIds) {
      const witness = this.witnesses.get(id)!;
      if (witness.selected === selected) continue;
      changed = true;
      expected.selectedCount += selected ? 1 : -1;
      expected.selectedRiskCounts[witness.risk] += selected ? 1 : -1;
      expected.selectedBytes += (selected ? 1 : -1) * witness.bytes;
      if (witness.partial) partialCount += selected ? 1 : -1;
    }
    expected.selectedBytesPartial = partialCount > 0;
    const revision = before.revision + Number(changed);
    const reply = await this.request("select", {
      generation: before.generation,
      revision: before.revision,
      candidateIds: candidateIds,
      selected,
    });
    try {
      if (reply.type !== "selection")
        throw new DiscoveryIndexError(
          "discovery_protocol",
          "Expected a discovery selection receipt",
        );
      this.latest = this.checkSummary(reply.summary, revision, expected);
      this.selectedPartialCount = partialCount;
      for (const id of candidateIds) this.witnesses.get(id)!.selected = selected;
      return this.latest;
    } catch (error) {
      this.fail(error as Error);
      throw error;
    }
  }

  /** Review metadata only. Callers retire IDs from an authoritative outcome
   * partition, never from a progress event, missing path or evicted page. */
  async retire(ids: readonly string[]): Promise<DiscoverySummary> {
    const candidateIds = [...ids];
    const before = this.summary;
    if (
      candidateIds.length > MAX_PAGE ||
      new Set(candidateIds).size !== candidateIds.length ||
      candidateIds.some((id) => typeof id !== "string" || !this.witnesses.has(id))
    )
      throw new DiscoveryIndexError(
        "discovery_refused",
        "Retirement requires at most 256 distinct active IDs",
      );
    const expected = {
      ...before,
      riskCounts: { ...before.riskCounts },
      selectedRiskCounts: { ...before.selectedRiskCounts },
    };
    let partialCount = this.partialCount;
    let selectedPartialCount = this.selectedPartialCount;
    for (const id of candidateIds) {
      const witness = this.witnesses.get(id)!;
      expected.candidateCount--;
      expected.estimatedBytes -= witness.bytes;
      expected.riskCounts[witness.risk]--;
      if (witness.partial) partialCount--;
      if (witness.selected) {
        expected.selectedCount--;
        expected.selectedBytes -= witness.bytes;
        expected.selectedRiskCounts[witness.risk]--;
        if (witness.partial) selectedPartialCount--;
      }
    }
    expected.bytesPartial = partialCount > 0;
    expected.selectedBytesPartial = selectedPartialCount > 0;
    const reply = await this.request("retire", {
      generation: before.generation,
      revision: before.revision,
      candidateIds: candidateIds,
    });
    try {
      if (reply.type !== "retired")
        throw new DiscoveryIndexError(
          "discovery_protocol",
          "Expected a discovery retirement receipt",
        );
      this.latest = this.checkSummary(
        reply.summary,
        before.revision + Number(candidateIds.length > 0),
        expected,
      );
      this.partialCount = partialCount;
      this.selectedPartialCount = selectedPartialCount;
      for (const id of candidateIds) this.witnesses.delete(id);
      return this.latest;
    } catch (error) {
      this.fail(error as Error);
      throw error;
    }
  }

  /** Construct an explicit single-row plan without changing the global queue. */
  planForCandidate(candidate: ScanCandidate): ScanPlan {
    this.summary; // Closed generations cannot authorize a fresh review plan.
    const witness = this.witnesses.get(candidate.id);
    if (!witness || witness.risk === "blocked" || digest(candidate) !== witness.digest)
      throw new DiscoveryIndexError(
        "discovery_refused",
        "Candidate is no longer part of this review generation",
      );
    return this.constructPlan([candidate], [candidate.id]);
  }

  /** Bind a host-validated explicit apply plan to this active review generation. */
  assertReviewedPlan(plan: ScanPlan): void {
    this.summary;
    validatePlan(plan);
    const candidateIds = new Set(plan.candidates.map((candidate) => candidate.id));
    const selectedIds = new Set(plan.selectedCandidateIds);
    const targetIdentity = (identity: ScanPlan["targetIdentity"]) =>
      identity ? JSON.stringify([identity.platform, identity.device, identity.inode]) : null;
    if (
      plan.targetDir !== this.header.targetDir ||
      targetIdentity(plan.targetIdentity) !== targetIdentity(this.header.targetIdentity) ||
      candidateIds.size !== plan.candidates.length ||
      selectedIds.size !== plan.selectedCandidateIds.length ||
      plan.selectedCandidateIds.some((id) => !candidateIds.has(id) || !this.witnesses.has(id)) ||
      plan.candidates.some((candidate) => {
        const witness = this.witnesses.get(candidate.id);
        return !witness || digest(candidate) !== witness.digest;
      })
    )
      throw new DiscoveryIndexError(
        "discovery_refused",
        "Apply plan does not belong to this active review generation",
      );
    if (plan.selectedCandidateIds.some((id) => this.witnesses.get(id)?.risk === "blocked"))
      throw new DiscoveryIndexError("discovery_refused", "Blocked candidate cannot be applied");
  }

  /** Export an explicit plan, reconstructing only the requested candidate set. */
  async snapshot(mode: "selected" | "all" = "selected"): Promise<ScanPlan> {
    if (mode !== "selected" && mode !== "all")
      throw new DiscoveryIndexError("discovery_refused", "Unknown discovery export mode");
    const before = this.summary;
    const candidates: ScanCandidate[] = [];
    const seen = new Set<string>();
    let offset = 0;
    do {
      const page = await this.query({
        filter: mode === "selected" ? "is:queued" : "",
        offset,
        order: "discovery",
      });
      if (page.revision !== before.revision)
        throw new DiscoveryIndexError(
          "discovery_refused",
          "Selection changed while constructing the plan",
        );
      for (const c of page.candidates) {
        if (seen.has(c.id) || (mode === "selected" && !this.isSelected(c.id))) {
          this.fail(
            new DiscoveryIndexError(
              "discovery_protocol",
              "Discovery export repeated or widened its selected IDs",
            ),
          );
          throw this.failure;
        }
        seen.add(c.id);
        candidates.push(c);
      }
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (true);
    if (
      candidates.length !== (mode === "selected" ? before.selectedCount : before.candidateCount)
    ) {
      this.fail(
        new DiscoveryIndexError(
          "discovery_protocol",
          "Discovery export omitted reviewed candidates",
        ),
      );
      throw this.failure;
    }
    const selectedCandidateIds = candidates.filter((c) => this.isSelected(c.id)).map((c) => c.id);
    return this.constructPlan(candidates, selectedCandidateIds);
  }

  private constructPlan(
    candidates: readonly ScanCandidate[],
    selectedCandidateIds: string[],
  ): ScanPlan {
    const riskCounts = { safe: 0, caution: 0, dangerous: 0, blocked: 0 };
    let total = 0;
    for (const c of candidates) {
      riskCounts[c.riskTier]++;
      total = checkedBytes(total, c.estimatedBytes);
    }
    const plan = {
      ...this.header,
      candidates,
      selectedCandidateIds,
      summary: {
        ...this.header.summary,
        candidateCount: candidates.length,
        estimatedTotalBytes: total,
        selectedCount: selectedCandidateIds.length,
        riskCounts,
      },
    };
    const encoded = JSON.stringify(plan);
    if (Buffer.byteLength(encoded) > MAX_SNAPSHOT)
      throw new DiscoveryIndexError("discovery_refused", "Exported plan exceeds 64 MiB");
    // Exported plans belong to the caller, including their nested policy and
    // identity objects. Mutating one must not rewrite this generation's header.
    return validatePlan(JSON.parse(encoded));
  }

  async close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.fail(new DiscoveryIndexError("discovery_closed", "Discovery generation closed"));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              this.child.kill("SIGKILL");
              reject(
                new DiscoveryIndexError(
                  "discovery_timeout",
                  "Read-only discovery child did not exit within 1000 ms",
                ),
              );
            }, 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        this.child.stdout.off("data", this.onData);
        this.child.stderr.off("data", this.onStderr);
        this.witnesses.clear();
      }
    })();
    return this.closePromise;
  }
}
