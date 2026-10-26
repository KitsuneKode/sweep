import { homedir } from "node:os";
import type { RiskTier, ScanCandidate } from "@kitsunekode/sweep-protocol";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { bold, fg, t, type StyledText } from "@opentui/core";
import { useMemo, useRef } from "react";
import { ActionButton } from "./ActionButton.js";
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
  /** Everything a review could remove: blocked items never count. */
  reclaimable: number;
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
  let partial = false;
  for (const candidate of candidates) {
    bytes[candidate.riskTier] += candidate.estimatedBytes;
    counts[candidate.riskTier] += 1;
    if (candidate.bytesKnown === false) partial = true;
  }
  return { bytes, counts, reclaimable: bytes.safe + bytes.caution + bytes.dangerous, partial };
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
 * The top of the screen answers the question a cleaner opens sweep with -
 * how much can I get back, and how much have I chosen - before any row is
 * read. The tier legend doubles as a risk filter for the mouse.
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
  const sized = useMonotonicFraction(
    candidates.length > 0 ? sizedCount / candidates.length : 0,
    scanning,
  );
  const safeBytes = useMemo(() => queueSafeBytes(visible, selectedIds), [visible, selectedIds]);
  const colors = riskColor(tokens);
  const tilde = ledger.partial ? "~" : "";
  const inner = Math.max(1, width - 2);

  const brand = buildBrandLine(tokens, width);
  // The path takes whatever the stats on the right leave, or steps aside.
  const statsWidth = stats.chunks.reduce((sum, chunk) => sum + cellWidth(chunk.text), 0);
  const brandWidth = brand.chunks.reduce((sum, chunk) => sum + cellWidth(chunk.text), 0);
  const targetRoom = inner - brandWidth - statsWidth - 4;
  const target = targetRoom >= 10 ? clipCells(displayTarget(targetDir), targetRoom, true) : "";

  // Legend entries shed their words, then themselves, as the band narrows.
  const legendWords = width >= 110;
  const showLegend = width >= 72 && !scanning && !incomplete;

  const reviewLabel = `Review queue (${summary.selectedCount})`;
  const safeLabel = width >= 96 && safeBytes > 0 ? spacedBytes(safeBytes) : undefined;
  const buttons =
    cellWidth(" Actions Ctrl+K ") +
    (width >= 64 ? 1 + cellWidth(` Queue safe ${safeLabel ? `${safeLabel} ` : ""}`) : 0) +
    (width >= 54 ? 1 + cellWidth(` ${reviewLabel} `) : 0);

  const queued = summary.selectedCount > 0;
  const percent =
    ledger.reclaimable > 0 ? Math.round((summary.selectedBytes / ledger.reclaimable) * 100) : 0;
  const ruleLabel = scanning
    ? ` ${Math.min(99, Math.floor(sized * 100))}% sized`
    : queued
      ? summary.selectedBytesPartial
        ? " partial bytes"
        : ` ${percent}% of bytes`
      : "";
  const ruleWidth = Math.max(0, inner - buttons - 2 - cellWidth(ruleLabel));

  return (
    <box width="100%" flexShrink={0} flexDirection="column">
      <box width="100%" height={1} flexDirection="row" justifyContent="space-between">
        <text
          content={target ? concatStyled(brand, t`  ${fg(tokens.textMuted)(target)}`) : brand}
          wrapMode="none"
        />
        <text content={stats} wrapMode="none" />
      </box>

      <box width="100%" height={1} flexDirection="row" gap={2}>
        {scanning ? (
          <text
            content={t`${bold(fg(tokens.info)("Scanning"))}  ${fg(tokens.textMuted)(
              `${sizedCount.toLocaleString()} of ${candidates.length.toLocaleString()} sized · ${tilde}${formatBytes(ledger.reclaimable)} so far`,
            )}`}
            wrapMode="none"
          />
        ) : incomplete ? (
          <text
            content={t`${bold(fg(tokens.warning)("Review incomplete"))}  ${fg(tokens.textMuted)(
              "rescan with r before applying",
            )}`}
            wrapMode="none"
          />
        ) : (
          <text
            content={t`${bold(fg(tokens.accent)(`${tilde}${formatBytes(ledger.reclaimable)}`))} ${fg(
              tokens.textMuted,
            )("reclaimable")}`}
            wrapMode="none"
          />
        )}
        {showLegend ? (
          <box flexDirection="row" gap={2} flexShrink={1} minWidth={0}>
            {TIERS.filter((tier) => ledger.counts[tier] > 0).map((tier) => (
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
            {ledger.counts.blocked > 0 && legendWords ? (
              <text
                content={t`${fg(tokens.textDim)(`${riskGlyph.blocked} ${ledger.counts.blocked} blocked`)}`}
                wrapMode="none"
              />
            ) : null}
          </box>
        ) : null}
        <box flexGrow={1} />
        <text
          content={
            queued
              ? t`${fg(tokens.textMuted)(`${summary.selectedCount.toLocaleString()} queued · `)}${bold(
                  fg(tokens.accent)(
                    `${summary.selectedBytesPartial ? "~" : ""}${formatBytes(summary.selectedBytes)}`,
                  ),
                )}`
              : receipt
                ? buildReceiptLine(receipt, tokens)
                : t`${fg(tokens.textDim)("nothing queued")}`
          }
          wrapMode="none"
        />
      </box>

      <box width="100%" height={1} flexDirection="row" gap={1}>
        <text
          content={concatStyled(
            buildQueueRule(
              scanning ? sized : summary.selectedBytes,
              scanning ? 1 : ledger.reclaimable,
              ruleWidth,
              scanning ? tokens.info : tokens.accent,
              tokens.border,
            ),
            t`${fg(scanning ? tokens.info : tokens.accent)(ruleLabel)}`,
          )}
          wrapMode="none"
          flexGrow={1}
        />
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

/**
 * A progress meter must never run backwards. `sized / found` can: discovery
 * keeps adding to `found` while sizing catches up, so the bar reached 100%
 * and fell back to 80%. Within one scan the shown fraction holds its high
 * point until the real one passes it; a new scan starts from zero. The exact
 * "N of M sized" text beside it stays literal.
 */
export function useMonotonicFraction(fraction: number, active: boolean): number {
  const high = useRef(0);
  const wasActive = useRef(active);
  // A scan that starts again starts from zero.
  if (active && !wasActive.current) high.current = 0;
  wasActive.current = active;
  high.current = holdFraction(high.current, fraction, active);
  return active ? high.current : clampFraction(fraction);
}

const clampFraction = (value: number) => Math.max(0, Math.min(1, value));

/** The next shown fraction: the real one, but never below the high point while active. */
export function holdFraction(high: number, fraction: number, active: boolean): number {
  return active ? Math.max(high, clampFraction(fraction)) : clampFraction(fraction);
}
