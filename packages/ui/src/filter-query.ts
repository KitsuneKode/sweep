import type { ScanCandidate } from "@kitsunekode/sweep-protocol";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface FilterContext {
  selectedIds: ReadonlySet<string>;
  now: number;
}

type Predicate = (candidate: ScanCandidate, context: FilterContext) => boolean;

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
};

const DURATION_UNITS: Record<string, number> = {
  m: MINUTE_MS,
  h: HOUR_MS,
  d: DAY_MS,
  w: 7 * DAY_MS,
  mo: 30 * DAY_MS,
  y: 365 * DAY_MS,
};

const SIZE_TERM = /^(>=|<=|>|<)(\d+(?:\.\d+)?)([a-z]+)$/i;
const DURATION_TERM = /^(\d+(?:\.\d+)?)(m|h|d|w|mo|y)$/i;

/** Every accepted `key:value` prefix, for hints and tests. */
export const FILTER_KEYS = ["kind", "risk", "path", "is", "older", "newer"] as const;
export const FILTER_HINT = "kind:target risk:caution >100MB older:30d is:queued";

function sizePredicate(term: string): Predicate | null {
  const match = SIZE_TERM.exec(term);
  if (!match) return null;
  const unit = SIZE_UNITS[(match[3] ?? "").toLowerCase()];
  if (unit === undefined) return null;
  const limit = Number(match[2]) * unit;
  const operator = match[1];
  return (candidate) => {
    switch (operator) {
      case ">":
        return candidate.estimatedBytes > limit;
      case ">=":
        return candidate.estimatedBytes >= limit;
      case "<":
        return candidate.estimatedBytes < limit;
      default:
        return candidate.estimatedBytes <= limit;
    }
  };
}

function agePredicate(key: "older" | "newer", value: string): Predicate | null {
  const match = DURATION_TERM.exec(value);
  if (!match) return null;
  const span = Number(match[1]) * (DURATION_UNITS[(match[2] ?? "").toLowerCase()] ?? 0);
  // An unknown mtime cannot be older or newer than anything, so it never matches.
  return (candidate, { now }) => {
    if (candidate.modifiedMs === undefined) return false;
    const age = now - candidate.modifiedMs;
    return key === "older" ? age >= span : age < span;
  };
}

function isPredicate(value: string): Predicate | null {
  switch (value) {
    case "queued":
      return (candidate, { selectedIds }) => selectedIds.has(candidate.id);
    case "unqueued":
      return (candidate, { selectedIds }) => !selectedIds.has(candidate.id);
    case "symlink":
      return (candidate) => candidate.isSymlink;
    case "stub":
      return (candidate) => candidate.reasons.includes("workspace-stub");
    default:
      return null;
  }
}

function keyedPredicate(key: string, value: string): Predicate | null {
  if (value.length === 0) return null;
  switch (key) {
    case "kind":
      return (candidate) => candidate.kind.toLowerCase().includes(value);
    case "risk":
      return (candidate) => candidate.riskTier === value;
    case "path":
      return (candidate) => candidate.path.toLowerCase().includes(value);
    case "is":
      return isPredicate(value);
    case "older":
    case "newer":
      return agePredicate(key, value);
    default:
      return null;
  }
}

function plainPredicate(term: string): Predicate {
  return (candidate) =>
    `${candidate.name} ${candidate.path} ${candidate.kind} ${candidate.riskTier}`
      .toLowerCase()
      .includes(term);
}

function termPredicate(rawTerm: string): Predicate {
  const negated = rawTerm.startsWith("!") && rawTerm.length > 1;
  const term = negated ? rawTerm.slice(1) : rawTerm;

  let predicate = sizePredicate(term);
  if (!predicate) {
    const colon = term.indexOf(":");
    if (colon > 0) predicate = keyedPredicate(term.slice(0, colon), term.slice(colon + 1));
  }
  // Half-typed operators (`>1`, `kind:`) fall back to plain text instead of
  // hiding everything mid-keystroke.
  const base = predicate ?? plainPredicate(term);
  return negated ? (candidate, context) => !base(candidate, context) : base;
}

/**
 * Compile a filter box string. Whitespace separates terms and every term must
 * match. Bare words are substring matches over name, path, kind and risk;
 * `key:value` and size comparisons (`>100MB`) narrow further; a leading `!`
 * negates a term.
 */
export function compileFilter(input: string): Predicate | null {
  const terms = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  const predicates = terms.map(termPredicate);
  return (candidate, context) => predicates.every((predicate) => predicate(candidate, context));
}
