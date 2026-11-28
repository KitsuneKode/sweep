import type { ApplyProgress } from "@kitsunekode/sweep-protocol";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { StyledText, bold, fg, t, type TextChunk } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { StackBar } from "./Meter.js";
import { useMotionEnabled } from "./motion.js";
import { relativePath } from "./presentation.js";
import { clipWords } from "./text-cells.js";
import type { ThemeTokens } from "./theme.js";
import { Modal, ModalFooter, useDotFrame } from "./widgets.js";

/** A single dot-matrix activity bar for the brief window before targets are counted. */
function IndeterminateDotBar({ tokens, width }: { tokens: ThemeTokens; width: number }) {
  const frame = useDotFrame(true, 90);
  const run = Math.max(3, Math.min(8, Math.floor(width / 5)));
  const travel = width + run;
  const start = (frame % travel) - run;
  const chunks: TextChunk[] = [];
  let index = 0;
  const isActive = (cell: number) => cell >= start && cell < start + run;
  while (index < width) {
    const active = isActive(index);
    let end = index + 1;
    while (end < width && isActive(end) === active) end += 1;
    chunks.push(
      fg(active ? tokens.accent : tokens.meterTrack)((active ? "⣿" : "⣀").repeat(end - index)),
    );
    index = end;
  }
  return <text content={new StyledText(chunks)} wrapMode="none" />;
}

function keyValueLine(
  key: string,
  value: string,
  tokens: ThemeTokens,
  width: number,
  valueColor = tokens.textSecondary,
) {
  return (
    <text
      content={t`${fg(tokens.textDim)(key.padEnd(8))}${fg(valueColor)(clipWords(value, Math.max(4, width - 8)))}`}
      wrapMode="none"
    />
  );
}

/** Percentages describe completed candidate operations, never bytes within a tree. */
export function ApplyOverlay({
  tokens,
  name,
  progress,
  targetDir,
  trash,
  onCancel,
  onToggleMotion,
}: {
  tokens: ThemeTokens;
  name: string;
  progress: ApplyProgress | null;
  targetDir: string;
  trash: boolean;
  onCancel: () => void;
  onToggleMotion?: (() => void) | undefined;
}) {
  const { width } = useTerminalDimensions();
  const motionEnabled = useMotionEnabled();
  const stopping = progress?.stage === "stopping";
  const preparing = progress?.stage === "preparing";
  const total = progress?.selectedCount ?? 0;
  const completed = progress?.deletedCount ?? 0;
  // The authoritative final report closes the apply. 100% beforehand would
  // imply success despite pending failures, covered selections or receipt loss.
  const itemPercent =
    total > 0 ? Math.min(99, Math.max(0, Math.floor((completed / total) * 100))) : 0;
  const preparationTotal = progress?.preparingCount ?? 0;
  const prepared = Math.min(preparationTotal, Math.max(0, progress?.preparedCount ?? 0));
  const preparationPercent =
    preparationTotal > 0 ? Math.floor((prepared / preparationTotal) * 100) : null;
  const percent = preparing ? preparationPercent : itemPercent;
  const phase = stopping
    ? "Stopping after current item"
    : preparing
      ? progress?.preparationPhase === "sizing"
        ? "Checking sizes"
        : "Preparing removal"
      : trash
        ? "Moving to trash"
        : "Removing";
  const requestedWidth = Math.max(52, Math.min(64, width - 12));
  const modalWidth = Math.max(1, Math.min(requestedWidth, width - 2));
  const paddingX = modalWidth < 44 ? 1 : 2;
  const contentWidth = Math.max(18, modalWidth - 2 - paddingX * 2 - 2);
  const barWidth = Math.max(8, contentWidth);
  const reportPending = !preparing && !stopping && total > 0 && completed >= total;
  const subject = total > 1 ? `${total.toLocaleString()} queued items` : sanitizeTerminalText(name);
  const percentText = percent === null ? "counting" : `${percent}%`;
  const progressColor = stopping ? tokens.warning : tokens.borderFocus;
  const elapsed = ((progress?.elapsedMs ?? 0) / 1000).toFixed(1);
  const countWidth = Math.max(1, String(Math.max(total, 1)).length);
  const completedText = `${completed.toLocaleString().padStart(countWidth)} of ${total.toLocaleString()}`;
  const activePath = progress?.activePath
    ? sanitizeTerminalText(relativePath(targetDir, progress.activePath))
    : "";

  return (
    <Modal
      tokens={tokens}
      title={stopping ? "Stopping removal" : trash ? "Moving to trash" : "Removing artifacts"}
      titleColor={progressColor}
      width={requestedWidth}
      footer={
        <ModalFooter
          tokens={tokens}
          actions={[
            {
              key: "esc",
              label: stopping ? "Stop requested" : "Stop after current item",
              tone: "warning",
              primary: true,
              onPress: onCancel,
            },
            {
              key: "m",
              label: motionEnabled ? "Pause motion" : "Resume motion",
              ...(onToggleMotion ? { onPress: onToggleMotion } : {}),
            },
          ]}
        />
      }
    >
      <text
        width={contentWidth}
        content={t`${bold(fg(tokens.text)(`${phase} ${subject}`))}${fg(tokens.textDim)("   ·   ")}${bold(
          fg(progressColor)(percentText),
        )}`}
        wrapMode="word"
      />
      {percent === null ? (
        <IndeterminateDotBar tokens={tokens} width={barWidth} />
      ) : (
        <StackBar
          width={barWidth}
          segments={[{ fraction: Math.max(percent / 100, 0.001), color: progressColor }]}
          fillFraction={Math.max(0, Math.min(1, percent / 100))}
          trackColor={tokens.meterTrack}
          dimColor={tokens.textDim}
          background={tokens.surface}
          isNoColor={Boolean(process.env.NO_COLOR)}
          variant="dots"
        />
      )}
      <text
        width={contentWidth}
        content={t`${fg(tokens.textDim)("Completed")} ${fg(tokens.text)(completedText)}${fg(
          tokens.textDim,
        )("  ·  Freed ")}${bold(
          fg(tokens.positive)(`~${formatBytes(progress?.estimatedBytesFreed ?? 0)}`),
        )}${fg(tokens.textDim)(`  ·  Elapsed ${elapsed}s`)}`}
        wrapMode="word"
      />
      {activePath ? keyValueLine("Active", activePath, tokens, contentWidth) : null}
      {progress?.removedEntries !== undefined
        ? keyValueLine(
            "Entries",
            `${progress.removedEntries.toLocaleString()} files removed inside this folder`,
            tokens,
            contentWidth,
          )
        : null}
      {reportPending ? (
        <text
          content="Finishing the last item · waiting for the final report."
          fg={tokens.textMuted}
          wrapMode="word"
        />
      ) : null}
      <text
        content={
          stopping
            ? "Stop requested · completed deletions stay removed."
            : "Completed deletions cannot be undone."
        }
        fg={stopping ? tokens.warning : tokens.textDim}
        wrapMode="word"
      />
    </Modal>
  );
}
