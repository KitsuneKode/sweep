import { expect, test } from "bun:test";
import {
  hasApplyOutcomeUnresolved,
  noteApplyBackendEntered,
  noteApplyReportTrusted,
  setActiveApply,
} from "./apply-lifecycle.js";

test("backend authority differs from entering preflight and persists through a lost report", () => {
  const controller = new AbortController();
  setActiveApply(controller);
  expect(hasApplyOutcomeUnresolved()).toBe(false);
  noteApplyBackendEntered();
  expect(hasApplyOutcomeUnresolved()).toBe(true);
  setActiveApply(undefined);
  expect(hasApplyOutcomeUnresolved()).toBe(true);
  noteApplyReportTrusted();
  expect(hasApplyOutcomeUnresolved()).toBe(false);
});
