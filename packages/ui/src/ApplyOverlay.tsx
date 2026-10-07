import type { ApplyProgress } from "@kitsunekode/sweep-protocol";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { useTerminalDimensions } from "@opentui/react";
import { buildMeter, relativePath } from "./presentation.js";
import { DotStrip, Modal } from "./widgets.js";
import type { ThemeTokens } from "./theme.js";

/** Percentages describe completed candidate operations, never bytes within a tree. */
export function ApplyOverlay({
  tokens,
  name,
  progress,
  targetDir,
  trash,
  onCancel,
}: {
  tokens: ThemeTokens;
  name: string;
  progress: ApplyProgress | null;
  targetDir: string;
  trash: boolean;
  onCancel: () => void;
}) {
  const { width } = useTerminalDimensions();
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
    ? "Stopping"
    : preparing
      ? progress?.preparationPhase === "sizing"
        ? "Size check"
        : "Preparing"
      : trash
        ? "Moving to trash"
        : "Removing";
  const meterWidth = Math.max(1, Math.min(72, width - 2) - 12);
  const reportPending = !preparing && !stopping && total > 0 && completed >= total;
  return (
    <Modal
      tokens={tokens}
      title=" applying "
      titleColor={tokens.info}
      width={72}
      height={17}
      footer={
        <>
          <box height={1} onMouseDown={onCancel}>
            <text
              content={
                stopping
                  ? "Stopping · waiting for in-flight work and report"
                  : "esc / ctrl-c stop · click here to stop"
              }
              fg={tokens.warning}
              wrapMode="none"
            />
          </box>
          <text content="Completed deletions are not undone." fg={tokens.textMuted} />
        </>
      }
    >
      <text content={`${phase} ${sanitizeTerminalText(name)}`} fg={tokens.text} wrapMode="word" />
      <text
        content={
          preparing
            ? `${phase}${percent === null ? " · counting targets" : ` · ${percent}% (${prepared} / ${preparationTotal})`}`
            : `${phase} · ${itemPercent}% of items${reportPending ? " · report pending" : ""}`
        }
        fg={tokens.info}
        wrapMode="word"
      />
      {percent === null ? (
        <DotStrip tokens={tokens} width={12} />
      ) : (
        <text content={buildMeter(percent, 100, meterWidth, tokens)} wrapMode="none" />
      )}
      <text
        content={`${completed} / ${total} removals completed · ${((progress?.elapsedMs ?? 0) / 1000).toFixed(1)}s`}
        fg={tokens.text}
      />
      <text
        content={`~${formatBytes(progress?.estimatedBytesFreed ?? 0)} estimated bytes ${trash ? "moved" : "removed"}`}
        fg={tokens.textMuted}
      />
      {progress?.activePath ? (
        <text
          content={sanitizeTerminalText(relativePath(targetDir, progress.activePath))}
          fg={tokens.textSecondary}
          wrapMode="word"
        />
      ) : null}
      <text
        content="Items are whole artifacts, not files inside a directory."
        fg={tokens.textMuted}
      />
      <text content="" />
    </Modal>
  );
}
