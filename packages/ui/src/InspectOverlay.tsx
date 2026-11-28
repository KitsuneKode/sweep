import { bold, fg, type StyledText, t } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { ActionButton } from "./ActionButton.js";
import { relativePath, riskGlyph } from "./presentation.js";
import type { ThemeTokens } from "./theme.js";
import { Modal } from "./widgets.js";

/**
 * Per-candidate detail - the "why" behind a row. Reasons, entry type and the
 * full (sanitized) path never fit the list row; the list is for triage, this
 * is for trust.
 */
export function InspectOverlay({
  tokens,
  candidate,
  queued,
  targetDir,
  onClose,
  onReview,
}: {
  tokens: ThemeTokens;
  candidate: ScanCandidate;
  queued: boolean;
  targetDir: string;
  onClose: () => void;
  onReview: () => void;
}) {
  const { width } = useTerminalDimensions();
  const compact = width < 48;
  const rel = relativePath(targetDir, candidate.path);
  const riskGlyphColor = {
    safe: tokens.positive,
    caution: tokens.warning,
    dangerous: tokens.danger,
    blocked: tokens.blocked,
  }[candidate.riskTier];

  const field = (label: string, value: string | StyledText) => (
    <box flexDirection={compact ? "column" : "row"} width="100%" flexShrink={0}>
      <text content={t`${fg(tokens.textDim)(label.padEnd(9))} `} wrapMode="none" />
      {typeof value === "string" ? (
        <text
          content={t`${fg(tokens.text)(value)}`}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          wrapMode="char"
        />
      ) : (
        <text content={value} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="char" />
      )}
    </box>
  );

  return (
    <Modal
      tokens={tokens}
      title="Artifact details"
      width={64}
      height={22}
      footer={
        <box flexDirection="row" flexWrap="wrap" gap={1}>
          <ActionButton
            tokens={tokens}
            label="x Review removal"
            onPress={onReview}
            disabled={candidate.riskTier === "blocked"}
          />
          <ActionButton tokens={tokens} label="Esc Close" onPress={onClose} />
        </box>
      }
    >
      <box flexDirection="column">
        <text
          content={t`${fg(riskGlyphColor)(riskGlyph[candidate.riskTier])} ${bold(fg(tokens.text)(sanitizeTerminalText(candidate.name)))} ${fg(tokens.textMuted)(candidate.kind)}`}
          wrapMode="char"
        />
        <text content="" />
        {field("root", sanitizeTerminalText(targetDir))}
        {field("path", sanitizeTerminalText(rel.length > 0 ? rel : candidate.name))}
        {field(
          "size",
          `${formatBytes(candidate.estimatedBytes)}${candidate.bytesKnown === false ? " (partial - unreadable subtree)" : ""}`,
        )}
        {field(
          "risk",
          t`${fg(riskGlyphColor)(candidate.riskTier)}${queued ? fg(tokens.accent)("  · queued") : ""}`,
        )}
        {field(
          "type",
          candidate.isSymlink
            ? `${candidate.entryType} (link only, target never scanned)`
            : candidate.entryType,
        )}
        <text
          content={
            candidate.isSymlink
              ? "Only the link is removed. Its destination stays."
              : candidate.kind === "node_modules"
                ? "Dependencies will need reinstalling. Check for local changes inside this folder."
                : candidate.kind === "target"
                  ? "Generated Cargo output can be rebuilt. The next build may take longer."
                  : "Check that you can recreate these contents before removing them."
          }
          fg={tokens.textSecondary}
          wrapMode="word"
        />
        {candidate.reasons.length > 0 ? (
          <>
            <text content="" />
            <text content={t`${fg(tokens.textDim)("why it was flagged:")}`} wrapMode="none" />
            {candidate.reasons.map((reason) => (
              <text
                key={reason}
                content={t`  ${fg(tokens.textDim)("·")} ${fg(tokens.textSecondary)(sanitizeTerminalText(reason))}`}
                wrapMode="char"
              />
            ))}
          </>
        ) : null}
        <text content="" />
      </box>
    </Modal>
  );
}
