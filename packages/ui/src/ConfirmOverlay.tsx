import { bold, fg, t } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { formatBytes } from "@kitsunekode/sweep-display";
import { ActionButton } from "./ActionButton.js";
import { Meter } from "./Meter.js";
import { mixHex, type ThemeTokens } from "./theme.js";
import { Modal } from "./widgets.js";

export interface DiskSpace {
  free: number;
  total: number;
}

/**
 * The volume before and after, in one bar: the solid part stays used, the
 * soft part is what this removal gives back, the track is free already.
 * The confirm is the one moment the size is about to become real, so it is
 * shown against the whole disk rather than against the queue.
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
  const gain = Math.min(bytes, used);
  return (
    <>
      <text content="" />
      <text
        content={
          // A gain below the display's precision would read "37 GiB → 37 GiB".
          formatBytes(disk.free) === formatBytes(disk.free + gain)
            ? t`${fg(tokens.textMuted)("disk  ")}${fg(tokens.textSecondary)(`${formatBytes(disk.free)} free`)}${fg(tokens.textDim)("  ")}${bold(fg(tokens.positive)(`+${formatBytes(gain)}`))}${fg(tokens.textMuted)(dryRun ? " if removed" : " after")}`
            : t`${fg(tokens.textMuted)("disk  ")}${fg(tokens.textSecondary)(`${formatBytes(disk.free)} free`)}${fg(tokens.textDim)("  →  ")}${bold(fg(tokens.positive)(formatBytes(disk.free + gain)))}${fg(tokens.textMuted)(dryRun ? " if removed" : " after")}`
        }
        wrapMode="none"
      />
      <Meter
        width={width}
        value={(used - gain) / disk.total}
        preview={used / disk.total}
        fill={mixHex(tokens.meterTrack, tokens.textSecondary, 0.7)}
        previewColor={tokens.positive}
        track={tokens.meterTrack}
        background={tokens.surface}
      />
    </>
  );
}

export interface ConfirmOverlayProps {
  tokens: ThemeTokens;
  /** The volume the queue lives on, to draw what removal gives back. */
  disk?: DiskSpace | null | undefined;
  selectedCount: number;
  selectedBytes: number;
  dangerousCount: number;
  /** Largest queued candidates by bytes - the last gate should name names. */
  previewPaths: string[];
  /** What the queue costs to bring back, one line. */
  costLine?: string | undefined;
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
  previewPaths,
  costLine,
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
  // Confirmation describes the operation, including link-only removal.
  const action = dryRun ? "Preview removal of" : trash ? "Move to trash" : "Permanently delete";
  const dangerous = dangerousCount > 0;
  const accent = dangerous && !trash ? tokens.danger : tokens.accent;
  const shown = previewPaths.slice(0, 3);
  const hidden = selectedCount - shown.length;
  // Trash on the same volume keeps the bytes, so only deletion draws a gain.
  const showDisk = disk !== null && disk !== undefined && disk.total > 0 && !trash;
  const { width: screenWidth } = useTerminalDimensions();
  const meterWidth = Math.max(8, Math.min(48, screenWidth - 12));

  return (
    <Modal
      tokens={tokens}
      title={`${dangerous ? "⚠ " : ""}${dryRun ? "Preview" : trash ? "Move" : "Delete"} ${selectedCount} item${selectedCount === 1 ? "" : "s"}${trash && !dryRun ? " to trash" : ""}`}
      titleColor={accent}
      width={56}
      height={
        (applyPolicy && applyPolicy.maxSizeGB !== null
          ? 24
          : selectedCount === 1 && !dangerous
            ? 18
            : 22) +
        (showDisk ? 3 : 0) +
        (costLine ? 2 : 0)
      }
      footer={
        <>
          {feedback ? <text fg={tokens.info} content={feedback} /> : null}
          <box flexDirection="row" flexWrap="wrap" gap={1}>
            <ActionButton
              tokens={tokens}
              label={dryRun ? "y Preview" : trash ? "y Move to trash" : "y Delete"}
              danger={!trash && !dryRun}
              disabled={!canConfirm}
              onPress={onConfirm}
            />
            <ActionButton tokens={tokens} label="n / Esc Cancel" onPress={onCancel} />
            {dryRun ? null : (
              <ActionButton
                tokens={tokens}
                label={trash ? "t Delete permanently instead" : "t Move to trash instead"}
                onPress={onToggleTrash}
              />
            )}
            {onOverrideSizeLimit ? (
              <ActionButton
                tokens={tokens}
                label={sizeLimitOverridden ? "f Restore size ceiling" : "f Override size ceiling"}
                onPress={onOverrideSizeLimit}
                disabled={!canConfirm}
              />
            ) : null}
          </box>
        </>
      }
    >
      <text
        fg={tokens.textMuted}
        content={
          heading ?? (otherQueuedCount === undefined ? "The queued items" : "Only this item")
        }
      />
      {outsideViewCount > 0 ? (
        <text
          fg={tokens.info}
          content={`${outsideViewCount} queued item${outsideViewCount === 1 ? " is" : "s are"} outside the current view.`}
        />
      ) : null}
      {directoryCount > 0 ? (
        <text content="Selected folders include everything inside them." fg={tokens.textMuted} />
      ) : null}
      <text
        content={t`${bold(fg(accent)(`${action} ${selectedCount} item${selectedCount === 1 ? "" : "s"}`))}`}
      />
      <text
        content={t`${fg(tokens.positive)(`${lowerBound ? "~" : ""}${formatBytes(selectedBytes)}`)} ${fg(tokens.textMuted)(lowerBound ? "partial estimate; actual bytes may differ" : "estimated size")}`}
      />
      {costLine ? (
        <text
          content={t`${fg(tokens.textMuted)("comes back by ")}${fg(tokens.textSecondary)(costLine)}`}
          wrapMode="word"
        />
      ) : null}
      {showDisk ? (
        <DiskAfter
          tokens={tokens}
          disk={disk}
          bytes={selectedBytes}
          width={meterWidth}
          {...(dryRun ? { dryRun: true } : {})}
        />
      ) : null}
      {shown.map((path) => (
        <text
          key={path}
          content={t`${fg(tokens.textDim)("·")} ${fg(tokens.textSecondary)(path)}`}
          wrapMode="word"
        />
      ))}
      {hidden > 0 ? (
        <text content={t`${fg(tokens.textDim)(`  …and ${hidden} more`)}`} wrapMode="none" />
      ) : null}
      {linkOnly ? (
        <text
          fg={tokens.warning}
          content={
            trash
              ? "Moves only the symbolic link. Linked contents stay."
              : "Removes only the symbolic link. Linked contents stay."
          }
        />
      ) : null}
      {otherQueuedCount !== undefined && otherQueuedCount > 0 ? (
        <text
          fg={tokens.textSecondary}
          content={`${otherQueuedCount} other queued item${otherQueuedCount === 1 ? " stays" : "s stay"} queued`}
        />
      ) : null}
      <text content="" />
      {applyPolicy && (applyPolicy.maxSizeGB !== null || applyPolicy.forceLarge) ? (
        <text
          fg={
            applyPolicy.forceLarge || applyPolicy.maxSizeGB !== null
              ? tokens.warning
              : tokens.textMuted
          }
          content={
            applyPolicy.forceLarge
              ? sizeLimitOverridden
                ? "Size ceiling overridden for this review only."
                : "Size ceiling bypass enabled (--force-large)."
              : applyPolicy.maxSizeGB === null
                ? "No byte ceiling"
                : `Size ceiling: ${applyPolicy.maxSizeGB} GiB; checked again before removal.`
          }
        />
      ) : null}
      {applyPolicy &&
      applyPolicy.maxSizeGB !== null &&
      !applyPolicy.forceLarge &&
      selectedBytes > applyPolicy.maxSizeGB * 1024 ** 3 ? (
        <box flexDirection="column">
          <text
            fg={tokens.warning}
            content="Over the limit. Reduce the queue or raise maxSizeGB in .sweeprc."
          />
          <text
            fg={tokens.warning}
            content={
              onOverrideSizeLimit
                ? "Choose Override size ceiling for this review, then confirm."
                : "Restart override: --force-large --yes"
            }
          />
        </box>
      ) : null}
      <text content="" />
      {dryRun ? (
        <text content={t`${fg(tokens.textDim)("Preview only. No files will be removed.")}`} />
      ) : dangerous ? (
        <text
          content={t`${fg(trash ? tokens.warning : tokens.danger)(
            trash
              ? `⚠ ${dangerousCount} dangerous item${dangerousCount === 1 ? "" : "s"} leave the working tree.`
              : `⚠ ${dangerousCount} dangerous item${dangerousCount === 1 ? "" : "s"} selected. This cannot be undone.`,
          )}`}
        />
      ) : trash ? (
        <text
          content={t`${fg(tokens.textDim)("Local trash; restore manually. Storage remains occupied.")}`}
        />
      ) : (
        <text
          content={t`${fg(tokens.textDim)("No items classified as dangerous. Permanent deletion has no undo.")}`}
        />
      )}
    </Modal>
  );
}
