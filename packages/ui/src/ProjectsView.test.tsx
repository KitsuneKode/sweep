import { afterEach, describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { buildProjectRows, buildProjects } from "./projects.js";
import { ProjectsView } from "./ProjectsView.js";
import { categoryGlyph, type CategoryIconId } from "./presentation.js";
import { cellWidth } from "./text-cells.js";
import { darkTheme } from "./theme.js";

let teardown: (() => void) | undefined;
afterEach(async () => {
  await act(async () => teardown?.());
  teardown = undefined;
});

describe("ProjectsView search box", () => {
  test("uses supported older:30d hint (not idle:30d) and shows filterAdvice for malformed queries", async () => {
    const baseProps = {
      tokens: darkTheme,
      width: 100,
      height: 24,
      target: "/tmp/projects",
      rows: [],
      cursor: 0,
      now: Date.now(),
      scanning: false,
      sizedLabel: "",
      reclaimableBytes: 0,
      idleBytes: 0,
      projectCount: 0,
      selectedBytes: 0,
      selectedCount: 0,
      selectedIds: new Set<string>(),
      diskFree: null,
      searchFocused: true,
      footer: <text content="footer" />,
      onFilterInput: () => {},
      onFilterSubmit: () => {},
      onRowPress: () => {},
      onCursorDelta: () => {},
    };

    const emptySearch = await testRender(<ProjectsView {...baseProps} filter="" />, {
      width: 100,
      height: 24,
    });
    teardown = emptySearch.renderer.destroy.bind(emptySearch.renderer);
    await act(async () => {
      await emptySearch.renderOnce();
    });
    const emptyFrame = emptySearch.captureCharFrame();
    expect(emptyFrame).toContain("older:30d");
    expect(emptyFrame).not.toContain("idle:30d");
    await act(async () => teardown?.());
    teardown = undefined;

    const malformed = await testRender(<ProjectsView {...baseProps} filter="idle:30d" />, {
      width: 100,
      height: 24,
    });
    teardown = malformed.renderer.destroy.bind(malformed.renderer);
    await act(async () => {
      await malformed.renderOnce();
    });
    const malformedFrame = malformed.captureCharFrame();
    expect(malformedFrame).toContain("idle: isn't a filter");
  });

  test("shows honest 'about X freed' alongside apparent size when hardlinks reduce unique bytes", async () => {
    const view = await testRender(
      <ProjectsView
        tokens={darkTheme}
        width={110}
        height={24}
        target="/tmp/projects"
        rows={[]}
        cursor={0}
        now={Date.now()}
        scanning={false}
        sizedLabel=""
        reclaimableBytes={20 * 1024 * 1024}
        uniqueReclaimableBytes={2 * 1024 * 1024}
        idleBytes={0}
        projectCount={2}
        selectedBytes={0}
        selectedCount={0}
        selectedIds={new Set<string>()}
        diskFree={null}
        filter=""
        searchFocused={false}
        footer={<text content="footer" />}
        onFilterInput={() => {}}
        onFilterSubmit={() => {}}
        onRowPress={() => {}}
        onCursorDelta={() => {}}
      />,
      { width: 110, height: 24 },
    );
    teardown = view.renderer.destroy.bind(view.renderer);
    await act(async () => {
      await view.renderOnce();
    });
    const frame = view.captureCharFrame();
    expect(frame).toContain("about 2.0 MiB freed");
    expect(frame).toContain("20.0 MiB apparent");
  });

  test("falls back to apparent with qualifier when uniqueBytesPartial is true", async () => {
    const view = await testRender(
      <ProjectsView
        tokens={darkTheme}
        width={110}
        height={24}
        target="/tmp/projects"
        rows={[]}
        cursor={0}
        now={Date.now()}
        scanning={false}
        sizedLabel=""
        reclaimableBytes={20 * 1024 * 1024}
        uniqueReclaimableBytes={2 * 1024 * 1024}
        uniqueBytesPartial={true}
        idleBytes={0}
        projectCount={2}
        selectedBytes={0}
        selectedCount={0}
        selectedIds={new Set<string>()}
        diskFree={null}
        filter=""
        searchFocused={false}
        footer={<text content="footer" />}
        onFilterInput={() => {}}
        onFilterSubmit={() => {}}
        onRowPress={() => {}}
        onCursorDelta={() => {}}
      />,
      { width: 110, height: 24 },
    );
    teardown = view.renderer.destroy.bind(view.renderer);
    await act(async () => {
      await view.renderOnce();
    });
    const frame = view.captureCharFrame();
    expect(frame).not.toContain("about 2.0 MiB freed");
    expect(frame).toContain("20.0 MiB you can reclaim");
    expect(frame).toContain("shared hardlinks not fully counted");
  });
});

describe("C+ category glyphs", () => {
  test("every category icon stays <= 1 cell across plain, nerd, letter, and NO_COLOR modes", () => {
    const ids: CategoryIconId[] = [
      "cache",
      "install",
      "build",
      "unknown",
      "custom",
      "developer",
      "apps",
      "photos",
      "videos",
      "music",
      "documents",
      "downloads",
      "system",
      "caches",
      "trash",
      "other",
    ];
    for (const id of ids) {
      for (const mode of ["plain", "nerd", "letter"] as const) {
        const gColor = categoryGlyph(id, mode, false);
        const gNoColor = categoryGlyph(id, mode, true);
        expect(gColor.length).toBeGreaterThan(0);
        expect(cellWidth(gColor), `${id}:${mode}`).toBeLessThanOrEqual(1);
        expect(cellWidth(gNoColor), `${id}:nocolor`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("ProjectsView subtotal partial qualifiers", () => {
  const mib = 1024 * 1024;
  const now = Date.parse("2026-11-28T12:00:00Z");

  function makeCandidates(reclaimableKnown: boolean, guardedKnown: boolean): ScanCandidate[] {
    return [
      {
        id: "safe_1",
        path: "/tmp/projects/app/node_modules",
        name: "node_modules",
        kind: "node_modules",
        entryType: "directory",
        isSymlink: false,
        estimatedBytes: 100 * mib,
        bytesKnown: reclaimableKnown,
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: true,
        projectRoot: "/tmp/projects/app",
        projectActiveMs: now - 40 * 86_400_000,
      } as ScanCandidate,
      {
        id: "caution_1",
        path: "/tmp/projects/app/.next",
        name: ".next",
        kind: ".next",
        entryType: "directory",
        isSymlink: false,
        estimatedBytes: 30 * mib,
        bytesKnown: true,
        riskTier: "caution",
        reasons: ["default-pattern"],
        selectedByDefault: false,
        projectRoot: "/tmp/projects/app",
        projectActiveMs: now - 40 * 86_400_000,
      } as ScanCandidate,
      {
        id: "blocked_1",
        path: "/tmp/projects/app/target",
        name: "target",
        kind: "target",
        entryType: "directory",
        isSymlink: false,
        estimatedBytes: 150 * mib,
        bytesKnown: guardedKnown,
        riskTier: "blocked",
        reasons: ["tracked"],
        selectedByDefault: false,
        projectRoot: "/tmp/projects/app",
        projectActiveMs: now - 40 * 86_400_000,
      } as ScanCandidate,
    ];
  }

  async function renderCard(candidates: ScanCandidate[]) {
    const projects = buildProjects(candidates, new Set(), "/tmp/projects", now);
    const rows = buildProjectRows(projects, new Set());
    const setup = await testRender(
      <ProjectsView
        tokens={darkTheme}
        width={120}
        height={24}
        target="/tmp/projects"
        rows={rows}
        cursor={1}
        now={now}
        scanning={false}
        sizedLabel=""
        reclaimableBytes={projects.reduce((sum, p) => sum + p.queueableBytes, 0)}
        guardedBytes={projects.reduce((sum, p) => sum + p.guardedBytes, 0)}
        reclaimablePartial={projects.some((p) => p.reclaimablePartial)}
        guardedPartial={projects.some((p) => p.guardedPartial)}
        idleBytes={100 * mib}
        projectCount={projects.length}
        selectedBytes={0}
        selectedCount={0}
        selectedIds={new Set()}
        diskFree={null}
        filter=""
        searchFocused={false}
        footer={<text content="" />}
        onFilterInput={() => {}}
        onFilterSubmit={() => {}}
        onRowPress={() => {}}
        onCursorDelta={() => {}}
      />,
      { width: 120, height: 24 },
    );
    teardown = setup.renderer.destroy.bind(setup.renderer);
    await act(async () => {
      await setup.renderOnce();
    });
    return { frame: setup.captureCharFrame(), projects };
  }

  test("exact reclaimable + partial guarded tildes only guarded", async () => {
    const { frame, projects } = await renderCard(makeCandidates(true, false));
    expect(projects[0]!.reclaimablePartial).toBe(false);
    expect(projects[0]!.guardedPartial).toBe(true);
    expect(frame).toContain("130.0 MiB you can reclaim");
    expect(frame).not.toContain("~130.0 MiB");
    expect(frame).toContain("+~150.0 MiB guarded");
  });

  test("partial reclaimable + exact guarded tildes only reclaimable", async () => {
    const { frame, projects } = await renderCard(makeCandidates(false, true));
    expect(projects[0]!.reclaimablePartial).toBe(true);
    expect(projects[0]!.guardedPartial).toBe(false);
    expect(frame).toContain("~130.0 MiB you can reclaim");
    expect(frame).toContain("+150.0 MiB guarded");
    expect(frame).not.toContain("+~150.0 MiB guarded");
  });
});
