import { formatBytes } from "@kitsunekode/sweep-display";
import { IDLE_WINDOW_DAYS, type ScanCandidate } from "@kitsunekode/sweep-protocol";
import { useMemo, useRef, useState } from "react";
import { reclaimByCost } from "./project-details.js";
import {
  buildProjectRows,
  buildProjects,
  moveCursor as moveProjectCursor,
  settleCursor,
  type Project,
  type ProjectSection,
} from "./projects.js";
import {
  selectIdleSafe,
  toggleIdsSelection,
  toggleSelectionById,
  type SweepUiState,
} from "./state.js";
import type { NoticeTone } from "./theme.js";

export interface UseProjectsControllerOptions {
  initialView: "projects" | "folders";
  visibleItems: readonly ScanCandidate[];
  selectedIds: ReadonlySet<string>;
  targetDir: string;
  scanning: boolean;
  viewportHeight: number;
  idleSafeCount: number;
  idleSafeBytes: number;
  mutate: (fn: (s: SweepUiState) => SweepUiState) => void;
  setNotice: (text: string | null, tone?: NoticeTone) => void;
  setInspect: (open: boolean, candidateId?: string) => void;
  requestSingleApply: (inspectedId?: string) => void;
  requestProjectApply: (project: Project) => void;
}

export function useProjectsController({
  initialView,
  visibleItems,
  selectedIds,
  targetDir,
  scanning,
  viewportHeight,
  idleSafeCount,
  idleSafeBytes,
  mutate,
  setNotice,
  setInspect,
  requestSingleApply,
  requestProjectApply,
}: UseProjectsControllerOptions) {
  const [view, setView] = useState(initialView);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(() => new Set());
  const [openSections, setOpenSections] = useState<ReadonlySet<ProjectSection>>(() => new Set());
  const [allArtifacts, setAllArtifacts] = useState<ReadonlySet<string>>(() => new Set());
  const [projectCursorState, setProjectCursorState] = useState(0);

  const projects = useMemo(
    () => buildProjects(visibleItems, selectedIds, targetDir),
    [visibleItems, selectedIds, targetDir],
  );
  const byCost = useMemo(() => reclaimByCost(projects, selectedIds), [projects, selectedIds]);
  const projectRows = useMemo(
    () => buildProjectRows(projects, expandedProjects, openSections, allArtifacts),
    [projects, expandedProjects, openSections, allArtifacts],
  );
  const projectCursor = settleCursor(projectRows, projectCursorState);

  // Keys in one stdin burst (j j Enter) must each see the previous key's
  // effect: the handler reads these refs, not this render's values.
  const projectRowsRef = useRef(projectRows);
  projectRowsRef.current = projectRows;
  const projectCursorRef = useRef(projectCursor);
  projectCursorRef.current = projectCursor;
  const expandedRef = useRef(expandedProjects);
  expandedRef.current = expandedProjects;

  const setProjectCursor = (index: number) => {
    projectCursorRef.current = index;
    setProjectCursorState(index);
  };

  /**
   * Keys the projects view owns. Everything else (search, help, actions,
   * review, quit) falls through to the shared keymap. Keys that act on the
   * folder view's hidden cursor (x, d, y, v, p) are answered, not passed on.
   */
  const handleProjectKey = (key: {
    name: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
  }) => {
    if (key.ctrl || key.meta) {
      if (key.name === "d" || key.name === "u") {
        const page = Math.max(1, viewportHeight - 10) * (key.name === "d" ? 1 : -1);
        setProjectCursor(moveProjectCursor(projectRowsRef.current, projectCursorRef.current, page));
        return true;
      }
      return false;
    }
    const rows = projectRowsRef.current;
    const row = rows[projectCursorRef.current];
    const move = (delta: number) => {
      setProjectCursor(moveProjectCursor(projectRowsRef.current, projectCursorRef.current, delta));
      return true;
    };
    const openSection = (section: ProjectSection) => {
      const next = new Set(openSections);
      next.add(section);
      projectRowsRef.current = buildProjectRows(projects, expandedRef.current, next, allArtifacts);
      setOpenSections(next);
      return true;
    };
    const showAllArtifacts = (projectKey: string) => {
      const next = new Set(allArtifacts);
      next.add(projectKey);
      projectRowsRef.current = buildProjectRows(projects, expandedRef.current, openSections, next);
      setAllArtifacts(next);
      return true;
    };
    const setOpen = (keyName: string, open: boolean) => {
      const next = new Set(expandedRef.current);
      if (open) next.add(keyName);
      else next.delete(keyName);
      expandedRef.current = next;
      // Rows change shape now, so the next key in this burst sees them.
      projectRowsRef.current = buildProjectRows(projects, next, openSections, allArtifacts);
      setExpandedProjects(next);
    };
    switch (key.name) {
      case "escape": {
        // The innermost layer first: an opened project, then an opened
        // section. Only then does esc reach the filters and the quit hint.
        if (expandedRef.current.size > 0 || openSections.size > 0 || allArtifacts.size > 0) {
          const cursorKey = row && "project" in row ? row.project.key : null;
          const closeOne = cursorKey !== null && expandedRef.current.has(cursorKey);
          const nextExpanded = closeOne
            ? new Set([...expandedRef.current].filter((k) => k !== cursorKey))
            : new Set<string>();
          const closeAll = !closeOne && expandedRef.current.size > 0;
          const clearSections = !closeOne && !closeAll;
          const nextSections = clearSections ? new Set<ProjectSection>() : openSections;
          const nextArtifacts =
            closeOne || closeAll
              ? new Set([...allArtifacts].filter((k) => nextExpanded.has(k)))
              : allArtifacts;
          const nextRows = buildProjectRows(projects, nextExpanded, nextSections, nextArtifacts);
          expandedRef.current = nextExpanded;
          projectRowsRef.current = nextRows;
          setExpandedProjects(nextExpanded);
          setOpenSections(nextSections);
          setAllArtifacts(nextArtifacts);
          // Land on the project that was just closed, not on whatever moved up.
          const parent =
            cursorKey === null
              ? -1
              : nextRows.findIndex((r) => r.kind === "project" && r.project.key === cursorKey);
          if (parent >= 0) setProjectCursor(parent);
          return true;
        }
        return false;
      }
      case "up":
      case "k":
        return move(-1);
      case "down":
      case "j":
        return move(1);
      case "pageup":
        return move(-Math.max(1, viewportHeight - 10));
      case "pagedown":
        return move(Math.max(1, viewportHeight - 10));
      case "home":
        return move(-Number.MAX_SAFE_INTEGER);
      case "end":
        return move(Number.MAX_SAFE_INTEGER);
      case "g":
        return move(key.shift ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER);
      case "G":
        return move(Number.MAX_SAFE_INTEGER);
      case "space":
        if (row?.kind === "more") return openSection(row.section);
        if (row?.kind === "moreArtifacts") return showAllArtifacts(row.project.key);
        if (row?.kind === "project") mutate((s) => toggleIdsSelection(s, row.project.queueable));
        else if (row?.kind === "artifact") {
          if (row.candidate.riskTier === "blocked")
            setNotice("blocked: git-tracked or a project file, never removable");
          else mutate((s) => toggleSelectionById(s, row.candidate.id));
        }
        return true;
      case "return":
      case "enter":
      case "right":
      case "l":
        if (row?.kind === "more") return openSection(row.section);
        if (row?.kind === "moreArtifacts") return showAllArtifacts(row.project.key);
        if (row?.kind === "project")
          setOpen(
            row.project.key,
            !(key.name === "return" || key.name === "enter") ||
              !expandedProjects.has(row.project.key),
          );
        else if (row?.kind === "artifact" && (key.name === "return" || key.name === "enter"))
          setInspect(true, row.candidate.id);
        return true;
      case "left":
      case "h":
        if (row?.kind === "artifact" || row?.kind === "moreArtifacts") {
          const parent = rows.findIndex(
            (candidate) =>
              candidate.kind === "project" && candidate.project.key === row.project.key,
          );
          setOpen(row.project.key, false);
          if (parent >= 0) setProjectCursor(parent);
        } else if (row?.kind === "project") setOpen(row.project.key, false);
        return true;
      case "i":
        if (scanning) {
          setNotice("idle times arrive when the scan finishes");
          return true;
        }
        if (idleSafeCount === 0) {
          setNotice(`no safe items in projects idle ${IDLE_WINDOW_DAYS}+ days`);
          return true;
        }
        mutate(selectIdleSafe);
        setNotice(
          `queued ${idleSafeCount.toLocaleString()} items in idle projects · ${formatBytes(idleSafeBytes)}`,
          "success",
        );
        return true;
      case "x":
      case "d":
        // Remove without queueing: the row's own confirm, nothing else in it.
        if (row?.kind === "artifact") requestSingleApply(row.candidate.id);
        else if (row?.kind === "project") requestProjectApply(row.project);
        return true;
      case "y":
      case "v":
      case "p":
        setNotice("press b for the full view: copy, ranges and patterns live there");
        return true;
      default:
        return false;
    }
  };

  const handleProjectCursorDelta = (delta: number) => {
    setProjectCursor(moveProjectCursor(projectRowsRef.current, projectCursorRef.current, delta));
  };

  const handleProjectRowPress = (index: number, onMark: boolean) => {
    const row = projectRows[index];
    setProjectCursor(index);
    if (!row || row.kind === "section" || row.kind === "spacer") return;
    if (row.kind === "more") {
      setOpenSections((current) => new Set([...current, row.section]));
      return;
    }
    if (row.kind === "moreArtifacts") {
      setAllArtifacts((current) => new Set([...current, row.project.key]));
      return;
    }
    if (onMark) {
      if (row.kind === "project") mutate((s) => toggleIdsSelection(s, row.project.queueable));
      else mutate((s) => toggleSelectionById(s, row.candidate.id));
    } else if (row.kind === "project") {
      setExpandedProjects((current) => {
        const next = new Set(current);
        if (next.has(row.project.key)) next.delete(row.project.key);
        else next.add(row.project.key);
        return next;
      });
    }
  };

  return {
    view,
    viewRef,
    setView,
    projects,
    byCost,
    projectRows,
    projectCursor,
    handleProjectKey,
    handleProjectCursorDelta,
    handleProjectRowPress,
  };
}
