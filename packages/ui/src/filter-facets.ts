import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { compileFilter } from "./filter-query.js";

/**
 * The filter picker: facets a cleaner reaches for (risk, kind, size, age,
 * status) chosen from a list instead of typed. It reads and writes the same
 * filter string as the `/` box, so typing and picking never disagree - a
 * facet is just a term the picker knows how to toggle.
 */
export type FacetGroup = "risk" | "kind" | "size" | "age" | "status";

export interface FacetOption {
  group: FacetGroup;
  /** The term value: `caution`, `node_modules`, `>1GiB`, `older:30d`, `is:queued`. */
  value: string;
  label: string;
}

export const FACET_GROUP_LABEL: Record<FacetGroup, string> = {
  risk: "Risk",
  kind: "Kind",
  size: "Size",
  age: "Last touched",
  status: "Queue",
};

/** Groups where several choices combine with OR; the rest pick one. */
const MULTI: ReadonlySet<FacetGroup> = new Set(["risk", "kind"]);

const SIZE_OPTIONS: FacetOption[] = [
  { group: "size", value: ">1GiB", label: "over 1 GiB" },
  { group: "size", value: ">100MiB", label: "over 100 MiB" },
  { group: "size", value: ">10MiB", label: "over 10 MiB" },
];
const AGE_OPTIONS: FacetOption[] = [
  { group: "age", value: "older:90d", label: "90+ days ago" },
  { group: "age", value: "older:30d", label: "30+ days ago" },
  { group: "age", value: "older:7d", label: "7+ days ago" },
  { group: "age", value: "newer:7d", label: "this week" },
];
const STATUS_OPTIONS: FacetOption[] = [
  { group: "status", value: "is:unqueued", label: "not queued" },
  { group: "status", value: "is:queued", label: "queued" },
];
const RISK_OPTIONS: FacetOption[] = [
  { group: "risk", value: "safe", label: "safe" },
  { group: "risk", value: "caution", label: "caution" },
  { group: "risk", value: "dangerous", label: "dangerous" },
];

const SIZE_TERM = /^[<>]=?\d/;
/** Kinds listed in the picker, largest first; the `/` box reaches the rest. */
const MAX_KINDS = 8;

export interface FacetState {
  risk: string[];
  kind: string[];
  size: string | null;
  age: string | null;
  status: string | null;
  /** Everything the picker does not own (free text, path:, !negations) - kept verbatim. */
  rest: string[];
}

export function readFacets(filter: string): FacetState {
  const state: FacetState = { risk: [], kind: [], size: null, age: null, status: null, rest: [] };
  for (const term of filter.trim().split(/\s+/).filter(Boolean)) {
    const lower = term.toLowerCase();
    if (lower.startsWith("risk:") && lower.length > 5) {
      state.risk.push(...lower.slice(5).split(",").filter(Boolean));
    } else if (lower.startsWith("kind:") && lower.length > 5) {
      state.kind.push(...lower.slice(5).split(",").filter(Boolean));
    } else if (SIZE_TERM.test(lower) && state.size === null) {
      state.size = lower;
    } else if (/^(older|newer):\d/.test(lower) && state.age === null) {
      state.age = lower;
    } else if ((lower === "is:queued" || lower === "is:unqueued") && state.status === null) {
      state.status = lower;
    } else {
      state.rest.push(term);
    }
  }
  return state;
}

export function writeFacets(state: FacetState): string {
  const terms = [...state.rest];
  if (state.kind.length > 0) terms.push(`kind:${unique(state.kind).join(",")}`);
  if (state.risk.length > 0) terms.push(`risk:${unique(state.risk).join(",")}`);
  if (state.size) terms.push(state.size);
  if (state.age) terms.push(state.age);
  if (state.status) terms.push(state.status);
  return terms.join(" ");
}

export function isFacetActive(state: FacetState, option: FacetOption): boolean {
  const value = option.value.toLowerCase();
  switch (option.group) {
    case "risk":
      return state.risk.includes(value);
    case "kind":
      return state.kind.includes(value);
    case "size":
      return state.size === value;
    case "age":
      return state.age === value;
    case "status":
      return state.status === value;
  }
}

/** Toggle one option: OR groups add or remove it; single-pick groups swap. */
export function toggleFacet(filter: string, option: FacetOption): string {
  const state = readFacets(filter);
  const value = option.value.toLowerCase();
  const active = isFacetActive(state, option);
  if (MULTI.has(option.group)) {
    const list = option.group === "risk" ? state.risk : state.kind;
    const next = active ? list.filter((v) => v !== value) : [...list, value];
    if (option.group === "risk") state.risk = next;
    else state.kind = next;
  } else {
    const next = active ? null : value;
    if (option.group === "size") state.size = next;
    else if (option.group === "age") state.age = next;
    else state.status = next;
  }
  return writeFacets(state);
}

/** Drop every picker facet and keep typed text. */
export function clearFacets(filter: string): string {
  const { rest } = readFacets(filter);
  return rest.join(" ");
}

export function activeFacetCount(filter: string): number {
  const state = readFacets(filter);
  return (
    state.risk.length +
    state.kind.length +
    Number(state.size !== null) +
    Number(state.age !== null) +
    Number(state.status !== null)
  );
}

/** The picker's rows, in order. Kinds come from what the scan found. */
export function facetOptions(candidates: readonly ScanCandidate[]): FacetOption[] {
  const kindBytes = new Map<string, number>();
  for (const candidate of candidates) {
    const kind = candidate.kind.toLowerCase();
    kindBytes.set(kind, (kindBytes.get(kind) ?? 0) + candidate.estimatedBytes);
  }
  const kinds = [...kindBytes.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_KINDS)
    .map(([kind]): FacetOption => ({ group: "kind", value: kind, label: kind }));
  const risks = RISK_OPTIONS.filter((option) =>
    candidates.some((candidate) => candidate.riskTier === option.value),
  );
  return [...risks, ...kinds, ...SIZE_OPTIONS, ...AGE_OPTIONS, ...STATUS_OPTIONS];
}

export interface FacetTally {
  count: number;
  bytes: number;
}

/**
 * What each option alone would match among `candidates`. Counts describe the
 * option, not the combined filter, so they stay put while toggling.
 */
export function facetTallies(
  candidates: readonly ScanCandidate[],
  options: readonly FacetOption[],
  selectedIds: ReadonlySet<string>,
  now = Date.now(),
): FacetTally[] {
  return options.map((option) => {
    const predicate = compileFilter(termFor(option));
    let count = 0;
    let bytes = 0;
    if (predicate) {
      for (const candidate of candidates) {
        if (predicate(candidate, { selectedIds, now })) {
          count++;
          bytes += candidate.estimatedBytes;
        }
      }
    }
    return { count, bytes };
  });
}

function termFor(option: FacetOption): string {
  if (option.group === "risk") return `risk:${option.value}`;
  if (option.group === "kind") return `kind:${option.value}`;
  return option.value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
