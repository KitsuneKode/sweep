import type { ProjectSweeprcDelta } from "@kitsunekode/sweep-core/config";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { ActionButton } from "./ActionButton.js";
import type { ActionMenuCommand } from "./action-menu.js";
import type { ThemeTokens } from "./theme.js";
import { Modal, ModalFooter } from "./widgets.js";

export interface ConfigSaveState {
  path: string;
  delta: ProjectSweeprcDelta;
  revision: string;
}

export interface FolderInfoState {
  path: string;
  count: number;
  queued: number;
  scanning: boolean;
}

export function FolderInfoModal({
  tokens,
  folderInfo,
  onClose,
}: {
  tokens: ThemeTokens;
  folderInfo: FolderInfoState;
  onClose: () => void;
}) {
  return (
    <Modal
      tokens={tokens}
      title="Folder details"
      width={64}
      footer={
        <ModalFooter tokens={tokens} actions={[{ key: "esc", label: "close", onPress: onClose }]} />
      }
    >
      <text content={sanitizeTerminalText(folderInfo.path)} wrapMode="char" fg={tokens.text} />
      <text
        content={`${folderInfo.count} items in this view · ${folderInfo.queued} queued here`}
        fg={tokens.textSecondary}
        wrapMode="word"
      />
      <text
        content="Folder, search and risk filters determine this view. Browsing does not change your queue."
        fg={tokens.textMuted}
        wrapMode="word"
      />
      {folderInfo.scanning ? (
        <text
          content="Scan is running; these are a snapshot of discovered items."
          fg={tokens.warning}
          wrapMode="word"
        />
      ) : null}
    </Modal>
  );
}

export function PatternInfoModal({
  tokens,
  pattern,
  onClose,
}: {
  tokens: ThemeTokens;
  pattern: string;
  onClose: () => void;
}) {
  return (
    <Modal
      tokens={tokens}
      title="Pattern details"
      width={60}
      footer={
        <ModalFooter tokens={tokens} actions={[{ key: "esc", label: "close", onPress: onClose }]} />
      }
    >
      <text content={sanitizeTerminalText(pattern)} fg={tokens.text} wrapMode="word" />
      <text
        content="Matches artifact names inside the scanned tree."
        fg={tokens.textMuted}
        wrapMode="word"
      />
    </Modal>
  );
}

export function ConfigSaveModal({
  tokens,
  configSave,
  canConfirm,
  onConfirm,
  onCancel,
}: {
  tokens: ThemeTokens;
  configSave: ConfigSaveState;
  canConfirm: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      tokens={tokens}
      title="Save cleanup patterns?"
      width={60}
      footer={
        <ModalFooter
          tokens={tokens}
          actions={[
            {
              key: "y",
              label: "save patterns",
              primary: true,
              disabled: !canConfirm,
              onPress: onConfirm,
            },
            { key: "n / esc", label: "cancel", onPress: onCancel },
          ]}
        />
      }
    >
      <text content={sanitizeTerminalText(configSave.path)} fg={tokens.text} wrapMode="word" />
      <text
        content="Updates patterns and disabledPatterns only. Other settings are kept."
        fg={tokens.textMuted}
        wrapMode="word"
      />
      <text content="Extra patterns:" fg={tokens.text} />
      {configSave.delta.patterns.length ? (
        configSave.delta.patterns.map((pattern) => (
          <text
            key={`on-${pattern}`}
            content={sanitizeTerminalText(pattern)}
            fg={tokens.textSecondary}
            wrapMode="word"
          />
        ))
      ) : (
        <text content="None; built-in defaults remain." fg={tokens.textSecondary} />
      )}
      <text content="Disabled defaults:" fg={tokens.text} />
      {configSave.delta.disabledPatterns.length ? (
        configSave.delta.disabledPatterns.map((pattern) => (
          <text
            key={`off-${pattern}`}
            content={sanitizeTerminalText(pattern)}
            fg={tokens.textSecondary}
            wrapMode="word"
          />
        ))
      ) : (
        <text content="None." fg={tokens.textSecondary} />
      )}
      {!canConfirm ? (
        <text content="Resize to 40 columns and 12 rows to review." fg={tokens.warning} />
      ) : null}
    </Modal>
  );
}

export function ActionMenuModal({
  tokens,
  query,
  fits,
  cursor,
  top,
  pageSize,
  commands,
  onInput,
  onMovePage,
  onRunCommand,
  onClose,
}: {
  tokens: ThemeTokens;
  query: string;
  fits: boolean;
  cursor: number;
  top: number;
  pageSize: number;
  commands: readonly ActionMenuCommand[];
  onInput: (value: string) => void;
  onMovePage: (direction: -1 | 1) => void;
  onRunCommand: (index: number) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      tokens={tokens}
      title="Search actions"
      width={58}
      height={22}
      footer={
        <>
          <text
            content={
              fits
                ? "↑↓ choose · Enter open · Esc close"
                : "Resize the terminal to use actions · Esc close"
            }
            fg={tokens.textMuted}
          />
          <box flexDirection="row" flexWrap="wrap" gap={1}>
            <ActionButton
              tokens={tokens}
              label="Previous"
              disabled={!fits || top === 0}
              onPress={() => onMovePage(-1)}
            />
            <ActionButton
              tokens={tokens}
              label="Next"
              disabled={!fits || top + pageSize >= commands.length}
              onPress={() => onMovePage(1)}
            />
            <ActionButton tokens={tokens} label="Close" onPress={onClose} />
          </box>
        </>
      }
    >
      <input
        focused
        value={query}
        maxLength={128}
        placeholder="Type an action or shortcut…"
        backgroundColor={tokens.surfaceInset}
        focusedBackgroundColor={tokens.surfaceInset}
        textColor={tokens.text}
        cursorColor={tokens.accent}
        onInput={onInput}
      />
      {fits ? (
        <text
          content={
            commands.length === 0
              ? "No matching actions. Clear the search to try again."
              : `${top + 1}–${Math.min(commands.length, top + pageSize)} of ${commands.length} actions`
          }
          fg={tokens.textMuted}
        />
      ) : (
        <text content="Resize to use actions" fg={tokens.textMuted} />
      )}
      {fits
        ? commands
            .slice(top, top + pageSize)
            .map((command, localIndex) => (
              <ActionButton
                key={command.label}
                tokens={tokens}
                active={cursor === top + localIndex}
                disabled={command.disabled}
                label={`${command.label}${command.shortcut ? ` · ${command.shortcut}` : ""}`}
                onPress={() => onRunCommand(top + localIndex)}
              />
            ))
        : null}
    </Modal>
  );
}

export function UnavailableItemModal({
  tokens,
  onClose,
}: {
  tokens: ThemeTokens;
  onClose?: () => void;
}) {
  return (
    <Modal
      tokens={tokens}
      title="Item unavailable"
      width={60}
      footer={
        <ModalFooter
          tokens={tokens}
          actions={[{ key: "n / esc", label: "close", onPress: onClose }]}
        />
      }
    >
      <text
        content="The reviewed artifact is no longer present. Nothing will be removed."
        fg={tokens.text}
        wrapMode="word"
      />
    </Modal>
  );
}

export function ScanErrorModal({
  tokens,
  message,
  onRetry,
  onDismiss,
  onQuit,
}: {
  tokens: ThemeTokens;
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  onQuit?: () => void;
}) {
  return (
    <Modal
      tokens={tokens}
      title="Scan failed"
      titleColor={tokens.danger}
      width={60}
      footer={
        <ModalFooter
          tokens={tokens}
          actions={[
            { key: "r", label: "retry scan", primary: true, onPress: onRetry },
            { key: "esc", label: "dismiss", onPress: onDismiss },
            { key: "q", label: "quit", onPress: onQuit },
          ]}
        />
      }
    >
      <text
        // Engine errors arrive prefixed ("error: ...") - redundant inside a
        // dialog already titled "Scan failed".
        content={sanitizeTerminalText(message.replace(/^[Ee]rror:\s*/, ""))}
        fg={tokens.text}
        wrapMode="word"
      />
    </Modal>
  );
}
