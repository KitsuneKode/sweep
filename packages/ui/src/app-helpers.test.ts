import { describe, expect, test } from "bun:test";
import { calmHintItems } from "./app-helpers.js";

describe("calmHintItems", () => {
  test("keeps b full view visible at 100 and 120 columns (idle and queued)", () => {
    for (const width of [100, 120]) {
      for (const queued of [false, true]) {
        const hints = calmHintItems({
          scanning: false,
          idleBytes: 5.6 * 1024 ** 3,
          queued,
          width,
        });
        const keys = hints.map((h) => h.key);
        expect(keys, `width=${width} queued=${queued}`).toContain("b");
        if (width >= 120 || !queued) {
          expect(keys, `width=${width} queued=${queued}`).toContain("/");
        }
        expect(keys.at(-1), `width=${width} queued=${queued}`).toBe("?");
        expect(hints.find((h) => h.key === "b")?.label).toBe("full view");
      }
    }
  });

  test("fits all hints within the ProjectsView usable line width", () => {
    for (const width of [80, 100, 120]) {
      const hints = calmHintItems({
        scanning: false,
        idleBytes: 5.6 * 1024 ** 3,
        queued: false,
        width,
      });
      const renderedWidth =
        hints.reduce((sum, h) => sum + h.key.length + 3 + h.label.length, 0) +
        Math.max(0, hints.length - 1) * 2;
      const usable = Math.min(116, Math.max(20, width - 6));
      expect(renderedWidth, `width=${width}`).toBeLessThanOrEqual(usable);
    }
  });
});
