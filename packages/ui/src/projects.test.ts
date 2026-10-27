import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { magnitudeBar } from "./meter-draw.js";
import { ARTIFACT_PREVIEW, buildProjectRows, buildProjects } from "./projects.js";

function candidate(index: number, bytes: number): ScanCandidate {
  return {
    id: `c${index}`,
    path: `/work/app/packages/p${index}/node_modules`,
    name: "node_modules",
    estimatedBytes: bytes,
    riskTier: "safe",
    projectRoot: "/work/app",
  } as ScanCandidate;
}

describe("opened projects", () => {
  const many = Array.from({ length: 20 }, (_, i) => candidate(i, 1000 - i));
  const [project] = buildProjects(many, new Set(), "/work");

  test("list the biggest few and fold the small tail into one row", () => {
    const rows = buildProjectRows([project!], new Set(["/work/app"]));
    const artifacts = rows.filter((row) => row.kind === "artifact");
    const tail = rows.find((row) => row.kind === "moreArtifacts");
    expect(artifacts).toHaveLength(ARTIFACT_PREVIEW);
    expect(tail).toMatchObject({ count: 20 - ARTIFACT_PREVIEW });
  });

  test("list everything once asked, and never fold just one or two", () => {
    const all = buildProjectRows(
      [project!],
      new Set(["/work/app"]),
      new Set(),
      new Set(["/work/app"]),
    );
    expect(all.filter((row) => row.kind === "artifact")).toHaveLength(20);
    const [small] = buildProjects(many.slice(0, ARTIFACT_PREVIEW + 2), new Set(), "/work");
    const rows = buildProjectRows([small!], new Set(["/work/app"]));
    expect(rows.some((row) => row.kind === "moreArtifacts")).toBe(false);
  });
});

describe("magnitude bars", () => {
  test("measure in eighths of a cell and keep a sliver for anything above zero", () => {
    expect(magnitudeBar(1, 4)).toBe("████");
    expect(magnitudeBar(0.5, 3)).toBe("█▌ ");
    expect(magnitudeBar(0.0001, 4)).toBe("▏   ");
    expect(magnitudeBar(0, 2)).toBe("  ");
  });
});
