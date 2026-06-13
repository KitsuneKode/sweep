import {
  BoxRenderable,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
} from "@opentui/core";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import {
  buildContextLine,
  buildFooterLine,
  buildHeaderLine,
  formatArtifactRow,
  formatGroupHeaderRow,
} from "./presentation.js";
import { buildDisplayRows } from "./rows.js";
import {
  applyUiSelection,
  clearSelection,
  createUiState,
  getUiSummary,
  moveCursor,
  selectVisible,
  setFilter,
  setRowIndex,
  toggleCurrentSelection,
} from "./state.js";
import { theme } from "./theme.js";

export interface SweepUiOptions {
  yes?: boolean;
  dryRun?: boolean;
}

const HEADER_ROW_VALUE = "__sweep_header__";

export async function runSweepUi(
  plan: ScanPlan,
  options: SweepUiOptions = {},
): Promise<ScanPlan | null> {
  if (options.yes) {
    return plan;
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    useMouse: false,
    targetFps: 30,
  });

  let state = createUiState(plan);
  let resolved = false;

  return await new Promise<ScanPlan | null>((resolvePromise) => {
    const root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
      gap: 1,
      backgroundColor: theme.bg,
    });

    const header = new TextRenderable(renderer, {
      content: buildHeaderLine(plan, getUiSummary(state), options.dryRun),
    });

    const search = new InputRenderable(renderer, {
      width: "100%",
      value: "",
      placeholder: "filter artifacts…",
      textColor: theme.text,
      backgroundColor: theme.surfaceInset,
      focusedTextColor: theme.selectionText,
      focusedBackgroundColor: theme.surfaceInset,
      placeholderColor: theme.textDim,
    });
    search.focusable = true;

    const listFrame = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      border: true,
      borderColor: theme.borderSoft,
      focusedBorderColor: theme.borderFocus,
      backgroundColor: theme.surface,
      paddingX: 1,
      paddingY: 0,
    });

    const list = new SelectRenderable(renderer, {
      width: "100%",
      height: "100%",
      showDescription: false,
      wrapSelection: false,
      itemSpacing: 0,
      textColor: theme.text,
      focusedTextColor: theme.selectionText,
      selectedTextColor: theme.selectionText,
      selectedBackgroundColor: theme.selectionBg,
      options: [],
    });
    list.focusable = true;

    const context = new TextRenderable(renderer, {
      content: buildContextLine(state),
    });

    const footer = new TextRenderable(renderer, {
      content: buildFooterLine(options.dryRun),
    });

    root.add(header);
    listFrame.add(list);
    root.add(search);
    root.add(listFrame);
    root.add(context);
    root.add(footer);
    renderer.root.add(root);

    const refresh = () => {
      const rows = buildDisplayRows(state);
      const byId = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));

      list.options = rows.map((row) => {
        if (row.kind === "header") {
          return {
            name: formatGroupHeaderRow(row),
            description: "",
            value: `${HEADER_ROW_VALUE}:${row.groupKey}`,
          };
        }

        const candidate = byId.get(row.candidateId);
        if (!candidate) {
          return { name: "", description: "", value: row.candidateId };
        }

        return {
          name: formatArtifactRow(candidate, state.selectedIds.has(candidate.id)),
          description: "",
          value: row.candidateId,
        };
      });

      list.selectedIndex = state.rowIndex;
      header.content = buildHeaderLine(plan, getUiSummary(state), options.dryRun);
      context.content = buildContextLine(state);
      renderer.requestRender();
    };

    const finalize = (nextPlan: ScanPlan | null) => {
      if (resolved) return;
      resolved = true;
      renderer.destroy();
      resolvePromise(nextPlan);
    };

    search.on(InputRenderableEvents.INPUT, () => {
      state = setFilter(state, search.value);
      refresh();
    });

    list.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
      state = setRowIndex(state, list.getSelectedIndex());
      refresh();
    });

    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const rows = buildDisplayRows(state);
      const row = rows[state.rowIndex];
      if (row?.kind === "header") return;
      finalize(applyUiSelection(plan, state));
    });

    renderer.keyInput.on("keypress", (event) => {
      if (event.name === "escape" || event.name === "q") {
        event.preventDefault();
        finalize(null);
        return;
      }

      if (event.name === "tab") {
        event.preventDefault();
        if (search.focused) {
          list.focus();
        } else {
          search.focus();
        }
        return;
      }

      if (search.focused) {
        return;
      }

      if (event.name === "space") {
        event.preventDefault();
        state = toggleCurrentSelection(state);
        refresh();
        return;
      }

      if (event.name === "s") {
        event.preventDefault();
        state = selectVisible(state, false);
        refresh();
        return;
      }

      if (event.name === "a") {
        event.preventDefault();
        state = selectVisible(state, true);
        refresh();
        return;
      }

      if (event.name === "u") {
        event.preventDefault();
        state = clearSelection(state);
        refresh();
        return;
      }

      if (event.name === "up" || event.name === "k") {
        event.preventDefault();
        state = moveCursor(state, -1);
        refresh();
        return;
      }

      if (event.name === "down" || event.name === "j") {
        event.preventDefault();
        state = moveCursor(state, 1);
        refresh();
      }
    });

    search.focus();
    refresh();
  });
}
