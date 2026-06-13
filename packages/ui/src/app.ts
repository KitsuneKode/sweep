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
  buildDetailLine,
  buildFooterLine,
  buildStatsLine,
  buildTargetLine,
  buildTitleLine,
  formatListOptionDescription,
  formatListOptionName,
} from "./presentation.js";
import {
  applyUiSelection,
  clearSelection,
  createUiState,
  getUiSummary,
  getVisibleCandidates,
  moveCursor,
  selectVisible,
  setFilter,
  toggleCurrentSelection,
} from "./state.js";
import { theme } from "./theme.js";

export interface SweepUiOptions {
  yes?: boolean;
  dryRun?: boolean;
}

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

    const headerBlock = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "column",
      gap: 0,
      backgroundColor: theme.surface,
      border: true,
      borderColor: theme.borderMuted,
      paddingX: 1,
      paddingY: 0,
    });

    const title = new TextRenderable(renderer, {
      content: buildTitleLine(options.dryRun),
    });

    const stats = new TextRenderable(renderer, {
      content: buildStatsLine(getUiSummary(state), state),
    });

    const target = new TextRenderable(renderer, {
      content: buildTargetLine(plan),
    });

    headerBlock.add(title);
    headerBlock.add(stats);
    headerBlock.add(target);

    const searchFrame = new BoxRenderable(renderer, {
      width: "100%",
      border: true,
      borderColor: theme.border,
      focusedBorderColor: theme.borderFocus,
      backgroundColor: theme.surfaceInset,
      title: "Filter",
      titleAlignment: "left",
      paddingX: 1,
      paddingY: 0,
      height: 3,
    });

    const search = new InputRenderable(renderer, {
      width: "100%",
      value: "",
      placeholder: "name, path, kind, or risk…",
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
      borderColor: theme.border,
      focusedBorderColor: theme.borderFocus,
      backgroundColor: theme.surface,
      title: "Artifacts",
      titleAlignment: "left",
      paddingX: 1,
      paddingY: 0,
    });

    const list = new SelectRenderable(renderer, {
      width: "100%",
      height: "100%",
      showDescription: true,
      wrapSelection: false,
      itemSpacing: 1,
      textColor: theme.text,
      focusedTextColor: theme.selectionText,
      selectedTextColor: theme.selectionText,
      selectedBackgroundColor: theme.selectionBg,
      descriptionColor: theme.textMuted,
      selectedDescriptionColor: theme.info,
      options: [],
    });
    list.focusable = true;

    const detailFrame = new BoxRenderable(renderer, {
      width: "100%",
      border: true,
      borderColor: theme.borderMuted,
      backgroundColor: theme.surfaceInset,
      title: "Selection",
      titleAlignment: "left",
      paddingX: 1,
      paddingY: 0,
      height: 3,
    });

    const detail = new TextRenderable(renderer, {
      content: buildDetailLine(state),
    });

    detailFrame.add(detail);

    const footer = new TextRenderable(renderer, {
      content: buildFooterLine(options.dryRun),
    });

    root.add(headerBlock);
    searchFrame.add(search);
    listFrame.add(list);
    root.add(searchFrame);
    root.add(listFrame);
    root.add(detailFrame);
    root.add(footer);
    renderer.root.add(root);

    const refresh = () => {
      list.options = getVisibleCandidates(state).map((candidate) => ({
        name: formatListOptionName(candidate, state.selectedIds.has(candidate.id)),
        description: formatListOptionDescription(candidate),
        value: candidate.id,
      }));

      list.selectedIndex = state.cursorIndex;

      const summary = getUiSummary(state);
      stats.content = buildStatsLine(summary, state);
      detail.content = buildDetailLine(state);
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
      state = {
        ...state,
        cursorIndex: list.getSelectedIndex(),
      };
      refresh();
    });

    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
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
