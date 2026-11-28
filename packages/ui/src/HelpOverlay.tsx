import { bold, fg, t } from "@opentui/core";
import { keycap } from "./presentation.js";
import { cellWidth } from "./text-cells.js";
import type { ThemeTokens } from "./theme.js";
import { Modal } from "./widgets.js";

/** A help row: keycap + what it does. Sections break on `keys === null`. */
type HelpRow = readonly [keys: string | null, description: string];

const HELP_MOVE: ReadonlyArray<HelpRow> = [
  [null, "move"],
  ["↑↓ / j k", "cursor · wheel scrolls"],
  ["g / G", "first / last row"],
  ["ctrl-u/d", "page up · down"],
  ["h · l", "fold · open a group or project"],
  ["w · e", "collapse all · expand all"],
];

const HELP_QUEUE: ReadonlyArray<HelpRow> = [
  [null, "queue"],
  ["space", "queue / unqueue row"],
  ["v", "visual range - space queues"],
  ["a · s", "queue all removable · safe only"],
  ["u / U", "clear entire queue / visible only"],
  ["x · d", "remove this item or project (confirms)"],
  ["c · ctrl+enter", "review the queue (confirms)"],
  ["y · t · esc", "in a review: remove · trash · cancel"],
];

const HELP_VIEW: ReadonlyArray<HelpRow> = [
  [null, "view"],
  ["/", "filter list · tab cycles panes"],
  ["1 - 4", "risk filter"],
  ["f", "filter by risk · kind · size · age"],
  ["o", "sort size · name · age"],
  ["enter · i", "open item details"],
  ["ctrl-k / F2", "search actions and settings"],
  ["ctrl-o", "switch folder - fuzzy or a path"],
  ["b", "projects view ↔ full view"],
  ["backspace", "up one folder in the tree"],
  ["y", "copy row path"],
  ["S", "save queue as a plan"],
];

// The calm default screen has fewer keys, and `i` means something else here
// than in the full view, so it gets its own card rather than a filtered copy.
const HELP_PROJECTS: ReadonlyArray<HelpRow> = [
  [null, "projects"],
  ["↑↓ / j k", "move · wheel moves the cursor"],
  ["enter · l", "open a project · enter on an item: details"],
  ["h · esc", "close it"],
  ["space", "queue / unqueue the project or item"],
  ["a", "queue all removable"],
  ["i", "queue safe items in projects idle 30+ days"],
  ["u", "clear the queue"],
  ["x · d", "remove this project or item (confirms)"],
  ["c", "review the queue (confirms)"],
  ["y · t · esc", "in a review: remove · trash · cancel"],
  ["/", "search projects"],
  ["b", "full view: folders, ranges, patterns, copy"],
  ["t · q", "theme · quit"],
];

const HELP_PATTERNS: ReadonlyArray<HelpRow> = [
  [null, "patterns (p)"],
  ["space", "toggle pattern"],
  ["/", "filter the catalog"],
  ["a · d", "add · remove custom"],
  ["w / W", "save patterns (review existing config)"],
  ["r", "rescan with new set"],
];

const HELP_APP: ReadonlyArray<HelpRow> = [
  [null, "app"],
  ["tab", "switch panes"],
  ["t", "theme dark · light · auto"],
  ["m", "pause / resume activity animation"],
  ["E", "swap scan engine js · rust"],
  ["q · ctrl-c", "quit · stop active cleanup"],
];

// Two columns split as move+queue+app | view+patterns so both land near the
// same height; a narrow terminal folds into a single column in reading order.
const HELP_LEFT: ReadonlyArray<HelpRow> = [...HELP_MOVE, ...HELP_QUEUE, ...HELP_APP];
const HELP_RIGHT: ReadonlyArray<HelpRow> = [...HELP_VIEW, ...HELP_PATTERNS];
const HELP_SINGLE: ReadonlyArray<HelpRow> = [
  ...HELP_MOVE,
  ...HELP_QUEUE,
  ...HELP_VIEW,
  ...HELP_PATTERNS,
  ...HELP_APP,
];

const HELP_FILTER_SYNTAX = "kind:x  risk:y  path:z  >100MB  older:30d  is:dir  is:file  !term";

function helpColumn(rows: ReadonlyArray<HelpRow>, keyWidth: number, tokens: ThemeTokens) {
  return (
    <box flexDirection="column" flexShrink={0}>
      {rows.map(([keys, description], index) =>
        keys === null ? (
          <box key={`section-${description}`} flexDirection="column">
            {index > 0 ? <text content="" /> : null}
            <text
              content={t`${bold(fg(tokens.accent)(description.toUpperCase()))}`}
              wrapMode="none"
            />
          </box>
        ) : (
          <text
            // Index, not the keycap: "space" and "/" legitimately appear in
            // two sections, and single-column mode concatenates both columns.
            key={`${keys}-${index}`}
            content={t`${keycap(keys, tokens)}${" ".repeat(Math.max(1, keyWidth - cellWidth(keys)))}${fg(tokens.textSecondary)(description)}`}
            wrapMode="none"
          />
        ),
      )}
    </box>
  );
}

export function ProjectsHelp({ tokens, width }: { tokens: ThemeTokens; width: number }) {
  const keyWidth = Math.max(...HELP_PROJECTS.map(([k]) => (k === null ? 0 : cellWidth(k)))) + 1;
  const bodyWidth = keyWidth + 2 + Math.max(...HELP_PROJECTS.map(([, d]) => cellWidth(d)));
  const modalWidth = Math.min(bodyWidth + 10, Math.max(28, width - 4));
  const bodyLines = HELP_PROJECTS.length;
  return (
    <Modal tokens={tokens} title="Keyboard shortcuts" width={modalWidth} height={bodyLines + 2 + 4}>
      {helpColumn(HELP_PROJECTS, keyWidth, tokens)}
      <text content="" />
      <text
        content={t`${fg(tokens.textDim)("esc unwinds one layer · ctrl-c quits")}`}
        wrapMode="none"
      />
    </Modal>
  );
}

export function HelpOverlay({ tokens, width }: { tokens: ThemeTokens; width: number }) {
  // Keys get the strong color, descriptions recede, section headers are the
  // only accent - the hierarchy reads at a glance instead of one gray wall.
  // Keycaps add a cell of fill on each side; +1 more keeps them off the text.
  const keyWidth =
    Math.max(
      ...HELP_LEFT.map(([k]) => (k === null ? 0 : cellWidth(k))),
      ...HELP_RIGHT.map(([k]) => (k === null ? 0 : cellWidth(k))),
    ) + 1;
  const leftWidth = keyWidth + 2 + Math.max(...HELP_LEFT.map(([, d]) => d.length));
  const rightWidth = keyWidth + 2 + Math.max(...HELP_RIGHT.map(([, d]) => d.length));
  const twoColWidth = leftWidth + rightWidth + 4; // column gap

  // Modal chrome: 2 border + 6 paddingX + 2 scrollbox reserve. Budget for all
  // of it or the widest row clips against the right edge.
  const CHROME = 10;

  // Narrow terminals collapse to one column and drop the syntax sample -
  // better absent than wrapped mid-token.
  const singleWidth = Math.max(leftWidth, rightWidth);
  const twoCol = width >= twoColWidth + CHROME;
  const modalWidth = twoCol
    ? twoColWidth + CHROME
    : Math.min(singleWidth + CHROME, Math.max(28, width - 4));

  // Hug the content: a card taller than its rows reads as unfinished.
  const lines = (rows: ReadonlyArray<HelpRow>) =>
    rows.reduce((n, [keys]) => n + (keys === null ? 2 : 1), 0) - 1; // first section has no gap
  const bodyLines = twoCol ? Math.max(lines(HELP_LEFT), lines(HELP_RIGHT)) : lines(HELP_SINGLE);
  const modalHeight = bodyLines + 3 + 4; // syntax + exit lines, border + padding

  return (
    <Modal tokens={tokens} title="Keyboard shortcuts" width={modalWidth} height={modalHeight}>
      {twoCol ? (
        <box flexDirection="row" gap={4}>
          {helpColumn(HELP_LEFT, keyWidth, tokens)}
          {helpColumn(HELP_RIGHT, keyWidth, tokens)}
        </box>
      ) : (
        helpColumn(HELP_SINGLE, keyWidth, tokens)
      )}
      <text content="" />
      {HELP_FILTER_SYNTAX.length + 8 <= modalWidth - CHROME ? (
        <text
          content={t`${fg(tokens.textDim)("filter")}  ${fg(tokens.textSecondary)(HELP_FILTER_SYNTAX)}`}
          wrapMode="none"
        />
      ) : null}
      <text
        content={t`${fg(tokens.textDim)("esc unwinds one layer · ctrl-c stops cleanup, quits when idle")}`}
        wrapMode="none"
      />
    </Modal>
  );
}
