import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { magnitudeBar } from "./meter-draw.js";
import { reclaimByCost, rebuildFor } from "./project-details.js";
import { ARTIFACT_PREVIEW, buildProjectRows, buildProjects, diskGainedText } from "./projects.js";

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

describe("project queue", () => {
  test("a project-level remove can take safe and caution only", () => {
    const rows = (["safe", "caution", "dangerous", "blocked"] as const).map((riskTier) => ({
      ...candidate(0, 10),
      id: riskTier,
      name: riskTier,
      path: `/work/app/${riskTier}`,
      riskTier,
      projectRoot: "/work/app",
    }));
    const [project] = buildProjects(rows, new Set(), "/work");
    expect(project?.queueable).toEqual(["safe", "caution"]);
    expect(project?.dangerous).toBe(1);
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

describe("one reclaimable number", () => {
  const tiers = (["safe", "caution", "dangerous", "blocked"] as const).map((riskTier, i) => ({
    ...candidate(i, 100 * (i + 1)),
    id: riskTier,
    path: `/work/app/${riskTier}`,
    riskTier,
    projectActiveMs: 1,
  })) as ScanCandidate[];
  const projects = buildProjects(tiers, new Set(), "/work", 100 * 86_400_000);

  test("a project counts safe and caution as space, and keeps the rest apart", () => {
    expect(projects[0]).toMatchObject({ queueableBytes: 300, guardedBytes: 700, bytes: 1000 });
  });

  test("section headers use the same number and name what is guarded", () => {
    const section = buildProjectRows(projects, new Set()).find((row) => row.kind === "section");
    expect(section).toMatchObject({ bytes: 300, guardedBytes: 700 });
  });

  test("projects sort by what can be reclaimed, the number on the row", () => {
    const heavyButGuarded = [
      { ...candidate(0, 5000), id: "g", riskTier: "dangerous", projectRoot: "/work/g" },
      { ...candidate(1, 10), id: "s", riskTier: "safe", projectRoot: "/work/s" },
    ] as ScanCandidate[];
    const sorted = buildProjects(heavyButGuarded, new Set(), "/work");
    expect(sorted.map((p) => p.name)).toEqual(["s", "g"]);
  });
});

describe("the receipt's disk reading", () => {
  const receipt = { removed: 3, failed: 0, trash: false, stopped: false };
  const GiB = 1024 ** 3;
  test("says what the disk gained", () => {
    expect(diskGainedText({ ...receipt, freedBytes: 5 * GiB, diskGained: 5 * GiB })).toBe(
      "disk +5.0 GiB",
    );
  });
  test("names the usual reason when far less came back than estimated", () => {
    expect(diskGainedText({ ...receipt, freedBytes: 5 * GiB, diskGained: GiB })).toContain(
      "hardlinks or another volume",
    );
  });
  test("says nothing when other writes made the reading negative", () => {
    expect(diskGainedText({ ...receipt, freedBytes: 5 * GiB, diskGained: -GiB })).toBe("");
  });
});

describe("the hero bar's parts", () => {
  const items = [
    { ...candidate(0, 400), id: "a", kind: ".turbo", name: ".turbo", riskTier: "safe" },
    { ...candidate(1, 600), id: "b", kind: "node_modules", riskTier: "caution" },
    { ...candidate(2, 9000), id: "c", kind: "node_modules", riskTier: "dangerous" },
  ] as ScanCandidate[];
  const projects = buildProjects(items, new Set(["a"]), "/work");

  test("split reclaimable bytes by rebuild cost, cheapest first, guarded never counted", () => {
    expect(reclaimByCost(projects, new Set(["a"]))).toEqual([
      { cost: "cache", bytes: 400, queuedBytes: 400 },
      { cost: "install", bytes: 600, queuedBytes: 0 },
    ]);
  });
});

describe("what an opt-in kind says about itself", () => {
  test("a catalog name carries its own note; only a user pattern is 'your pattern'", () => {
    expect(rebuildFor("custom" as never, "/work/app", ".venv").how).toBe(
      "virtualenv - slow to recreate",
    );
    expect(rebuildFor("custom" as never, "/work/app", "my-own-dir").how).toBe("your pattern");
  });
});

describe("finished worktrees", () => {
  const NOW = Date.parse("2026-11-18T12:00:00Z");
  const DAY = 86_400_000;
  const worktree = (
    name: string,
    activeDaysAgo: number,
    state?: ScanCandidate["worktreeState"],
  ): ScanCandidate =>
    ({
      id: name,
      path: `/work/app/.worktrees/${name}/node_modules`,
      name: "node_modules",
      estimatedBytes: 600,
      riskTier: "safe",
      projectRoot: `/work/app/.worktrees/${name}`,
      projectActiveMs: NOW - activeDaysAgo * DAY,
      worktreeOf: "/work/app",
      ...(state ? { worktreeState: state } : {}),
    }) as ScanCandidate;

  const projects = buildProjects(
    [
      worktree("merged", 3, "merged"),
      worktree("squashed", 2, "upstream_gone"),
      worktree("old-gone", 45, "upstream_gone"),
      worktree("just-merged", 0, "merged"),
      worktree("open", 2),
    ],
    new Set(),
    "/work",
    NOW,
  );
  const byName = new Map(projects.map((project) => [project.name, project]));

  test("only a proven merged branch left alone for a day reads as finished", () => {
    expect(byName.get("merged")?.section).toBe("finished");
    // D5: upstream_gone must never produce the "Finished worktrees" group.
    expect(byName.get("squashed")?.section).toBe("recent");
    expect(byName.get("old-gone")?.section).toBe("idle");
  });

  test("one merged within the day, and an open one, stay where activity puts them", () => {
    expect(byName.get("just-merged")?.section).toBe("recent");
    expect(byName.get("open")?.section).toBe("recent");
  });

  test("a worktree names its repository and branch state, not the .worktrees folder", () => {
    expect(byName.get("merged")?.parent).toBe("app · merged");
    expect(byName.get("squashed")?.parent).toBe("app · branch missing");
    expect(byName.get("open")?.parent).toBe("app · worktree");
  });

  test("the finished section comes first", () => {
    const sections = buildProjectRows(projects, new Set()).flatMap((row) =>
      row.kind === "section" ? [row.section] : [],
    );
    expect(sections).toEqual(["finished", "idle", "recent"]);
  });
});
