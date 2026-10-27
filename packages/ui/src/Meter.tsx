import { fg, t } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  cachedImage,
  clamp01,
  EASE_MS,
  easeOut,
  magnitudeBar,
  meterLine,
  meterPixels,
  glideLine,
  glidePixels,
  stackLine,
  stackPixels,
  type StackSegment,
} from "./meter-draw.js";
import { useMotionEnabled } from "./motion.js";

/**
 * One thin meter under the answer line. In a terminal that speaks the kitty
 * graphics protocol it is drawn in pixels - a rounded track with an
 * anti-aliased fill on a transparent background - so it reads as a hairline
 * rather than a row of glyphs. Everywhere else it is the same line in box
 * drawing characters. A change in value eases over 180ms (state indication);
 * with reduced motion it jumps.
 */

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
  /** "line": a hairline meter. "blocks": a size bar in eighths of a cell. */
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
    }, 16);
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
    }, 16);
    return () => clearInterval(timer);
  }, [target, enabled, ms]);
  return shown;
}

/**
 * Whether meters draw in pixels here: the terminal speaks kitty graphics and
 * has reported its pixel size. Callers that lay a meter over text use it to
 * leave a gap only when an image will fill it.
 */
export function useKittyGraphics(): boolean {
  const renderer = useRenderer();
  return (
    renderer.capabilities?.kitty_graphics === true &&
    renderer.resolution !== null &&
    renderer.width > 0 &&
    renderer.height > 0
  );
}

export function Meter(props: MeterProps & { previewColor: string }) {
  const renderer = useRenderer();
  const motion = useMotionEnabled();
  const animate = motion && props.animate !== false;
  const value = useEased(clamp01(props.value), animate);
  const preview = useEased(clamp01(props.preview ?? 0), animate);

  const resolution = renderer.resolution;
  const kitty =
    renderer.capabilities?.kitty_graphics === true &&
    resolution !== null &&
    renderer.width > 0 &&
    renderer.height > 0;
  const cellWidth = kitty ? resolution.width / renderer.width : 0;
  const cellHeight = kitty ? resolution.height / renderer.height : 0;
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
    return <image source={image} width={props.width} height={1} fit="fill" protocol="kitty" />;
  }
  if (props.variant === "blocks") {
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
 * One bar split by share: where a total goes, part by part. Pixels in kitty,
 * a coloured line elsewhere. Static: it describes a size, not a change.
 */
export function StackBar({
  width,
  segments,
  background,
  thickness = 0.5,
}: {
  width: number;
  segments: StackSegment[];
  background?: string | undefined;
  thickness?: number;
}) {
  const renderer = useRenderer();
  const kitty = useKittyGraphics();
  const resolution = renderer.resolution;
  const pixelWidth =
    kitty && resolution ? Math.round((width * resolution.width) / renderer.width) : 0;
  const pixelHeight = kitty && resolution ? Math.round(resolution.height / renderer.height) : 0;
  const ground = background ?? null;
  const key = segments.map((segment) => `${segment.fraction.toFixed(4)}${segment.color}`).join(",");
  const image = useMemo(() => {
    if (!kitty || pixelWidth < 8 || pixelHeight < 4) return null;
    return cachedImage(
      `stack:${pixelWidth}x${pixelHeight}:${thickness}:${ground}:${key}`,
      () => stackPixels(pixelWidth, pixelHeight, segments, thickness, ground),
      pixelWidth,
      pixelHeight,
    );
    // `key` is the content of `segments`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kitty, pixelWidth, pixelHeight, thickness, ground, key]);
  if (image) return <image source={image} width={width} height={1} fit="fill" protocol="kitty" />;
  return <text content={stackLine(width, segments)} wrapMode="none" />;
}

const GLIDE_MS = 1400;
const GLIDE_STEPS = 56;
const GLIDE_RUN = 0.24;

/**
 * Work whose end is not known yet: a short run glides along the track at a
 * constant speed. It claims no fraction, so the count beside it is the only
 * number on screen. Under reduced motion the run holds still at the start.
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
  if (image) return <image source={image} width={width} height={1} fit="fill" protocol="kitty" />;
  return <text content={glideLine(width, from, to, fill, track)} wrapMode="none" />;
}
