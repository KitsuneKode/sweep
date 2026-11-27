import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ProjectsView } from "./ProjectsView.js";
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
});
