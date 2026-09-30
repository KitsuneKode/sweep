/**
 * @opentui/react's testRender toggles IS_REACT_ACT_ENVIRONMENT around each
 * renderer's lifetime - including from onDestroy, which can fire on a microtask
 * from a previous test file while a later file is mid-mount. When the flag is
 * false, React's act() does not flush the scheduled render and captureCharFrame
 * returns a blank frame. Pin it for the whole test run so a racing destroy
 * cannot unset it; writes are swallowed rather than throwing in module scope.
 */
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  get: () => true,
  set: () => {},
});
