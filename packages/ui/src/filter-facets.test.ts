import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import {
  activeFacetCount,
  clearFacets,
  facetOptions,
  facetTallies,
  readFacets,
  toggleFacet,
  type FacetOption,
} from "./filter-facets.js";
import { compileFilter } from "./filter-query.js";

const kind = (value: string): FacetOption => ({ group: "kind", value, label: value });
const risk = (value: string): FacetOption => ({ group: "risk", value, label: value });
const size = (value: string): FacetOption => ({ group: "size", value, label: value });

function candidate(id: string, kindName: string, bytes: number, tier = "safe"): ScanCandidate {
  return {
    id,
    path: `/repo/${id}/${kindName}`,
    name: kindName,
    kind: kindName,
    estimatedBytes: bytes,
    entryType: "directory",
    isSymlink: false,
    riskTier: tier,
    reasons: [],
    selectedByDefault: false,
  } as ScanCandidate;
}

describe("filter facets", () => {
  test("kinds and risks combine with OR inside a group", () => {
    let filter = toggleFacet("", kind("target"));
    filter = toggleFacet(filter, kind("node_modules"));
    expect(filter).toBe("kind:target,node_modules");
    const predicate = compileFilter(filter)!;
    const context = { selectedIds: new Set<string>(), now: Date.now() };
    expect(predicate(candidate("a", "target", 1), context)).toBe(true);
    expect(predicate(candidate("b", "node_modules", 1), context)).toBe(true);
    expect(predicate(candidate("c", "dist", 1), context)).toBe(false);
    expect(toggleFacet(filter, kind("target"))).toBe("kind:node_modules");
  });

  test("size picks one threshold and a second click clears it", () => {
    const filter = toggleFacet(toggleFacet("", size(">1GiB")), size(">100MiB"));
    expect(filter).toBe(">100mib");
    expect(toggleFacet(filter, size(">100MiB"))).toBe("");
  });

  test("typed text survives toggling and clearing facets", () => {
    let filter = toggleFacet("web !cache path:apps", risk("caution"));
    expect(filter).toBe("web !cache path:apps risk:caution");
    expect(readFacets(filter).rest).toEqual(["web", "!cache", "path:apps"]);
    expect(activeFacetCount(filter)).toBe(1);
    filter = clearFacets(filter);
    expect(filter).toBe("web !cache path:apps");
  });

  test("options list found kinds by size and tallies each one alone", () => {
    const candidates = [
      candidate("a", "target", 500),
      candidate("b", "node_modules", 900),
      candidate("c", "node_modules", 100, "caution"),
    ];
    const options = facetOptions(candidates);
    const kinds = options.filter((o) => o.group === "kind").map((o) => o.value);
    expect(kinds).toEqual(["node_modules", "target"]);
    // Only tiers that exist are offered.
    expect(options.filter((o) => o.group === "risk").map((o) => o.value)).toEqual([
      "safe",
      "caution",
    ]);
    const tallies = facetTallies(candidates, options, new Set());
    const nodeIndex = options.findIndex((o) => o.value === "node_modules");
    expect(tallies[nodeIndex]).toEqual({ count: 2, bytes: 1000 });
  });
});
