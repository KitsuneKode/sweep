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

export async function runSweepUi(plan: ScanPlan): Promise<ScanPlan | null> {
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
      backgroundColor: "#101214",
    });

    const header = new TextRenderable(renderer, {
      content: "sweep ui",
      fg: "#8bd5ff",
    });

    const searchFrame = new BoxRenderable(renderer, {
      width: "100%",
      border: true,
      borderColor: "#3b4252",
      focusedBorderColor: "#8bd5ff",
      paddingX: 1,
      paddingY: 0,
      height: 3,
    });

    const search = new InputRenderable(renderer, {
      width: "100%",
      value: "",
      placeholder: "Filter by name, path, kind, or risk",
      textColor: "#e5e9f0",
      backgroundColor: "#101214",
      focusedTextColor: "#ffffff",
      focusedBackgroundColor: "#101214",
    });
    search.focusable = true;

    const listFrame = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      border: true,
      borderColor: "#3b4252",
      focusedBorderColor: "#8bd5ff",
      paddingX: 1,
      paddingY: 0,
    });

    const list = new SelectRenderable(renderer, {
      width: "100%",
      height: "100%",
      showDescription: true,
      wrapSelection: false,
      textColor: "#d8dee9",
      focusedTextColor: "#ffffff",
      selectedTextColor: "#ffffff",
      selectedBackgroundColor: "#1f2937",
      options: [],
    });
    list.focusable = true;

    const footer = new TextRenderable(renderer, {
      content: "",
      fg: "#9aa3b2",
    });

    root.add(header);
    searchFrame.add(search);
    listFrame.add(list);
    root.add(searchFrame);
    root.add(listFrame);
    root.add(footer);
    renderer.root.add(root);

    const refresh = () => {
      list.options = getVisibleCandidates(state).map((candidate) => ({
        name: `${state.selectedIds.has(candidate.id) ? "[x]" : "[ ]"} ${candidate.name}`,
        description: `${candidate.riskTier}  ${candidate.path}`,
        value: candidate.id,
      }));

      list.selectedIndex = state.cursorIndex;

      const summary = getUiSummary(state);
      header.content = `sweep ui  visible:${summary.visibleCount}  selected:${summary.selectedCount}  bytes:${formatBytes(summary.selectedBytes)}`;
      footer.content =
        "Tab switch focus  Space toggle  s select-safe  a select-all  u clear  Enter apply  Esc quit";
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

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
