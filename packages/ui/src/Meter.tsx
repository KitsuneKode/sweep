import { CliRenderEvents, fg, t } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  cachedImage,
  clamp01,
  dotMatrixLine,
  dotMatrixPixels,
  EASE_MS,
  easeOut,
  glideLine,
  glidePixels,
  magnitudeBar,
  meterLine,
  meterPixels,
  stackLine,
  stackPixels,
  type StackSegment,
} from "./meter-draw.js";
import { useMotionEnabled } from "./motion.js";

/**
 * Capped frame interval for animated meters (<= 15 fps per `.plans/kitty-graphics.md`).
 * Stops immediately once settled (0 fps at rest).
 */
const ANIMATION_FRAME_MS = 66;

export interface MeterProps {
  width: number;
  /** 0..1: the solid fill. */
  value: number;
  /** 0..1: a softer fill behind the solid one, for what one key would add. */
  preview?: number;
  fill: string;
  /** Unfilled part; null draws no track (a bare bar). */
  track: string | null;
  /** Ease value changes; off for rows that only ever show a fixed size. */
  animate?: boolean;
  /** "line": a hairline meter. "blocks": a size bar in eighths of a cell (text only). */
  variant?: "line" | "blocks";
  /** Stroke thickness as a share of the cell height, in pixels. */
  thickness?: number;
  /** The colour painted behind the meter; "transparent" or absent leaves the terminal's. */
  background?: string | undefined;
}

/** Follows `target`, easing toward each new value from wherever it is now. */
export function useEased(target: number, enabled: boolean): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    if (!enabled || Math.abs(target - shownRef.current) < 0.0005) {
      if (shownRef.current !== target) {
        shownRef.current = target;
        setShown(target);
      }
      return;
    }
    const from = shownRef.current;
    const started = performance.now();
    const timer = setInterval(() => {
      const progress = Math.min(1, (performance.now() - started) / EASE_MS);
      shownRef.current = from + (target - from) * easeOut(progress);
      setShown(shownRef.current);
      if (progress >= 1) clearInterval(timer);
    }, ANIMATION_FRAME_MS);
    return () => clearInterval(timer);
  }, [target, enabled]);
  return shown;
}

/**
 * Counts from zero up to `target` once, on mount: for a rare result (bytes
 * just freed) the number arriving is the moment. Off with reduced motion.
 */
export function useCountUp(target: number, enabled: boolean, ms = 420): number {
  const [shown, setShown] = useState(enabled ? 0 : target);
  useEffect(() => {
    if (!enabled) {
      setShown(target);
      return;
    }
    const started = performance.now();
    const timer = setInterval(() => {
      const progress = Math.min(1, (performance.now() - started) / ms);
      setShown(target * easeOut(progress));
      if (progress >= 1) clearInterval(timer);
    }, ANIMATION_FRAME_MS);
    return () => clearInterval(timer);
  }, [target, enabled, ms]);
  return shown;
}

/**
 * Evaluate whether direct Kitty pixel rendering is safe in this environment
 * (`.plans/kitty-graphics.md` §3):
 * - Terminal reports `kitty_graphics: true` and valid pixel `resolution`
 * - Not inside a multiplexer (tmux / Zellij / GNU Screen) until U=1 placeholders land
 * - Not disabled via `NO_COLOR`, `SWEEP_GRAPHICS=off`, or `OPENTUI_GRAPHICS=false`
 */
export function canUseKittyGraphics(
  capabilities: { kitty_graphics?: boolean; multiplexer?: string } | null | undefined,
  resolution: { width: number; height: number } | null | undefined,
  width: number,
  height: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR) return false;
  if (env.SWEEP_GRAPHICS?.toLowerCase() === "off") return false;
  if (env.OPENTUI_GRAPHICS?.toLowerCase() === "false") return false;
  if (env.TMUX || env.ZELLIJ || env.STY) return false;
  if (capabilities?.kitty_graphics !== true) return false;
  if (capabilities.multiplexer && capabilities.multiplexer !== "none") return false;
  return resolution !== null && resolution !== undefined && width > 0 && height > 0;
}

const capabilityListeners = new WeakMap<
  object,
  { listeners: Set<() => void>; onEvent: () => void }
>();

function subscribeCapabilities(
  renderer: ReturnType<typeof useRenderer>,
  listener: () => void,
): () => void {
  let entry = capabilityListeners.get(renderer);
  if (!entry) {
    const listeners = new Set<() => void>();
    const onEvent = () => {
      for (const notify of listeners) notify();
    };
    entry = { listeners, onEvent };
    capabilityListeners.set(renderer, entry);
    renderer.on(CliRenderEvents.CAPABILITIES, onEvent);
  }
  entry.listeners.add(listener);
  return () => {
    const current = capabilityListeners.get(renderer);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      renderer.off(CliRenderEvents.CAPABILITIES, current.onEvent);
      capabilityListeners.delete(renderer);
    }
  };
}

/**
 * Whether meters draw in pixels here: shares one `CliRenderEvents.CAPABILITIES`
 * listener per renderer so late-arriving terminal probes upgrade cleanly
 * without hitting EventEmitter listener limits.
 */
export function useKittyGraphics(): boolean {
  const renderer = useRenderer();
  const [, setCapabilityRevision] = useState(0);

  useEffect(
    () => subscribeCapabilities(renderer, () => setCapabilityRevision((n) => n + 1)),
    [renderer],
  );

  return canUseKittyGraphics(
    renderer.capabilities,
    renderer.resolution,
    renderer.width,
    renderer.height,
  );
}

export function Meter(props: MeterProps & { previewColor: string }) {
  const renderer = useRenderer();
  const motion = useMotionEnabled();
  const animate = motion && props.animate !== false;
  const value = useEased(clamp01(props.value), animate);
  const preview = useEased(clamp01(props.preview ?? 0), animate);

  // Per `.plans/kitty-graphics.md` §4 & §5: scrollable row magnitude bars
  // ("blocks") always render as Unicode eighths, never per-row Kitty images.
  const isBlocks = props.variant === "blocks";
  const kitty = useKittyGraphics() && !isBlocks;
  const resolution = renderer.resolution;
  const cellWidth = kitty && resolution ? resolution.width / renderer.width : 0;
  const cellHeight = kitty && resolution ? resolution.height / renderer.height : 0;
  const pixelWidth = Math.round(props.width * cellWidth);
  const pixelHeight = Math.round(cellHeight);
  // Whole pixels are the finest step there is: identical frames reuse one image.
  const step = pixelWidth > 0 ? 1 / pixelWidth : 1;
  const valueStep = Math.round(value / step);
  const previewStep = Math.round(preview / step);

  const thickness = props.thickness ?? 0.28;
  const background = props.background ?? null;
  const image = useMemo(() => {
    if (!kitty || pixelWidth < 8 || pixelHeight < 4) return null;
    return cachedImage(
      `${pixelWidth}x${pixelHeight}:${valueStep}:${previewStep}:${props.fill}:${props.track}:${thickness}:${background}`,
      () =>
        meterPixels(
          pixelWidth,
          pixelHeight,
          valueStep * step,
          previewStep * step,
          props.fill,
          props.track,
          thickness,
          background,
        ),
      pixelWidth,
      pixelHeight,
    );
  }, [
    kitty,
    pixelWidth,
    pixelHeight,
    valueStep,
    previewStep,
    step,
    props.fill,
    props.track,
    thickness,
    background,
  ]);

  if (image) {
    return <image source={image} width={props.width} height={1} fit="fill" protocol="auto" />;
  }
  if (isBlocks) {
    return (
      <text content={t`${fg(props.fill)(magnitudeBar(value, props.width))}`} wrapMode="none" />
    );
  }
  return (
    <text
      content={meterLine(
        props.width,
        value,
        preview,
        props.fill,
        props.previewColor,
        props.track ?? props.fill,
      )}
      wrapMode="none"
    />
  );
}

/**
 * One bar split by share: where a total goes, part by part. Renders the
 * Direction C+ dithered dot-matrix bar in Kitty graphics terminals (with
 * opaque card-ground baking) and falls back cleanly to a Braille dot-matrix
 * strip (`⣿`/`⣷`/`⣀`/`⠂`) everywhere else. Static at rest (0 fps).
 */
export function StackBar({
  width,
  segments,
  background,
  trackColor,
  dimColor,
  fillFraction = 1,
  isNoColor = Boolean(process.env.NO_COLOR),
  variant = "dots",
  thickness = 0.5,
}: {
  width: number;
  segments: StackSegment[];
  background?: string | undefined;
  trackColor?: string | undefined;
  dimColor?: string | undefined;
  fillFraction?: number | undefined;
  isNoColor?: boolean | undefined;
  variant?: "dots" | "capsule";
  thickness?: number;
}) {
  const renderer = useRenderer();
  const kitty = useKittyGraphics();
  const resolution = renderer.resolution;
  const pixelWidth =
    kitty && resolution ? Math.round((width * resolution.width) / renderer.width) : 0;
  const pixelHeight = kitty && resolution ? Math.round(resolution.height / renderer.height) : 0;
  const ground = background ?? null;
  const key = segments
    .map((segment) => `${segment.fraction.toFixed(4)}${segment.color}${segment.dim ? "~" : ""}`)
    .join(",");
  const image = useMemo(() => {
    if (!kitty || pixelWidth < 8 || pixelHeight < 4) return null;
    if (variant === "dots") {
      return cachedImage(
        `dots:${pixelWidth}x${pixelHeight}:${fillFraction.toFixed(3)}:${isNoColor}:${trackColor ?? ""}:${ground}:${key}`,
        () =>
          dotMatrixPixels(pixelWidth, pixelHeight, segments, {
            background: ground,
            trackColor,
            fillFraction,
            isNoColor,
          }),
        pixelWidth,
        pixelHeight,
      );
    }
    return cachedImage(
      `stack:${pixelWidth}x${pixelHeight}:${thickness}:${ground}:${key}`,
      () => stackPixels(pixelWidth, pixelHeight, segments, thickness, ground),
      pixelWidth,
      pixelHeight,
    );
    // `key` is the content of `segments`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    kitty,
    pixelWidth,
    pixelHeight,
    variant,
    thickness,
    fillFraction,
    isNoColor,
    trackColor,
    ground,
    key,
  ]);
  if (image) return <image source={image} width={width} height={1} fit="fill" protocol="auto" />;
  if (variant === "dots") {
    return (
      <text
        content={dotMatrixLine(width, segments, {
          trackColor,
          dimColor,
          fillFraction,
          isNoColor,
        })}
        wrapMode="none"
      />
    );
  }
  return <text content={stackLine(width, segments)} wrapMode="none" />;
}

const GLIDE_MS = 1400;
/** 20 steps across 1400 ms = 70 ms/frame (~14.3 fps, within <= 15 fps Kitty budget). */
const GLIDE_STEPS = 20;
const GLIDE_RUN = 0.24;

/**
 * Work whose end is not known yet: a short run glides along the track at a
 * bounded rate (<= 15 fps). Under reduced motion the run holds still at start.
 */
export function ScanMeter({
  width,
  fill,
  track,
  background,
}: {
  width: number;
  fill: string;
  track: string;
  background?: string | undefined;
}) {
  const renderer = useRenderer();
  const kitty = useKittyGraphics();
  const motion = useMotionEnabled();
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!motion) {
      setStep(0);
      return;
    }
    const started = performance.now();
    const timer = setInterval(() => {
      const phase = ((performance.now() - started) % GLIDE_MS) / GLIDE_MS;
      setStep(Math.floor(phase * GLIDE_STEPS));
    }, GLIDE_MS / GLIDE_STEPS);
    return () => clearInterval(timer);
  }, [motion]);
  // Enters from the left edge, leaves past the right one.
  const head = (step / GLIDE_STEPS) * (1 + GLIDE_RUN);
  const from = motion ? head - GLIDE_RUN : 0;
  const to = motion ? head : GLIDE_RUN;
  const resolution = renderer.resolution;
  const pixelWidth =
    kitty && resolution ? Math.round((width * resolution.width) / renderer.width) : 0;
  const pixelHeight = kitty && resolution ? Math.round(resolution.height / renderer.height) : 0;
  const ground = background ?? null;
  const image = useMemo(() => {
    if (!kitty || pixelWidth < 8 || pixelHeight < 4) return null;
    return cachedImage(
      `glide:${pixelWidth}x${pixelHeight}:${step}:${motion}:${fill}:${track}:${ground}`,
      () => glidePixels(pixelWidth, pixelHeight, from, to, fill, track, 0.28, ground),
      pixelWidth,
      pixelHeight,
    );
    // `from`/`to` follow from `step` and `motion`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kitty, pixelWidth, pixelHeight, step, motion, fill, track, ground]);
  if (image) return <image source={image} width={width} height={1} fit="fill" protocol="auto" />;
  return <text content={glideLine(width, from, to, fill, track)} wrapMode="none" />;
}
