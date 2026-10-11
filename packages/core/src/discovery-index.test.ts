import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import { DiscoveryIndexSession } from "./discovery-index.js";
import { isRustEngineAvailable, resolveRustEngineBinary } from "./rust-engine.js";

const nativeAvailable = isRustEngineAvailable();
if (process.env.SWEEP_REQUIRE_RUST_TESTS === "1" && !nativeAvailable)
  throw new Error("Native discovery tests are required but the engine is unavailable");

let root: string;
const sessions: DiscoveryIndexSession[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sweep-index-adapter-"));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  rmSync(root, { recursive: true, force: true });
});

function plan(count = 3): ScanPlan {
  const candidates = Array.from({ length: count }, (_, i) => ({
    id: `cand_fixture_${i}`,
    path: join(root, `project-${i}`, "node_modules"),
    name: "node_modules",
    kind: "node_modules" as const,
    entryType: "directory" as const,
    isSymlink: false,
    estimatedBytes: 100 + i,
    bytesKnown: i !== 1,
    modifiedMs: 1000,
    riskTier: i === count - 1 ? ("blocked" as const) : ("safe" as const),
    reasons: ["default-pattern", "東京😀"],
    selectedByDefault: false,
  }));
  return {
    protocolVersion: "1",
    targetDir: root,
    createdAt: new Date(1000).toISOString(),
    selectionPolicy: { mode: "default", includeDangerous: false },
    candidates,
    selectedCandidateIds: count > 1 ? [candidates[0]!.id] : [],
    summary: {
      candidateCount: count,
      estimatedTotalBytes: candidates.reduce((sum, c) => sum + c.estimatedBytes, 0),
      scannedDirs: count,
      exact: false,
      selectedCount: count > 1 ? 1 : 0,
      riskCounts: { safe: count - 1, caution: 0, dangerous: 0, blocked: 1 },
    },
  };
}

// A real subprocess exercises pipe fragmentation, EOF and child lifecycle.
const peer = String.raw`
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const scenario = process.argv[2];
writeFileSync(process.argv[3], String(process.pid));
let init, revision = 0, selected, requestCount = 0;
function summary() {
  const cs = init.plan.candidates, queued = cs.filter(c => selected.has(c.id));
  const riskCounts = {safe:0,caution:0,dangerous:0,blocked:0};
  for(const c of cs) riskCounts[c.riskTier]++;
  return {generation:init.generation, revision, candidateCount:cs.length,
    estimatedBytes:cs.reduce((n,c)=>n+c.estimatedBytes,0), bytesPartial:cs.some(c=>c.bytesKnown===false),
    selectedCount:queued.length, selectedBytes:queued.reduce((n,c)=>n+c.estimatedBytes,0), selectedBytesPartial:queued.some(c=>c.bytesKnown===false), riskCounts, retainedBytes:1024};
}
async function emit(value) {
  const bytes = Buffer.from(JSON.stringify(value)+"\n");
  if(scenario === "split") {
    const pivot = bytes.indexOf(Buffer.from("東京"));
    if(pivot >= 0) {
      process.stdout.write(bytes.subarray(0,pivot+1));
      await new Promise(r=>setTimeout(r,5));
      process.stdout.write(bytes.subarray(pivot+1,pivot+4));
      await new Promise(r=>setTimeout(r,5));
      process.stdout.write(bytes.subarray(pivot+4));
      return;
    }
  }
  process.stdout.write(bytes);
}
for await (const line of createInterface({input:process.stdin})) {
  const m = JSON.parse(line);
  if(!init) {
    init=m; selected=new Set(m.plan.selectedCandidateIds);
    const s=summary(); if(scenario==="bad-ready") s.selectedCount++;
    await emit({type:"index_ready",summary:s}); continue;
  }
  requestCount++;
  if(scenario==="stall") continue;
  if(m.type==="select") {
    let changed=false;
    for(const id of m.candidateIds) { changed ||= selected.has(id)!==m.selected; if(m.selected) selected.add(id); else selected.delete(id); }
    if(changed) revision++;
    const s=summary(); if(scenario==="bad-selection") s.selectedBytes++;
    await emit({type:"selection",requestId:m.requestId,summary:s}); continue;
  }
  let cs=init.plan.candidates;
  if(m.query.filter==="is:queued") cs=cs.filter(c=>selected.has(c.id));
  const shown=cs.slice(m.query.offset,m.query.offset+m.query.limit);
  const next=m.query.offset+shown.length;
  const page={generation:init.generation,revision,matchingCount:cs.length,matchingBytes:cs.reduce((n,c)=>n+c.estimatedBytes,0),matchingBytesPartial:cs.some(c=>c.bytesKnown===false),nextOffset:next<cs.length?next:null,candidates:shown,summary:summary()};
  const reply={type:"page",requestId:m.requestId,page};
  if(scenario==="wrong-id") reply.requestId++;
  if(scenario==="wrong-envelope") reply.message="unexpected";
  if(scenario==="wrong-generation") page.generation="another-generation";
  if(scenario==="wrong-count") page.summary.candidateCount++;
  if(scenario==="wrong-next") page.nextOffset=0;
  if(scenario==="forged-path") shown[0].path=init.plan.targetDir+"/other/node_modules";
  if(scenario==="forged-reason") shown[0].reasons=["default-pattern"];
  if(scenario==="duplicate") { shown.push(shown[0]); page.matchingCount++; }
  if(scenario==="unknown-field") shown[0].authority="apply";
  if(scenario==="repeat-export" && requestCount>1) page.candidates=init.plan.candidates.slice(0,shown.length);
  if(scenario==="truncated") { process.stdout.write(JSON.stringify(reply)); process.exit(0); }
  if(scenario==="oversized") { process.stdout.write("x".repeat(1024*1024+1)); continue; }
  if(scenario==="invalid-utf8") { process.stdout.write(Buffer.from([0xff,10])); continue; }
  if(scenario==="multiple") { process.stdout.write(JSON.stringify(reply)+"\n"+JSON.stringify(reply)+"\n"); continue; }
  if(scenario==="bad-json") { process.stdout.write("{\n"); continue; }
  await emit(reply);
}
`;

function options(scenario = "good", timeoutMs = 2000) {
  const script = join(root, `${scenario}.mjs`);
  const pid = join(root, `${scenario}.pid`);
  writeFileSync(script, peer);
  return { command: [process.execPath, script, scenario, pid] as [string, ...string[]], timeoutMs };
}
async function open(scenario = "good", source = plan(), timeoutMs = 2000) {
  const session = await DiscoveryIndexSession.open(source, options(scenario, timeoutMs));
  sessions.push(session);
  return session;
}

test("pages are immutable, split UTF-8 survives, and queued IDs survive page eviction", async () => {
  const source = plan(600);
  const session = await open("split", source);
  const first = await session.query({ limit: 2 });
  expect(first.candidates).toEqual(source.candidates.slice(0, 2));
  expect(Object.isFrozen(first.candidates[0]!.reasons)).toBe(true);
  expect(Object.isFrozen(first.summary.riskCounts)).toBe(true);
  await session.select([source.candidates[500]!.id], true);
  const far = await session.query({ offset: 500, limit: 2 });
  expect(far.candidates[0]!.id).toBe(source.candidates[500]!.id);
  expect(session.isSelected(source.candidates[0]!.id)).toBe(true);
  expect(session.isSelected(source.candidates[500]!.id)).toBe(true);
  const selected = await session.snapshot();
  expect(selected.candidates.map((c) => c.id)).toEqual([
    source.candidates[0]!.id,
    source.candidates[500]!.id,
  ]);
  expect(selected.selectedCandidateIds).toEqual(selected.candidates.map((c) => c.id));
  expect((await session.snapshot("all")).candidates).toEqual(source.candidates);
});

test("selection is atomic, explicit, idempotent and independently accounted", async () => {
  const source = plan();
  const session = await open();
  const before = session.summary;
  await expect(session.select([source.candidates[1]!.id, "missing"], true)).rejects.toMatchObject({
    code: "discovery_refused",
  });
  await expect(
    session.select([source.candidates[1]!.id, source.candidates[2]!.id], true),
  ).rejects.toMatchObject({ code: "discovery_refused" });
  expect(session.summary).toEqual(before);
  expect(session.isSelected(source.candidates[1]!.id)).toBe(false);
  const changed = await session.select([source.candidates[1]!.id], true);
  expect(changed.selectedCount).toBe(2);
  expect(changed.selectedBytes).toBe(201);
  expect(changed.selectedBytesPartial).toBe(true);
  expect((await session.select([source.candidates[1]!.id], true)).revision).toBe(changed.revision);
  expect((await session.select([source.candidates[1]!.id], false)).selectedBytesPartial).toBe(
    false,
  );
});

test("caller mutation after open cannot change a reviewed snapshot", async () => {
  const source = plan(300);
  const pending = DiscoveryIndexSession.open(source, options());
  source.candidates[0]!.path = join(root, "changed", "node_modules");
  const session = await pending;
  sessions.push(session);
  expect((await session.query({ limit: 1 })).candidates[0]!.path).toBe(
    join(root, "project-0", "node_modules"),
  );
});

test("an exported plan owns its nested objects and cannot rewrite later exports", async () => {
  const session = await open();
  const exported = await session.snapshot();
  exported.selectionPolicy.includeDangerous = true;
  exported.summary.riskCounts.safe = 999;
  exported.candidates[0]!.reasons.push("changed");
  const fresh = await session.snapshot();
  expect(fresh.selectionPolicy.includeDangerous).toBe(false);
  expect(fresh.summary.riskCounts.safe).toBe(1);
  expect(fresh.candidates[0]!.reasons).toEqual(["default-pattern", "東京😀"]);
});

for (const scenario of [
  "wrong-id",
  "wrong-envelope",
  "wrong-generation",
  "wrong-count",
  "wrong-next",
  "forged-path",
  "forged-reason",
  "duplicate",
  "unknown-field",
  "truncated",
  "oversized",
  "invalid-utf8",
  "multiple",
  "bad-json",
]) {
  test(`malformed peer closes the generation (${scenario})`, async () => {
    const session = await open(scenario);
    await expect(session.query({ limit: 2 })).rejects.toBeInstanceOf(Error);
    await session.close();
    await expect(session.query()).rejects.toBeInstanceOf(Error);
    const pid = Number(readFileSync(join(root, `${scenario}.pid`), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
}

test("refuses false queue receipts and repeated export pages", async () => {
  const session = await open("bad-selection");
  await expect(session.select([plan().candidates[1]!.id], true)).rejects.toMatchObject({
    code: "discovery_protocol",
  });
  const repeated = await open("repeat-export", plan(600));
  await expect(repeated.snapshot("all")).rejects.toMatchObject({ code: "discovery_protocol" });
});

test("startup refuses a false aggregate and reaps its child", async () => {
  await expect(DiscoveryIndexSession.open(plan(), options("bad-ready"))).rejects.toMatchObject({
    code: "discovery_protocol",
  });
  const pid = Number(readFileSync(join(root, "bad-ready.pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

test("timeouts and cancellation reap the child; overlapping calls cannot queue requests", async () => {
  const session = await open("stall", plan(), 1000);
  const waiting = session.query();
  const failure = waiting.catch((error: unknown) => error);
  await expect(session.query()).rejects.toMatchObject({ code: "discovery_busy" });
  expect(await failure).toMatchObject({ code: "discovery_timeout" });
  await session.close();
  const controller = new AbortController();
  const cancellable = await DiscoveryIndexSession.open(plan(), {
    ...options("stall"),
    signal: controller.signal,
  });
  sessions.push(cancellable);
  const cancelled = cancellable.query().catch((error: unknown) => error);
  controller.abort();
  expect(await cancelled).toMatchObject({ code: "discovery_closed" });
  await cancellable.close();
  expect(() => process.kill(Number(readFileSync(join(root, "stall.pid"), "utf8")), 0)).toThrow();
});

test("invalid local queries and malformed input do not launch or poison a valid generation", async () => {
  const source = plan();
  source.selectedCandidateIds.push("missing");
  await expect(DiscoveryIndexSession.open(source, options("invalid-input"))).rejects.toMatchObject({
    code: "discovery_refused",
  });
  expect(existsSync(join(root, "invalid-input.pid"))).toBe(false);
  const session = await open();
  await expect(session.query({ filter: "x".repeat(1001) })).rejects.toMatchObject({
    code: "discovery_refused",
  });
  await expect(session.query({ limit: 257 })).rejects.toMatchObject({ code: "discovery_refused" });
  expect((await session.query({ limit: 1 })).candidates).toHaveLength(1);
});

test.skipIf(!nativeAvailable)(
  "native adapter preserves exact reviewed metadata and releases repeated generations",
  async () => {
    for (let i = 0; i < 5; i++) {
      const source = plan(600);
      const session = await DiscoveryIndexSession.open(source, {
        command: [resolveRustEngineBinary()],
      });
      sessions.push(session);
      expect((await session.query({ offset: 257, limit: 3 })).candidates).toEqual(
        source.candidates.slice(257, 260),
      );
      await session.select([source.candidates[500]!.id], true);
      expect((await session.snapshot()).selectedCandidateIds).toEqual([
        source.candidates[0]!.id,
        source.candidates[500]!.id,
      ]);
      await session.close();
      await expect(session.query()).rejects.toMatchObject({ code: "discovery_closed" });
    }
  },
);

test("closing does not turn a previously queued ID into an unqueued answer", async () => {
  const source = plan();
  const session = await open();
  expect(session.isSelected(source.selectedCandidateIds[0]!)).toBe(true);
  await session.close();
  expect(() => session.isSelected(source.selectedCandidateIds[0]!)).toThrow("closed");
});
