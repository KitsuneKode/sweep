import { homedir } from "node:os";
import type { RiskTier, ScanCandidate } from "@kitsunekode/sweep-protocol";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { bold, fg, t, type StyledText } from "@opentui/core";
import { useMemo } from "react";
import { ActionButton } from "./ActionButton.js";
import { ScanMeter } from "./Meter.js";
import { buildBrandLine, concatStyled, riskGlyph } from "./presentation.js";
import { compactBytesLabel } from "./sidebar.js";
import type { SweepUiSummary } from "./state.js";
import { cellWidth, clipCells } from "./text-cells.js";
import { riskColor, type ThemeTokens } from "./theme.js";

type Tier = Exclude<RiskTier, "blocked">;
const TIERS: readonly Tier[] = ["safe", "caution", "dangerous"];

export interface Ledger {
  bytes: Record<RiskTier, number>;
  counts: Record<RiskTier, number>;
  /** Safe + caution bytes only (aligned across Projects and Full views). */
  reclaimable: number;
  /** Dangerous + blocked bytes: shown separately, never added to reclaimable. */
  guarded: number;
  /** True when any safe or caution entry has unknown bytes (`bytesKnown === false`). */
  reclaimablePartial: boolean;
  /** True when any dangerous or blocked entry has unknown bytes (`bytesKnown === false`). */
  guardedPartial: boolean;
  /** True when any candidate in the scan has unknown bytes (`bytesKnown === false`). */
  partial: boolean;
}

/** `62 GiB`: the compact label with the unit set apart, for prose-like lines. */
export function spacedBytes(bytes: number): string {
  return compactBytesLabel(bytes).replace(/(\d)([A-Za-z])/, "$1 $2");
}

/** Bytes and counts by tier for the whole scan, independent of any filter. */
export function buildLedger(candidates: readonly ScanCandidate[]): Ledger {
  const bytes: Record<RiskTier, number> = { safe: 0, caution: 0, dangerous: 0, blocked: 0 };
  const counts: Record<RiskTier, number> = { safe: 0, caution: 0, dangerous: 0, blocked: 0 };
  let reclaimablePartial = false;
  let guardedPartial = false;
  for (const candidate of candidates) {
    bytes[candidate.riskTier] += candidate.estimatedBytes;
    counts[candidate.riskTier] += 1;
    if (candidate.bytesKnown === false) {
      if (candidate.riskTier === "safe" || candidate.riskTier === "caution") {
        reclaimablePartial = true;
      } else {
        guardedPartial = true;
      }
    }
  }
  return {
    bytes,
    counts,
    reclaimable: bytes.safe + bytes.caution,
    guarded: bytes.dangerous + bytes.blocked,
    reclaimablePartial,
    guardedPartial,
    partial: reclaimablePartial || guardedPartial,
  };
}

/** Bytes the "Queue safe" button would add: safe, listed and not yet queued. */
export function queueSafeBytes(
  visible: readonly ScanCandidate[],
  selectedIds: ReadonlySet<string>,
): number {
  let total = 0;
  for (const candidate of visible) {
    if (candidate.riskTier === "safe" && !selectedIds.has(candidate.id)) {
      total += candidate.estimatedBytes;
    }
  }
  return total;
}

/** `~/Projects` rather than `/home/me/Projects`; the inspector has the rest. */
export function displayTarget(targetDir: string, home = homedir()): string {
  const clean = sanitizeTerminalText(targetDir);
  if (home && (clean === home || clean.startsWith(`${home}/`))) {
    return `~${clean.slice(home.length)}`;
  }
  return clean;
}

/**
 * A thin rule that fills with the signal as the queue grows: `━━━━────`.
 * Heavy and light strokes keep the two parts distinct without colour.
 */
export function buildQueueRule(
  value: number,
  total: number,
  width: number,
  fill: string,
  track: string,
): StyledText {
  const cells = Math.max(0, width);
  const ratio = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  // Any queued byte shows at least one cell; a full queue is never rounded short.
  const filled = value > 0 && total > 0 ? Math.max(1, Math.round(ratio * cells)) : 0;
  return t`${fg(fill)("━".repeat(filled))}${fg(track)("─".repeat(Math.max(0, cells - filled)))}`;
}

/** The last apply's outcome, held until something is queued again. */
export interface LedgerReceipt {
  removed: number;
  failed: number;
  unattempted: number;
  freedBytes: number;
  /** Measured change in free space on the volume; absent when it could not be read. */
  diskGained?: number | undefined;
  trash: boolean;
  stopped: boolean;
}

/** One line a cleaner can read at a glance after an apply: what came back. */
export function buildReceiptLine(receipt: LedgerReceipt, tokens: ThemeTokens): StyledText {
  const verb = receipt.trash ? "moved to trash" : "freed";
  const parts: StyledText[] = [
    t`${fg(tokens.positive)("✓ ")}${bold(fg(tokens.positive)(`~${formatBytes(receipt.freedBytes)}`))} ${fg(
      tokens.textMuted,
    )(`${verb} · ${receipt.removed} removed`)}`,
  ];
  if (receipt.failed > 0) parts.push(t`${fg(tokens.danger)(` · ${receipt.failed} failed`)}`);
  if (receipt.unattempted > 0) {
    parts.push(t`${fg(tokens.warning)(` · ${receipt.unattempted} unattempted`)}`);
  }
  if (receipt.stopped) parts.push(t`${fg(tokens.warning)(" · stopped")}`);
  return concatStyled(...parts);
}

export interface LedgerBandProps {
  tokens: ThemeTokens;
  width: number;
  targetDir: string;
  candidates: readonly ScanCandidate[];
  visible: readonly ScanCandidate[];
  selectedIds: ReadonlySet<string>;
  summary: SweepUiSummary;
  riskFilter: RiskTier | "all";
  scanning: boolean;
  incomplete: boolean;
  sizedCount: number;
  receipt?: LedgerReceipt | null | undefined;
  /** The header's right side: modes, found count and engine. */
  stats: StyledText;
  onMenu: () => void;
  onQueueSafe: () => void;
  onReview: () => void;
  onRiskFilter: (tier: RiskTier | "all") => void;
}

/**
 * The top of the full review view: how much can come back (safe + caution,
 * with guarded separated) and how much is chosen, with C+ single-bold-number
 * hierarchy and Clove blue reserved for queued totals and primary actions.
 */
export function LedgerBand({
  tokens,
  width,
  targetDir,
  candidates,
  visible,
  selectedIds,
  summary,
  riskFilter,
  scanning,
  incomplete,
  sizedCount,
  receipt,
  stats,
  onMenu,
  onQueueSafe,
  onReview,
  onRiskFilter,
}: LedgerBandProps) {
  const ledger = useMemo(() => buildLedger(candidates), [candidates]);
  const safeBytes = useMemo(() => queueSafeBytes(visible, selectedIds), [visible, selectedIds]);
  const queuedBreakdown = useMemo(() => {
    let reclaimableBytes = 0;
    let guardedBytes = 0;
    let reclaimablePartial = false;
    let guardedPartial = false;
    for (const candidate of candidates) {
      if (!selectedIds.has(candidate.id)) continue;
      if (candidate.riskTier === "safe" || candidate.riskTier === "caution") {
        reclaimableBytes += candidate.estimatedBytes;
        if (candidate.bytesKnown === false) reclaimablePartial = true;
      } else {
        guardedBytes += candidate.estimatedBytes;
        if (candidate.bytesKnown === false) guardedPartial = true;
      }
    }
    return { reclaimableBytes, guardedBytes, reclaimablePartial, guardedPartial };
  }, [candidates, selectedIds]);
  const colors = riskColor(tokens);
  const reclaimableTilde = ledger.reclaimablePartial ? "~" : "";
  const guardedTilde = ledger.guardedPartial ? "~" : "";
  const inner = Math.max(1, width - 2);

  const brand = buildBrandLine(tokens, width);
  // The path takes whatever the stats on the right leave, or steps aside.
  const statsWidth = stats.chunks.reduce((sum, chunk) => sum + cellWidth(chunk.text), 0);
  const brandWidth = brand.chunks.reduce((sum, chunk) => sum + cellWidth(chunk.text), 0);
  const targetRoom = inner - brandWidth - statsWidth - 4;
  const target = targetRoom >= 10 ? clipCells(displayTarget(targetDir), targetRoom, true) : "";

  const queued = summary.selectedCount > 0;
  const rightContent = queued
    ? t`${fg(tokens.textMuted)(`${summary.selectedCount.toLocaleString()} queued · `)}${bold(
        fg(tokens.accent)(
          `${summary.selectedBytesPartial ? "~" : ""}${formatBytes(summary.selectedBytes)}`,
        ),
      )}`
    : receipt
      ? buildReceiptLine(receipt, tokens)
      : t`${fg(tokens.textDim)("nothing queued")}`;
  const rightWidth = rightContent.chunks.reduce((sum, chunk) => sum + cellWidth(chunk.text), 0);

  // Budget headline, guarded suffix, and tier legend together against `width`
  // so right-side queue byte sizes never clip at 60/80/100/120/160 columns.
  const headlineBaseText = `${reclaimableTilde}${formatBytes(ledger.reclaimable)} reclaimable`;
  const guardedSuffixText =
    ledger.guarded > 0 ? ` · +${guardedTilde}${spacedBytes(ledger.guarded)} guarded` : "";
  const activeTiers = TIERS.filter((tier) => ledger.counts[tier] > 0);
  const tierLabels = (withWords: boolean) =>
    activeTiers.map(
      (tier) =>
        `${riskGlyph[tier]} ${spacedBytes(ledger.bytes[tier])}${withWords ? ` ${tier}` : ""}`,
    );
  const blockedLabel =
    ledger.counts.blocked > 0 ? `${riskGlyph.blocked} ${ledger.counts.blocked} blocked` : "";
  const legendWidthOf = (withWords: boolean, includeBlocked: boolean): number => {
    const items = tierLabels(withWords);
    if (includeBlocked && blockedLabel) items.push(blockedLabel);
    if (items.length === 0) return 0;
    return items.reduce((sum, text) => sum + cellWidth(text), 0) + (items.length - 1) * 2;
  };

  let showGuarded = false;
  let showLegend = false;
  let legendWords = false;
  let showBlockedLegend = false;
  if (!scanning && !incomplete) {
    const rowBudget = Math.max(0, width - rightWidth - 2);
    const baseW = cellWidth(headlineBaseText);
    const guardW = cellWidth(guardedSuffixText);
    const fullLegendW = legendWidthOf(true, true);
    const wordsLegendW = legendWidthOf(true, false);
    const compactLegendW = legendWidthOf(false, false);

    if (
      activeTiers.length > 0 &&
      baseW + guardW + (fullLegendW > 0 ? 2 + fullLegendW : 0) <= rowBudget
    ) {
      showGuarded = ledger.guarded > 0;
      showLegend = true;
      legendWords = true;
      showBlockedLegend = blockedLabel.length > 0;
    } else if (
      activeTiers.length > 0 &&
      baseW + guardW + (wordsLegendW > 0 ? 2 + wordsLegendW : 0) <= rowBudget
    ) {
      showGuarded = ledger.guarded > 0;
      showLegend = true;
      legendWords = true;
    } else if (
      activeTiers.length > 0 &&
      baseW + guardW + (compactLegendW > 0 ? 2 + compactLegendW : 0) <= rowBudget
    ) {
      showGuarded = ledger.guarded > 0;
      showLegend = true;
    } else if (ledger.guarded > 0 && baseW + guardW <= rowBudget) {
      showGuarded = true;
    } else if (activeTiers.length > 0 && baseW + 2 + compactLegendW <= rowBudget) {
      showLegend = true;
    }
  }

  const reviewLabel = `Review queue (${summary.selectedCount})`;
  const safeLabel = width >= 96 && safeBytes > 0 ? spacedBytes(safeBytes) : undefined;
  const buttons =
    cellWidth(" Actions Ctrl+K ") +
    (width >= 64 ? 1 + cellWidth(` Queue safe ${safeLabel ? `${safeLabel} ` : ""}`) : 0) +
    (width >= 54 ? 1 + cellWidth(` ${reviewLabel} `) : 0);

  // Consistent with D3: ruler measures queued reclaimable (safe + caution)
  // against total reclaimable; any queued guarded (dangerous) bytes are noted
  // explicitly rather than inflating the reclaimable percentage.
  const percent =
    ledger.reclaimable > 0
      ? Math.min(100, Math.round((queuedBreakdown.reclaimableBytes / ledger.reclaimable) * 100))
      : 0;
  const guardedQueuedLabel =
    queuedBreakdown.guardedBytes > 0
      ? `${queuedBreakdown.guardedPartial ? "~" : ""}${spacedBytes(queuedBreakdown.guardedBytes)} guarded`
      : "";
  const ruleLabel = scanning
    ? ""
    : !queued
      ? ""
      : queuedBreakdown.guardedBytes > 0
        ? queuedBreakdown.reclaimableBytes === 0
          ? ` +${guardedQueuedLabel}`
          : queuedBreakdown.reclaimablePartial
            ? ` partial + ${guardedQueuedLabel}`
            : ` ${percent}% + ${guardedQueuedLabel}`
        : queuedBreakdown.reclaimablePartial
          ? " partial bytes"
          : ` ${percent}% of bytes`;
  const ruleWidth = Math.max(0, inner - buttons - 2 - cellWidth(ruleLabel));

  return (
    <box width="100%" flexShrink={0} flexDirection="column" backgroundColor={tokens.surface}>
      <box width="100%" height={1} flexDirection="row" justifyContent="space-between">
        <text
          content={target ? concatStyled(brand, t`  ${fg(tokens.textSecondary)(target)}`) : brand}
          wrapMode="none"
        />
        <text content={stats} wrapMode="none" />
      </box>

      <box width="100%" height={1} flexDirection="row">
        {scanning ? (
          <text
            content={t`${bold(fg(tokens.info)("Scanning"))}  ${fg(tokens.textMuted)(
              `${sizedCount.toLocaleString()} of ${candidates.length.toLocaleString()} sized · ${reclaimableTilde}${formatBytes(ledger.reclaimable)} so far`,
            )}`}
            wrapMode="none"
            flexShrink={1}
          />
        ) : incomplete ? (
          <text
            content={t`${bold(fg(tokens.warning)("Review incomplete"))}  ${fg(tokens.textMuted)(
              "rescan with r before applying",
            )}`}
            wrapMode="none"
            flexShrink={1}
          />
        ) : (
          <text
            content={t`${bold(fg(tokens.text)(`${reclaimableTilde}${formatBytes(ledger.reclaimable)}`))} ${fg(
              tokens.textSecondary,
            )("reclaimable")}${showGuarded ? fg(tokens.textDim)(guardedSuffixText) : ""}`}
            wrapMode="none"
            flexShrink={1}
          />
        )}
        {showLegend ? (
          <box flexDirection="row" gap={2} marginLeft={2} flexShrink={0}>
            {activeTiers.map((tier) => (
              <ActionButton
                key={tier}
                tokens={tokens}
                framed={false}
                active={riskFilter === tier}
                color={colors[tier]}
                label={`${riskGlyph[tier]} ${spacedBytes(ledger.bytes[tier])}${legendWords ? ` ${tier}` : ""}`}
                onPress={() => onRiskFilter(riskFilter === tier ? "all" : tier)}
              />
            ))}
            {showBlockedLegend ? (
              <text content={t`${fg(tokens.blocked)(blockedLabel)}`} wrapMode="none" />
            ) : null}
          </box>
        ) : null}
        <box flexGrow={1} minWidth={2} />
        <text content={rightContent} wrapMode="none" flexShrink={0} />
      </box>

      <box width="100%" height={1} flexDirection="row" gap={1}>
        {scanning ? (
          <box flexGrow={1} height={1}>
            <ScanMeter
              width={ruleWidth}
              fill={tokens.info}
              track={tokens.meterTrack}
              background={tokens.surface}
            />
          </box>
        ) : (
          <text
            content={concatStyled(
              buildQueueRule(
                queuedBreakdown.reclaimableBytes,
                ledger.reclaimable,
                ruleWidth,
                tokens.accent,
                tokens.meterTrack,
              ),
              t`${fg(tokens.accent)(ruleLabel)}`,
            )}
            wrapMode="none"
            flexGrow={1}
          />
        )}
        <ActionButton tokens={tokens} label="Actions" hint="Ctrl+K" onPress={onMenu} />
        {width >= 64 ? (
          <ActionButton
            tokens={tokens}
            label="Queue safe"
            hint={safeLabel}
            disabled={safeBytes <= 0 && visible.every((c) => c.riskTier !== "safe")}
            onPress={onQueueSafe}
          />
        ) : null}
        {width >= 54 ? (
          <ActionButton
            tokens={tokens}
            label={reviewLabel}
            onPress={onReview}
            primary
            disabled={scanning || incomplete || summary.selectedCount === 0}
          />
        ) : null}
      </box>
    </box>
  );
}
