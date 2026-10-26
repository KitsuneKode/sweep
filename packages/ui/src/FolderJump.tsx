import { bold, fg, t } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { jumpLabel, tildePath, type JumpSource, type JumpTarget } from "./folder-jump.js";
import { keycap } from "./presentation.js";
import { clipCells } from "./text-cells.js";
import type { ThemeTokens } from "./theme.js";
import { Modal } from "./widgets.js";

const WIDTH = 72;

const SOURCE_GLYPH: Record<JumpSource, string> = {
  typed: "›",
  up: "↑",
  cleaned: "↺",
  inside: "↳",
  beside: "·",
};
const SOURCE_LABEL: Record<JumpSource, string> = {
  typed: "path",
  up: "up one level",
  cleaned: "",
  inside: "",
  beside: "",
};

export interface FolderJumpProps {
  tokens: ThemeTokens;
  targetDir: string;
  query: string;
  results: readonly JumpTarget[];
  cursor: number;
  /** Items queued in this folder; switching drops them, so the card says so. */
  queuedCount: number;
  /** Why the last pick was refused (a protected root, a vanished folder). */
  error: string | null;
  onInput: (value: string) => void;
  onPick: (index: number) => void;
}

/** Keep the folder's own name whole; shorten the path in front of it. */
function shortenPath(path: string, width: number): string {
  if (path.length <= width) return path;
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = path.slice(cut);
  if (name.length + 2 >= width) return clipCells(path, width, true);
  return `${path.slice(0, width - name.length - 1)}…${name}`;
}

/**
 * Switch the folder a session reviews without leaving it: type to fuzzy-find
 * a nearby project or a folder cleaned before, or type a path outright.
 * Choosing one rescans there with that folder's own config and guardrails.
 */
export function FolderJump({
  tokens,
  targetDir,
  query,
  results,
  cursor,
  queuedCount,
  error,
  onInput,
  onPick,
}: FolderJumpProps) {
  const { height } = useTerminalDimensions();
  const room = Math.max(3, Math.min(12, height - 14));
  const start = Math.max(0, Math.min(cursor - Math.floor(room / 2), results.length - room));
  const shown = results.slice(start, start + room);
  const inner = WIDTH - 8;
  const detailWidth = 16;
  const pathWidth = inner - detailWidth - 4;

  // A refusal is the one line worth reading in full: it wraps, never clips.
  const status = error
    ? t`${fg(tokens.danger)(sanitizeTerminalText(error).slice(0, inner * 2))}`
    : queuedCount > 0
      ? t`${fg(tokens.warning)(`${queuedCount} queued`)}${fg(tokens.textDim)(
          " · switching clears the queue; nothing is removed",
        )}`
      : t`${fg(tokens.textDim)("Rescans there with that folder's own .sweeprc and guardrails.")}`;

  return (
    <Modal
      tokens={tokens}
      title=" switch folder "
      width={WIDTH}
      height={Math.min(height - 2, room + 12)}
      footer={
        <text
          content={t`${keycap("↑↓", tokens)} ${fg(tokens.textMuted)("choose")}  ${keycap("enter", tokens)} ${fg(tokens.textMuted)("scan there")}  ${keycap("esc", tokens)} ${fg(tokens.textMuted)("stay")}`}
          wrapMode="none"
        />
      }
    >
      <text
        content={t`${fg(tokens.textMuted)("from ")}${fg(tokens.textSecondary)(
          shortenPath(sanitizeTerminalText(tildePath(targetDir)), inner - 5),
        )}`}
        wrapMode="none"
      />
      <input
        focused
        value={query}
        maxLength={512}
        placeholder="name, or a path: ~/code, ../other"
        backgroundColor={tokens.surfaceInset}
        focusedBackgroundColor={tokens.surfaceInset}
        textColor={tokens.text}
        cursorColor={tokens.accent}
        onInput={onInput}
      />
      <text content="" />
      {shown.length === 0 ? (
        <text
          content={t`${fg(tokens.textDim)(
            query.trim() ? "No folder matches. Type a path to go anywhere." : "Nothing nearby.",
          )}`}
          wrapMode="none"
        />
      ) : (
        shown.map((target, offset) => {
          const index = start + offset;
          const current = index === cursor;
          const path = shortenPath(sanitizeTerminalText(jumpLabel(target, targetDir)), pathWidth);
          const detail = clipCells(
            sanitizeTerminalText(target.detail ?? SOURCE_LABEL[target.source]),
            detailWidth,
            false,
          );
          return (
            <box
              key={target.path}
              height={1}
              backgroundColor={current ? tokens.selectionBg : tokens.surface}
              onMouseDown={() => onPick(index)}
            >
              <text
                content={t`${fg(current ? tokens.accent : tokens.textDim)(current ? "›" : " ")} ${fg(
                  tokens.textDim,
                )(SOURCE_GLYPH[target.source])} ${
                  current
                    ? bold(fg(tokens.text)(path.padEnd(pathWidth)))
                    : fg(tokens.textSecondary)(path.padEnd(pathWidth))
                }${fg(tokens.textDim)(detail.padStart(detailWidth))}`}
                wrapMode="none"
              />
            </box>
          );
        })
      )}
      <text content="" />
      <text content={status} wrapMode={error ? "word" : "none"} />
    </Modal>
  );
}
