import { createContext, useContext } from "react";

/** Terminals have no browser media query; expose an explicit preference. */
export function motionEnabledFromEnvironment(): boolean {
  const preference = process.env.SWEEP_REDUCED_MOTION?.toLowerCase();
  return preference !== "1" && preference !== "true";
}

export const MotionContext = createContext(true);

export function useMotionEnabled(): boolean {
  return useContext(MotionContext);
}
