import { expect, test } from "bun:test";
import { ApplyRefusedError } from "@kitsunekode/sweep-core/guardrails";
import type { UiApplyResult } from "./outcome.js";
import { UiOperationSession } from "./operation-session.js";

const request = () => ({
  plan: { selectedCandidateIds: ["a", "b", "c"] } as Parameters<
    UiOperationSession["run"]
  >[0]["plan"],
  trash: false,
  signal: new AbortController().signal,
});
function receipt(trash = false): UiApplyResult {
  return {
    interrupted: true,
    ...(trash ? { trashDir: "/owned/trash" } : {}),
    report: {
      protocolVersion: "1",
      targetDir: "/owned/fixture",
      selectedCandidateIds: ["a", "b", "c"],
      deletedCount: 1,
      failedCount: 1,
      totalBytesFreed: 1,
      failedPaths: [{ path: "/owned/fixture/b", error: "interrupted", code: "filesystem_error" }],
      outcomes: [
        { candidateId: "a", status: "deleted" },
        { candidateId: "b", status: "failed" },
        { candidateId: "c", status: "unattempted" },
      ],
    },
  };
}

test("closing drains the active host request and rejects further scheduling", async () => {
  const session = new UiOperationSession();
  let signal!: AbortSignal;
  let resolve!: (result: UiApplyResult) => void;
  const run = session.run(request(), (r) => {
    signal = r.signal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  let settled = false;
  const close = session.close({ type: "abort" }).then((outcome) => {
    settled = true;
    return outcome;
  });
  expect(signal.aborted).toBe(true);
  expect(settled).toBe(false);
  await expect(session.run(request(), async () => receipt())).rejects.toThrow(
    "cannot start another apply",
  );
  resolve(receipt());
  await run;
  expect(await close).toEqual({
    type: "done",
    deletedCount: 1,
    movedCount: 0,
    failedCount: 1,
    unattemptedCount: 1,
    interrupted: true,
    unknownOutcome: false,
  });
});

test("refusals do not invent a disk outcome; transport failure does", async () => {
  const session = new UiOperationSession();
  await expect(
    session.run(request(), async () => {
      throw new ApplyRefusedError("Busy", "apply_busy");
    }),
  ).rejects.toThrow("Busy");
  expect(session.outcome({ type: "abort" })).toEqual({ type: "abort" });
  await expect(
    session.run(request(), async () => {
      throw new Error("lost report");
    }),
  ).rejects.toThrow("lost report");
  expect(await session.close({ type: "abort" })).toMatchObject({
    type: "done",
    unknownOutcome: true,
  });
});

test("trusted receipts accumulate across permanent and trash operations", async () => {
  const session = new UiOperationSession();
  await session.run(request(), async () => receipt());
  await session.run(request(), async () => receipt(true));
  session.viewFailed(new Error("bad\x1b[31m view"));
  const outcome = await session.close({ type: "abort" });
  expect(outcome).toMatchObject({
    type: "done",
    deletedCount: 1,
    movedCount: 1,
    failedCount: 2,
    unattemptedCount: 2,
    interrupted: true,
    unknownOutcome: false,
  });
  expect(JSON.stringify(outcome)).not.toContain("\u001b");
});

test("view failure before an apply is a view error with known zero outcomes", async () => {
  const session = new UiOperationSession();
  session.viewFailed("render failed");
  expect(await session.close({ type: "abort" })).toEqual({
    type: "done",
    deletedCount: 0,
    movedCount: 0,
    failedCount: 0,
    unattemptedCount: 0,
    interrupted: false,
    unknownOutcome: false,
    viewError: "render failed",
  });
});
