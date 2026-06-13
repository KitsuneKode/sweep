import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "./config.js";
import { rustScanBlockedReason } from "./rust-engine.js";

describe("rustScanBlockedReason", () => {
  test("allows default config without streaming or exact sizing", () => {
    expect(rustScanBlockedReason(DEFAULT_CONFIG, DEFAULT_CONFIG, {})).toBeNull();
  });

  test("blocks progressive scan callbacks", () => {
    expect(
      rustScanBlockedReason(DEFAULT_CONFIG, DEFAULT_CONFIG, {
        onEntry: () => {},
      }),
    ).toContain("JS engine");
  });

  test("blocks CLI pattern overrides", () => {
    const withPattern = { ...DEFAULT_CONFIG, patterns: [...DEFAULT_CONFIG.patterns, "custom"] };
    expect(rustScanBlockedReason(withPattern, DEFAULT_CONFIG, {})).toContain("CLI scan flags");
  });

  test("blocks project config overrides", () => {
    const project = { ...DEFAULT_CONFIG, depth: 2 };
    expect(rustScanBlockedReason(project, project, {})).toContain(".sweeprc");
  });
});
