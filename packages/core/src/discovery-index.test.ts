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
import { dirname, relative } from "node:path";
const scenario = process.argv[2];
writeFileSync(process.argv[3], String(process.pid));
let init, revision = 0, selected, requestCount = 0;
function summary(cs = init.plan.candidates) {
  const queued = cs.filter(c => selected.has(c.id));
  const riskCounts = {safe:0,caution:0,dangerous:0,blocked:0};
  const selectedRiskCounts = {safe:0,caution:0,dangerous:0,blocked:0};
  for(const c of cs) riskCounts[c.riskTier]++;
  for(const c of queued) selectedRiskCounts[c.riskTier]++;
  return {generation:init.generation, revision, candidateCount:cs.length,
    estimatedBytes:cs.reduce((n,c)=>n+c.estimatedBytes,0), bytesPartial:cs.some(c=>c.bytesKnown===false),
    selectedCount:queued.length, selectedBytes:queued.reduce((n,c)=>n+c.estimatedBytes,0), selectedBytesPartial:queued.some(c=>c.bytesKnown===false), selectedRiskCounts, riskCounts, retainedBytes:1024};
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
    if(scenario==="bad-queued-risks") s.selectedRiskCounts.safe++;
    await emit({type:"index_ready",summary:s}); continue;
  }
  requestCount++;
  if(scenario==="stall") continue;
  if(m.type==="folders") {
    const groups=new Map();
    for(const c of init.plan.candidates) {
      let scope=relative(init.plan.targetDir,dirname(c.path));
      if(process.platform==="win32") scope=scope.replaceAll("\\", "/");
      let key;
      if(m.scope===null) key=scope.split("/")[0];
      else if(m.scope!=="" && scope.startsWith(m.scope+"/")) key=m.scope+"/"+scope.slice(m.scope.length+1).split("/")[0];
      else continue;
      if(!groups.has(key)) groups.set(key, []);
      groups.get(key).push({c,scope});
    }
    const folders=[...groups].map(([key, rows])=>({key,ownCount:rows.filter(r=>r.scope===key).length,
      hasChildren:rows.some(r=>r.scope!==key),totals:summary(rows.map(r=>r.c))}));
    folders.sort((a,b)=>b.totals.estimatedBytes-a.totals.estimatedBytes);
    const shown=folders.slice(m.offset,m.offset+m.limit);
    const next=m.offset+shown.length;
    const page={generation:init.generation,revision,scope:m.scope,matchingCount:folders.length,offset:m.offset,
      nextOffset:next<folders.length?next:null,folders:shown,summary:summary()};
    if(scenario==="folder-key") shown[0].key="another";
    if(scenario==="folder-count") shown[0].totals.candidateCount++;
    if(scenario==="folder-owned") shown[0].ownCount++;
    if(scenario==="folder-risk") shown[0].totals.riskCounts.safe++;
    if(scenario==="folder-retained") shown[0].totals.retainedBytes++;
    if(scenario==="folder-next") page.nextOffset=0;
    if(scenario==="folder-generation") page.generation="another";
    await emit({type:"folders",requestId:m.requestId,page}); continue;
  }
  if(m.type==="scope" || m.type==="select_scope") {
    const scoped=init.plan.candidates.filter(c=> {
      let key=relative(init.plan.targetDir,dirname(c.path));
      if(process.platform==="win32") key=key.replaceAll("\\", "/");
      return m.scope===null || key===m.scope || (m.scope!=="" && key.startsWith(m.scope+"/"));
    });
    if(m.type==="scope") {
      const totals=summary(scoped); if(scenario==="bad-scope") totals.candidateCount++;
      await emit({type:"scope",requestId:m.requestId,totals,summary:summary()}); continue;
    }
    let changed=false;
    for(const c of scoped) {
      if(m.selected && (c.riskTier==="blocked" || (!m.includeDangerous && c.riskTier==="dangerous"))) continue;
      changed ||= selected.has(c.id)!==m.selected;
      if(m.selected) selected.add(c.id); else selected.delete(c.id);
    }
    if(changed) revision++;
    const s=summary(); if(scenario==="bad-scope-selection") s.selectedBytes++;
    await emit({type:"selection",requestId:m.requestId,summary:s}); continue;
  }
  if(m.type==="retire") {
    init.plan.candidates=init.plan.candidates.filter(c=>!m.candidateIds.includes(c.id));
    for(const id of m.candidateIds) selected.delete(id);
    if(m.candidateIds.length) revision++;
    const s=summary(); if(scenario==="bad-retirement") s.estimatedBytes++;
    await emit({type:"retired",requestId:m.requestId,summary:s}); continue;
  }
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

// Await pipe I/O before invoking matchers. Bun's Windows rejection matcher
// can stall an already-open child pipe until the adapter watchdog fires.
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  const error: unknown = await promise.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  return error;
}

function expectReaped(path: string): void {
  const pid = Number(readFileSync(path, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
}

for (const scenario of [
  "folder-key",
  "folder-count",
  "folder-owned",
  "folder-risk",
  "folder-retained",
  "folder-next",
  "folder-generation",
]) {
  test(`forged folder receipt closes and reaps the generation (${scenario})`, async () => {
    const session = await open(scenario);
    expect(await rejection(session.folders(null, 0, 2))).toMatchObject({
      code: "discovery_protocol",
    });
    await session.close();
    expectReaped(join(root, `${scenario}.pid`));
  });
}

test("folder input refusals preserve valid metadata navigation", async () => {
  const session = await open();
  await rejection(session.folders("../other"));
  await rejection(session.folders(null, 0, 257));
  const folders = await session.folders(null, 0, 2);
  expect(folders.folders.map((folder) => folder.key)).toEqual(["project-2", "project-1"]);
  expect(folders.nextOffset).toBe(2);
  expect(session.summary.selectedCount).toBe(1);
});

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
  expect(changed.selectedRiskCounts).toEqual({ safe: 2, caution: 0, dangerous: 0, blocked: 0 });
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

test("retirement is independently accounted and removes only explicit active IDs", async () => {
  const source = plan();
  const session = await open("good", source);
  await session.select([source.candidates[1]!.id], true);
  const before = session.summary;
  await rejection(session.retire([source.candidates[0]!.id, "missing"]));
  expect(session.summary).toEqual(before);
  const summary = await session.retire([source.candidates[1]!.id]);
  expect(summary.candidateCount).toBe(2);
  expect(summary.estimatedBytes).toBe(202);
  expect(summary.bytesPartial).toBe(false);
  expect(summary.selectedCount).toBe(1);
  expect(summary.selectedBytesPartial).toBe(false);
  expect(summary.selectedRiskCounts.safe).toBe(1);
  expect((await session.snapshot("all")).candidates.map((row) => row.id)).toEqual([
    source.candidates[0]!.id,
    source.candidates[2]!.id,
  ]);
  await rejection(session.select([source.candidates[1]!.id], true));
  await rejection(session.retire([source.candidates[1]!.id]));
});

test("a forged retirement receipt closes the generation", async () => {
  const session = await open("bad-retirement");
  expect(await rejection(session.retire([plan().candidates[0]!.id]))).toMatchObject({
    code: "discovery_protocol",
  });
  expect(() => session.summary).toThrow();
  expect(session.diagnostics.retainedWitnessCount).toBe(0);
});

test("queued risk totals are validated during initialization", async () => {
  expect(await rejection(open("bad-queued-risks"))).toMatchObject({ code: "discovery_protocol" });
});

test("candidate plans are detached and never substitute or mutate the queue", async () => {
  const source = plan();
  const session = await open();
  const row = (await session.query({ offset: 1, limit: 1 })).candidates[0]!;
  const single = session.planForCandidate(row);
  expect(single.selectedCandidateIds).toEqual([source.candidates[1]!.id]);
  expect(single.candidates).toHaveLength(1);
  expect(session.summary.selectedCount).toBe(1);
  expect(session.isSelected(row.id)).toBe(false);
  const unknown = structuredClone(single);
  unknown.selectedCandidateIds = ["missing"];
  expect(() => session.assertReviewedPlan(unknown)).toThrow();
  const duplicate = structuredClone(single);
  duplicate.candidates.push(duplicate.candidates[0]!);
  expect(() => session.assertReviewedPlan(duplicate)).toThrow();
  single.candidates[0]!.reasons.push("changed");
  expect(() => session.assertReviewedPlan(single)).toThrow();
  expect(() =>
    session.planForCandidate({ ...row, path: join(root, "other", "node_modules") }),
  ).toThrow();
  await session.retire([row.id]);
  expect(() => session.planForCandidate(row)).toThrow();
});

test("caller mutation of a pending selection or retirement batch cannot change its receipt", async () => {
  const source = plan();
  const session = await open();
  const ids = [source.candidates[1]!.id];
  const selection = session.select(ids, true);
  ids[0] = source.candidates[2]!.id;
  await selection;
  expect(session.isSelected(source.candidates[1]!.id)).toBe(true);
  const retirementIds = [source.candidates[0]!.id];
  const retired = session.retire(retirementIds);
  retirementIds[0] = source.candidates[1]!.id;
  await retired;
  expect(session.summary.selectedCount).toBe(1);
  expect(session.isSelected(source.candidates[1]!.id)).toBe(true);
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
    expect(await rejection(session.query({ limit: 2 }))).toMatchObject({
      code: scenario === "truncated" ? "discovery_closed" : "discovery_protocol",
    });
    await session.close();
    await expect(session.query()).rejects.toBeInstanceOf(Error);
    const pid = Number(readFileSync(join(root, `${scenario}.pid`), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
}

test("refuses false queue receipts and repeated export pages", async () => {
  const session = await open("bad-selection");
  expect(await rejection(session.select([plan().candidates[1]!.id], true))).toMatchObject({
    code: "discovery_protocol",
  });
  const repeated = await open("repeat-export", plan(600));
  expect(await rejection(repeated.snapshot("all"))).toMatchObject({ code: "discovery_protocol" });
});

test("startup refuses a false aggregate and reaps its child", async () => {
  expect(await rejection(DiscoveryIndexSession.open(plan(), options("bad-ready")))).toMatchObject({
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

test("scope totals and bulk receipts are independently verified", async () => {
  const session = await open();
  const scope = await session.scopeSummary("project-0");
  expect(scope.candidateCount).toBe(1);
  expect(scope.selectedBytes).toBe(100);
  expect(Object.isFrozen(scope.selectedRiskCounts)).toBe(true);
  const total = session.summary;
  expect((await session.scopeSummary("missing")).candidateCount).toBe(0);
  expect(session.summary).toEqual(total);
  await session.selectScope(null, true);
  expect(session.summary.selectedCount).toBe(2);
  expect(session.summary.selectedBytesPartial).toBe(true);
  await session.retire([plan().candidates[1]!.id]);
  expect((await session.scopeSummary("project-1")).candidateCount).toBe(0);
  expect((await session.scopeSummary(null)).bytesPartial).toBe(false);
  for (const scenario of ["bad-scope", "bad-scope-selection"]) {
    const bad = await open(scenario);
    expect(
      await rejection(
        scenario === "bad-scope" ? bad.scopeSummary("project-0") : bad.selectScope(null, true),
      ),
    ).toMatchObject({ code: "discovery_protocol" });
    expect(() => bad.summary).toThrow();
    await bad.close();
    expectReaped(join(root, `${scenario}.pid`));
  }
});

test("a valid reviewed row from the wrong scope or risk cannot enter the page", async () => {
  for (const query of [
    { scope: "project-1", limit: 1 },
    { risk: "blocked" as const, limit: 1 },
  ]) {
    const session = await open();
    expect(await rejection(session.query(query))).toMatchObject({ code: "discovery_protocol" });
    expect(() => session.summary).toThrow();
    await session.close();
    expectReaped(join(root, "good.pid"));
  }
});

test("scope preparation owns the request across yields and cancellation", async () => {
  const source = plan(600);
  const session = await DiscoveryIndexSession.open(source, options());
  sessions.push(session);
  const bulk = session.selectScope(null, true);
  await expect(session.selectScope(null, false)).rejects.toMatchObject({ code: "discovery_busy" });
  await expect(session.select([source.candidates[0]!.id], false)).rejects.toMatchObject({
    code: "discovery_busy",
  });
  await expect(session.query()).rejects.toMatchObject({ code: "discovery_busy" });
  await bulk;
  expect(session.summary.selectedCount).toBe(599);
  expect(session.summary.revision).toBe(1);
  const before = session.summary;
  await expect(session.selectScope("../outside", true)).rejects.toMatchObject({
    code: "discovery_refused",
  });
  expect(session.summary).toEqual(before);
  const pending = session.selectScope(null, false);
  const rejected = rejection(pending);
  await session.close();
  expect(await rejected).toMatchObject({ code: "discovery_closed" });
  expectReaped(join(root, "good.pid"));
});
