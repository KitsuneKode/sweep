import type { CandidateKind } from "./index.js";

/** Canonical default artifact pattern names (aligned with DEFAULT_PATTERNS). */
export const KNOWN_ARTIFACT_NAMES = [
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vite",
  ".parcel-cache",
  "target",
  "coverage",
  ".nyc_output",
] as const;

/** Infer artifact kind from a matched entry name. */
export function candidateKindFromName(name: string): CandidateKind {
  if ((KNOWN_ARTIFACT_NAMES as readonly string[]).includes(name)) {
    return name as CandidateKind;
  }
  return name.endsWith(".tsbuildinfo") ? "tsbuildinfo" : "custom";
}
