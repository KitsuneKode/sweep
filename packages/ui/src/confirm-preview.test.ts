import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { rankConfirmPreview } from "./confirm-preview.js";

function row(
  id: string,
  name: string,
  bytes: number,
  riskTier: ScanCandidate["riskTier"],
  extra: Partial<ScanCandidate> = {},
): ScanCandidate {
  return {
    id,
    path: `/work/app/${name}`,
    name,
    kind: "custom",
    estimatedBytes: bytes,
    isSymlink: false,
    entryType: "directory",
    riskTier,
    reasons: [],
    selectedByDefault: riskTier === "safe",
    ...extra,
  };
}

describe("confirm preview", () => {
  test("names a small dangerous path ahead of larger safe folders", () => {
    const lines = rankConfirmPreview(
      [
        row("a", "node_modules", 50_000_000_000, "safe"),
        row("b", "target", 40_000_000_000, "safe"),
        row("c", ".next", 30_000_000_000, "safe"),
        row("d", "dist", 12, "dangerous"),
      ],
      "/work",
    );
    expect(lines[0]).toContain("dangerous");
    expect(lines[0]).toContain("app/dist");
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes(".next"))).toBe(false);
  });

  test("drops blocked rows and marks links and partial sizes", () => {
    const lines = rankConfirmPreview(
      [
        row("blocked", "src", 999, "blocked"),
        row("link", "node_modules", 10, "caution", { isSymlink: true, bytesKnown: false }),
      ],
      "/work",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("link only");
    expect(lines[0]).toContain("~");
    expect(lines[0]).not.toContain("src");
  });
});
