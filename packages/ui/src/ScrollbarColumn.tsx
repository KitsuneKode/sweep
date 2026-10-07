import { type BoxRenderable, type MouseEvent, fg, t } from "@opentui/core";
import { memo, useCallback, useMemo, useRef } from "react";
import type { ThemeTokens } from "./theme.js";

interface ScrollbarModel {
  thumbTop: number;
  thumbHeight: number;
}

export function scrollbarModel(
  rowCount: number,
  viewportHeight: number,
  scrollTop: number,
): ScrollbarModel | null {
  if (viewportHeight <= 0 || rowCount <= viewportHeight) return null;
  // Minimum 2 cells - a 1-cell thumb reads as a stray accent, not a position.
  const thumbHeight = Math.min(
    viewportHeight,
    Math.max(2, Math.round((viewportHeight * viewportHeight) / rowCount)),
  );
  const maxTop = Math.max(1, rowCount - viewportHeight);
  const thumbTop = Math.round((scrollTop / maxTop) * (viewportHeight - thumbHeight));
  return { thumbTop, thumbHeight };
}

/**
 * 1-column scrollbar with OpenTUI's SliderRenderable interaction model:
 *
 * - Track *press* seeks directly - the pointer's cell maps linearly onto the
 *   row index and the cursor-coupled window follows.
 * - Thumb *drag* preserves the grab offset: the grabbed cell of the thumb
 *   stays under the pointer instead of teleporting the thumb top to the
 *   pointer on every drag event.
 * - `preventDefault` on press suppresses the renderer's text-selection
 *   gesture, so scrubbing never starts a selection.
 *
 * OpenTUI captures the renderable under the pointer on press, so a drag keeps
 * delivering events to the lane even when the pointer strays off it.
 */
export const ScrollbarColumn = memo(function ScrollbarColumn({
  tokens,
  model,
  height,
  rowCount,
  onSeek,
}: {
  tokens: ThemeTokens;
  model: ScrollbarModel;
  height: number;
  rowCount: number;
  onSeek?: ((rowIndex: number) => void) | undefined;
}) {
  const trackRef = useRef<BoxRenderable | null>(null);
  // Track cells between the pointer and the thumb's top edge while a thumb
  // drag is live; null when no drag is active. Captured on press, released on
  // up/drag-end.
  const grabOffsetRef = useRef<number | null>(null);

  // Two mappings, same as OpenTUI's SliderRenderable:
  // - Track press maps pointer position over the full track: `rel / (h - 1)`.
  // - Thumb drag maps the thumb's *top* over its travel range
  //   `top / (h - thumbHeight)` - the thumb can only reach `h - thumbHeight`,
  //   so mapping it over `h - 1` would make the last rows unreachable.
  const rowAtPointer = useCallback(
    (rel: number): number => {
      const clamped = Math.min(Math.max(rel, 0), Math.max(0, height - 1));
      return height <= 1 ? 0 : Math.round((clamped / (height - 1)) * Math.max(0, rowCount - 1));
    },
    [height, rowCount],
  );
  const rowAtThumbTop = useCallback(
    (top: number): number => {
      const travel = Math.max(0, height - model.thumbHeight);
      const clamped = Math.min(Math.max(top, 0), travel);
      return travel <= 0 ? 0 : Math.round((clamped / travel) * Math.max(0, rowCount - 1));
    },
    [height, model.thumbHeight, rowCount],
  );

  const press = useCallback(
    (event: MouseEvent) => {
      const track = trackRef.current;
      if (!track || rowCount <= 0 || !onSeek) return;
      event.preventDefault();
      const rel = event.y - track.screenY;
      const inThumb = rel >= model.thumbTop && rel < model.thumbTop + model.thumbHeight;
      if (inThumb) {
        // Grab the thumb where it is - no jump; the drag moves from here.
        grabOffsetRef.current = Math.min(Math.max(rel - model.thumbTop, 0), model.thumbHeight - 1);
        return;
      }
      // Track press seeks so the pointer lands mid-thumb; the grab offset that
      // a continued drag preserves is therefore half the thumb.
      grabOffsetRef.current = Math.floor(model.thumbHeight / 2);
      onSeek(rowAtPointer(rel));
    },
    [model.thumbTop, model.thumbHeight, rowCount, rowAtPointer, onSeek],
  );

  const drag = useCallback(
    (event: MouseEvent) => {
      const track = trackRef.current;
      if (!track || rowCount <= 0 || !onSeek) return;
      const rel = event.y - track.screenY;
      const grab = grabOffsetRef.current;
      // No press before this drag (OpenTUI fires drag without a down on some
      // paths) - treat it like a track press.
      if (grab === null) {
        onSeek(rowAtPointer(rel));
        return;
      }
      onSeek(rowAtThumbTop(rel - grab));
    },
    [rowCount, rowAtPointer, rowAtThumbTop, onSeek],
  );

  const release = useCallback(() => {
    grabOffsetRef.current = null;
  }, []);

  const lines = useMemo(() => {
    const cells: boolean[] = [];
    for (let i = 0; i < height; i++) {
      cells.push(i >= model.thumbTop && i < model.thumbTop + model.thumbHeight);
    }
    return cells;
  }, [model, height]);

  return (
    <box
      ref={trackRef}
      width={1}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
      onMouseDown={press}
      onMouseDrag={drag}
      onMouseDragEnd={release}
      onMouseUp={release}
    >
      {lines.map((inThumb, index) => (
        <text
          key={`sb-${index}`}
          // "░" for the track so it reads as a lane, not a second pane border.
          content={t`${fg(inThumb ? tokens.accent : tokens.textDim)(inThumb ? "█" : "░")}`}
          wrapMode="none"
        />
      ))}
    </box>
  );
});
