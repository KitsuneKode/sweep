/**
 * Cross-module handle for the in-flight destructive operation. bin.ts's
 * global EPIPE handler consults it: a dead stdout mid-apply must abort the
 * operation rather than `exit(0)` as if nothing was running.
 */
let activeApply: AbortController | undefined;

export function setActiveApply(controller: AbortController | undefined): void {
  activeApply = controller;
}

export function isApplyActive(): boolean {
  return activeApply !== undefined;
}

export function abortActiveApply(): void {
  activeApply?.abort();
}
