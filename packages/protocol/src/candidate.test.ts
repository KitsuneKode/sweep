import { describe, expect, test } from "bun:test";
import { candidateKindFromName, KNOWN_ARTIFACT_NAMES } from "./candidate.js";

describe("candidateKindFromName", () => {
  test("maps known artifact names", () => {
    for (const name of KNOWN_ARTIFACT_NAMES) {
      expect(candidateKindFromName(name)).toBe(name);
    }
  });

  test("maps tsbuildinfo files", () => {
    expect(candidateKindFromName("tsconfig.tsbuildinfo")).toBe("tsbuildinfo");
  });

  test("maps unknown names to custom", () => {
    expect(candidateKindFromName("my-cache")).toBe("custom");
  });
});
