import { bold, fg, t } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { formatBytes } from "@kitsunekode/sweep-display";
import { StackBar } from "./Meter.js";
import { categoryGlyph, concatStyled, resolveIconMode, riskGlyph } from "./presentation.js";
import type { ConfirmPreviewItem } from "./confirm-preview.js";
import type { RebuildCost } from "./project-details.js";
import { clipCells, clipWords, padCells, cellWidth } from "./text-cells.js";
import { costColors, riskColor, type ThemeTokens } from "./theme.js";
import { Modal, ModalFooter } from "./widgets.js";

export interface DiskSpace {
  free: number;
  total: number;
}

export interface ConfirmCostShare {
  cost: RebuildCost;
  bytes: number;
  how: string;
}

/**
 * The volume before and after, in one dot-matrix bar: dim used space stays,
 * the green slice is what this removal gives back, and the quiet track is free.
 */
function DiskAfter({
  tokens,
  disk,
  bytes,
  width,
  dryRun,
}: {
  tokens: ThemeTokens;
  disk: DiskSpace;
  bytes: number;
  width: number;
  dryRun?: boolean;
}) {
  const used = Math.max(0, disk.total - disk.free);
  const gain = Math.min(Math.max(0, bytes), used, disk.total);
  const usedAfter = Math.max(0, used - gain);
  const freeAfter = Math.max(0, disk.total - usedAfter - gain);
  const total = Math.max(1, disk.total);
  return (
    <>
      <text
        content={t`${fg(tokens.textMuted)("Disk")}  ${fg(tokens.textSecondary)(
          `${formatBytes(disk.free)} free`,
        )}${fg(tokens.textDim)("  →  ")}${bold(fg(tokens.positive)(`+${formatBytes(gain)}`))}${fg(
          tokens.textMuted,
        )(dryRun ? " if removed" : " after")}`}
        wrapMode="none"
      />
      <StackBar
        width={width}
        segments={[
          { fraction: usedAfter / total, color: tokens.textDim },
          { fraction: gain / total, color: tokens.positive },
          { fraction: freeAfter / total, color: tokens.meterTrack },
        ]}
        trackColor={tokens.meterTrack}
        dimColor={tokens.textDim}
        background={tokens.surface}
        isNoColor={Boolean(process.env.NO_COLOR)}
        variant="dots"
        withSeams={false}
      />
    </>
  );
}

function costLegend(shares: readonly ConfirmCostShare[], tokens: ThemeTokens, width: number) {
  const colors = costColors(tokens);
  const iconMode = resolveIconMode();
  const isNoColor = Boolean(process.env.NO_COLOR);
  let out = t``;
  shares.forEach((share, index) => {
    const label = share.cost === "unknown" ? "custom" : share.cost;
    const glyph = categoryGlyph(share.cost, iconMode, isNoColor);
    const part = t`${index > 0 ? "   " : ""}${fg(colors[share.cost])(glyph)} ${fg(tokens.text)(
      label,
    )} ${fg(tokens.textSecondary)(formatBytes(share.bytes))}${fg(tokens.textDim)(
      ` (${share.how})`,
    )}`;
    out = concatStyled(out, part);
  });
  // The rebuild explanation is trust copy: wrap whole words rather than letting
  // the terminal slice the middle of `npm install` or a size.
  return <text content={out} wrapMode="word" width={Math.max(1, width)} />;
}

function SampleRow({
  item,
  tokens,
  width,
}: {
  item: ConfirmPreviewItem;
  tokens: ThemeTokens;
  width: number;
}) {
  const colors = riskColor(tokens);
  const glyph = riskGlyph[item.riskTier];
  const sizeText = `${item.bytesKnown === false ? "~" : ""}${formatBytes(item.bytes)}`;
  const sizeW = Math.max(9, cellWidth(sizeText));
  const link = item.isSymlink ? " (link)" : "";
  const pathW = Math.max(5, width - sizeW - 4);
  const path = padCells(clipCells(`${item.path}${link}`, pathW), pathW);
  return (
    <text
      content={t`${fg(colors[item.riskTier])(glyph)} ${fg(tokens.text)(path)} ${fg(
        tokens.textSecondary,
      )(sizeText.padStart(sizeW))}`}
      wrapMode="none"
    />
  );
}

export interface ConfirmOverlayProps {
  tokens: ThemeTokens;
  /** The volume the queue lives on, to draw what removal gives back. */
  disk?: DiskSpace | null | undefined;
  selectedCount: number;
  selectedBytes: number;
  dangerousCount: number;
  /** Largest queued candidates by bytes, dangerous first - the last gate names names. */
  previewItems: readonly ConfirmPreviewItem[];
  /** What the queue costs to bring back, grouped by rebuild cost. */
  costShares?: readonly ConfirmCostShare[] | undefined;
  applyPolicy?: { maxSizeGB: number | null; forceLarge: boolean } | undefined;
  lowerBound?: boolean;
  dryRun?: boolean;
  trash?: boolean;
  otherQueuedCount?: number;
  /** What this dialog removes, in words: the item, the project, or the queue. */
  heading?: string;
  linkOnly?: boolean;
  feedback?: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
  onToggleTrash: () => void;
  outsideViewCount?: number;
  directoryCount?: number;
  canConfirm?: boolean;
  onOverrideSizeLimit?: (() => void) | undefined;
  sizeLimitOverridden?: boolean;
}

export function ConfirmOverlay({
  tokens,
  selectedCount,
  selectedBytes,
  dangerousCount,
  previewItems,
  costShares = [],
  dryRun,
  trash,
  applyPolicy,
  lowerBound,
  otherQueuedCount,
  heading,
  linkOnly,
  feedback,
  onConfirm,
  onCancel,
  onToggleTrash,
  outsideViewCount = 0,
  directoryCount = 0,
  canConfirm = true,
  onOverrideSizeLimit,
  sizeLimitOverridden = false,
  disk,
}: ConfirmOverlayProps) {
  const dangerous = dangerousCount > 0;
  const border = dangerous ? tokens.danger : dryRun ? tokens.warning : tokens.borderFocus;
  const shown = previewItems.slice(0, 3);
  const hidden = Math.max(0, selectedCount - shown.length);
  const shownBytes = shown.reduce((sum, item) => sum + item.bytes, 0);
  const hiddenBytes = Math.max(0, selectedBytes - shownBytes);
  // Trash on the same volume keeps the bytes, so only deletion draws a gain.
  const showDisk = disk !== null && disk !== undefined && disk.total > 0 && !trash;
  const { width: screenWidth } = useTerminalDimensions();
  const requestedWidth = Math.max(54, Math.min(66, screenWidth - 10));
  const modalWidth = Math.max(1, Math.min(requestedWidth, screenWidth - 2));
  const paddingX = modalWidth < 44 ? 1 : 2;
  const contentWidth = Math.max(18, modalWidth - 2 - paddingX * 2 - 2);
  const meterWidth = Math.max(8, contentWidth);

  const actionLine = dryRun
    ? "dry run"
    : trash
      ? "move to trash"
      : dangerous
        ? "permanent deletion"
        : "permanent deletion";
  const title = dryRun
    ? `Dry run — ${selectedCount} item${selectedCount === 1 ? "" : "s"}`
    : trash
      ? `Move ${selectedCount} item${selectedCount === 1 ? "" : "s"} to trash`
      : `Delete ${selectedCount} item${selectedCount === 1 ? "" : "s"}`;

  const single = otherQueuedCount !== undefined;
  const otherQueued =
    (otherQueuedCount ?? 0) > 0
      ? `${otherQueuedCount} other queued item${otherQueuedCount === 1 ? " stays" : "s stay"} queued`
      : "";
  const header = heading
    ? `${heading}${otherQueued ? ` · ${otherQueued}` : ""}`
    : single
      ? `Single item${otherQueued ? ` · ${otherQueued}` : ""}`
      : `Queued selection${directoryCount > 0 ? " · folders include everything inside" : ""}`;
  const approx = lowerBound ? "~" : "";
  const ceilingBytes =
    applyPolicy?.maxSizeGB !== null && applyPolicy?.maxSizeGB !== undefined
      ? applyPolicy.maxSizeGB * 1024 ** 3
      : null;
  const overLimit =
    ceilingBytes !== null && !applyPolicy?.forceLarge && selectedBytes > ceilingBytes;
  // The owner-facing rule: the ceiling is always named; the bypass control is
  // hidden only when the queue is far below it. A quarter of the ceiling is
  // "relevant" without exposing the bypass for a 0.2% queue.
  const nearCeiling = ceilingBytes !== null && selectedBytes >= ceilingBytes * 0.25;
  const showOverride = Boolean(
    onOverrideSizeLimit && (overLimit || nearCeiling || sizeLimitOverridden),
  );
  const ceilingText = applyPolicy?.forceLarge
    ? sizeLimitOverridden
      ? "Size ceiling overridden for this review only."
      : "Size ceiling bypass enabled (--force-large)."
    : ceilingBytes === null
      ? "No size ceiling · every path is checked again before removal."
      : `Size ceiling: ${applyPolicy?.maxSizeGB ?? 0} GiB${overLimit ? ` · exceeds by ${formatBytes(selectedBytes - ceilingBytes)}` : ""} · checked again before removal`;
  const trustText = dryRun
    ? "Preview only · no files will be removed."
    : dangerous
      ? trash
        ? `⚠ ${dangerousCount} dangerous item${dangerousCount === 1 ? "" : "s"} leave the working tree.`
        : `⚠ ${dangerousCount} dangerous item${dangerousCount === 1 ? "" : "s"} selected · permanent deletion has no undo.`
      : trash
        ? "Local trash · restore manually · storage remains occupied."
        : "No dangerous items selected · permanent deletion has no undo.";
  const trustColor = dangerous ? (trash ? tokens.warning : tokens.danger) : tokens.textDim;

  return (
    <Modal
      tokens={tokens}
      title={title}
      titleColor={border}
      width={requestedWidth}
      footer={
        <>
          {feedback ? (
            <text fg={tokens.warning} content={feedback} width={contentWidth} wrapMode="word" />
          ) : null}
          <text
            fg={overLimit ? tokens.warning : tokens.textMuted}
            content={ceilingText}
            width={contentWidth}
            wrapMode="word"
          />
          {overLimit ? (
            <text
              fg={tokens.warning}
              content={
                onOverrideSizeLimit
                  ? "Reduce the queue, raise maxSizeGB, or press f to override for this review."
                  : "Reduce the queue or raise maxSizeGB in .sweeprc before confirming."
              }
              width={contentWidth}
              wrapMode="word"
            />
          ) : null}
          <text
            fg={trustColor}
            content={
              linkOnly
                ? `${trustText} Only the symbolic link is affected; linked contents stay.`
                : trustText
            }
            width={contentWidth}
            wrapMode="word"
          />
          <ModalFooter
            tokens={tokens}
            actions={[
              {
                key: "y",
                label: dryRun ? "Preview" : trash ? "Move to trash" : "Delete",
                primary: true,
                tone: !trash && !dryRun ? "danger" : "accent",
                disabled: !canConfirm,
                onPress: onConfirm,
              },
              { key: "n / esc", label: "Cancel", onPress: onCancel },
              ...(dryRun
                ? []
                : [
                    {
                      key: "t",
                      label: trash ? "Delete permanently" : "Move to trash instead",
                      onPress: onToggleTrash,
                    },
                  ]),
              ...(showOverride
                ? [
                    {
                      key: "f",
                      label: sizeLimitOverridden ? "Restore ceiling" : "Override ceiling",
                      disabled: !canConfirm,
                      onPress: onOverrideSizeLimit,
                    },
                  ]
                : []),
            ]}
          />
        </>
      }
    >
      <text
        width={contentWidth}
        fg={tokens.textMuted}
        content={clipWords(header, contentWidth)}
        wrapMode="word"
      />
      {outsideViewCount > 0 ? (
        <text
          fg={tokens.info}
          content={`${outsideViewCount} queued item${outsideViewCount === 1 ? " is" : "s are"} outside the current view.`}
          width={contentWidth}
          wrapMode="word"
        />
      ) : null}
      <text
        content={t`${bold(fg(tokens.text)(`${approx}${formatBytes(selectedBytes)}`))}${fg(
          tokens.textSecondary,
        )(` across ${selectedCount.toLocaleString()} item${selectedCount === 1 ? "" : "s"}`)}${fg(
          tokens.textDim,
        )(`  ·  ${actionLine}`)}`}
        wrapMode="word"
        width={contentWidth}
      />
      {costShares.length > 0 ? costLegend(costShares, tokens, contentWidth) : null}
      {showDisk ? (
        <>
          <text content="" />
          <DiskAfter
            tokens={tokens}
            disk={disk}
            bytes={selectedBytes}
            width={meterWidth}
            {...(dryRun ? { dryRun: true } : {})}
          />
        </>
      ) : null}
      {shown.length > 0 ? <text content="" /> : null}
      {shown.map((item) => (
        <SampleRow key={item.path} item={item} tokens={tokens} width={contentWidth} />
      ))}
      {hidden > 0 ? (
        <text
          content={t`${fg(tokens.textDim)(`  + ${hidden} more item${hidden === 1 ? "" : "s"} · ${approx}${formatBytes(hiddenBytes)}`)}`}
          wrapMode="none"
        />
      ) : null}
    </Modal>
  );
}
