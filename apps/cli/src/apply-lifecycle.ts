/**
 * Cross-module handle for the in-flight destructive operation. bin.ts's
 * global EPIPE handler consults it: a dead stdout mid-apply must abort the
 * operation rather than `exit(0)` as if nothing was running.
 */
let activeApply: AbortController | undefined;
let applyEntered = false;
let unresolvedOutcome = false;

/** Claim receipt delivery before a destructive command emits any stdout. */
export function expectApplyOutput(): void {
  applyEntered = true;
}

export function setActiveApply(controller: AbortController | undefined): void {
  activeApply = controller;
  if (controller) {
    applyEntered = true;
    unresolvedOutcome = false;
  }
}

/** Stays true through final report delivery; a lost apply receipt is not success. */
export function hasApplyEntered(): boolean {
  return applyEntered;
}

export function isApplyActive(): boolean {
  return activeApply !== undefined;
}

export function abortActiveApply(): void {
  activeApply?.abort();
}

/** Once a backend may mutate, a crash cannot prove no deletion began. */
export function noteApplyBackendEntered(): void {
  unresolvedOutcome = true;
}
export function hasApplyOutcomeUnresolved(): boolean {
  return unresolvedOutcome;
}
export function noteApplyReportTrusted(): void {
  unresolvedOutcome = false;
}
