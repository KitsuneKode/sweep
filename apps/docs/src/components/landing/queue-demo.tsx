import { useEffect, useMemo, useRef, useState } from "react";
import { RadioGroup, RadioItem } from "@/components/ui/radio-group";
import { DEMO_ROOT, DEMO_ROWS, formatBytes, type DemoRow, type Phase } from "./content";

type Mode = "delete" | "trash";

const TOTAL = DEMO_ROWS.reduce((sum, row) => sum + row.bytes, 0);
const SCAN_MS = DEMO_ROWS.length * 90 + 500;
const IDLE = "Nothing is queued. Tick rows, or press s to queue the safe ones.";

/**
 * A sample review with the TUI's rules: the queue starts empty, bulk queues
 * only safe rows, blocked rows never toggle, every apply passes review.
 * Without script the rows still render; only the meter stays still.
 */
export function QueueDemo({ onPhaseChange }: { onPhaseChange?: (phase: Phase) => void }) {
  const [queued, setQueued] = useState<ReadonlySet<string>>(new Set());
  const [phase, setPhase] = useState<Phase>("scan");
  const [mode, setMode] = useState<Mode>("delete");
  const [notice, setNotice] = useState(IDLE);
  const [focused, setFocused] = useState<string>(DEMO_ROWS[0]!.id);
  const [refusals, setRefusals] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const queuedRows = useMemo(() => DEMO_ROWS.filter((row) => queued.has(row.id)), [queued]);
  const queuedBytes = queuedRows.reduce((sum, row) => sum + row.bytes, 0);

  useEffect(() => onPhaseChange?.(phase), [phase, onPhaseChange]);

  // Rows stream in with CSS; the scan "completes" when the last one lands.
  useEffect(() => {
    const quick = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(
      () => setPhase((p) => (p === "scan" ? "choose" : p)),
      quick ? 0 : SCAN_MS,
    );
    return () => clearTimeout(timer);
  }, []);

  function toggle(row: DemoRow) {
    if (row.tier === "blocked") {
      setRefusals((n) => n + 1);
      setNotice(`${row.path} did not toggle. ${row.reason}`);
      return;
    }
    const next = new Set(queued);
    if (next.has(row.id)) next.delete(row.id);
    else next.add(row.id);
    setQueued(next);
    setNotice(
      next.has(row.id)
        ? `Queued ${row.path}.${row.tier === "safe" ? "" : ` ${row.reason}`}`
        : `Removed ${row.path} from the queue.`,
    );
  }

  function queueSafe() {
    const next = new Set(queued);
    for (const row of DEMO_ROWS) if (row.tier === "safe") next.add(row.id);
    setQueued(next);
    setNotice("Queued every safe row. Caution, dangerous and blocked rows were left alone.");
  }

  function clear() {
    setQueued(new Set());
    setNotice("The queue is empty again.");
  }

  function review() {
    if (queued.size) setPhase("review");
    else setNotice("Review needs at least one queued artifact.");
  }

  function back() {
    if (phase === "review") setPhase("choose");
    else if (phase === "receipt") {
      setQueued(new Set());
      setPhase("choose");
      setNotice(IDLE);
    }
  }

  // The TUI's own keys work while focus is inside the demo.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || (event.target as HTMLElement).matches("input[type=text], textarea"))
        return;
      if (event.key === "Escape" && phase !== "choose" && phase !== "scan") {
        event.preventDefault();
        back();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && phase === "choose") {
        event.preventDefault();
        review();
      } else if (phase === "choose" && !event.ctrlKey && !event.metaKey) {
        if (event.key === "s") queueSafe();
        else if (event.key === "u") clear();
        else if (event.key === "c") review();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, [phase]);

  const mode_label = { scan: "SCANNING", choose: "NORMAL", review: "REVIEW", receipt: "DONE" }[
    phase
  ];

  return (
    <div className="qd" data-ui ref={rootRef} data-phase={phase}>
      <div className="qd-bar">
        <span className="qd-mode">{mode_label}</span>
        <span className="qd-root">sweep ui {DEMO_ROOT}</span>
        <span className="qd-count">{DEMO_ROWS.length} found</span>
      </div>

      <div className="qd-meter" aria-hidden="true">
        <span className="qd-meter-fill" style={{ transform: `scaleX(${queuedBytes / TOTAL})` }} />
      </div>
      <p className="qd-meter-label">
        <strong>{formatBytes(queuedBytes)}</strong> queued of {formatBytes(TOTAL)} found
      </p>

      {(phase === "scan" || phase === "choose") && (
        <>
          <ul className="qd-rows" aria-label="Artifacts found in the sample tree">
            {DEMO_ROWS.map((row, index) => (
              <li
                key={row.id}
                className="qd-row"
                data-tier={row.tier}
                data-focused={focused === row.id || undefined}
                style={{ "--i": index } as React.CSSProperties}
              >
                <label onFocus={() => setFocused(row.id)} onMouseEnter={() => setFocused(row.id)}>
                  <input
                    type="checkbox"
                    checked={queued.has(row.id)}
                    aria-disabled={row.tier === "blocked" || undefined}
                    aria-describedby={`qd-why-${row.id}`}
                    onChange={() => toggle(row)}
                  />
                  <span
                    className="qd-box"
                    aria-hidden="true"
                    key={row.tier === "blocked" ? `refused-${refusals}` : undefined}
                    data-refused={row.tier === "blocked" && refusals > 0 ? "" : undefined}
                  />
                  <span className="qd-path">{row.path}</span>
                  <span className="qd-size">{formatBytes(row.bytes)}</span>
                  <span className="qd-tier">{row.tier}</span>
                </label>
                <span id={`qd-why-${row.id}`} className="qd-sr">
                  {row.reason}
                </span>
              </li>
            ))}
          </ul>
          <p className="qd-detail" aria-hidden="true" key={focused}>
            <span>why</span> {DEMO_ROWS.find((row) => row.id === focused)?.reason}
          </p>
          <div className="qd-actions">
            <button type="button" className="qd-btn" onClick={queueSafe}>
              Queue safe <kbd>s</kbd>
            </button>
            <button type="button" className="qd-btn" onClick={clear} disabled={!queued.size}>
              Clear <kbd>u</kbd>
            </button>
            <button
              type="button"
              className="qd-btn qd-btn-primary"
              disabled={!queued.size}
              onClick={review}
            >
              Review queue <kbd>c</kbd>
            </button>
          </div>
        </>
      )}

      {phase === "review" && (
        <div className="qd-review" role="group" aria-label="Review the queue">
          <p className="qd-title">
            Remove {queuedRows.length} {queuedRows.length === 1 ? "artifact" : "artifacts"}?
          </p>
          <ul className="qd-review-list">
            {queuedRows.map((row) => (
              <li key={row.id} data-tier={row.tier}>
                <span>
                  {DEMO_ROOT}/{row.path}
                </span>
                <span>{formatBytes(row.bytes)}</span>
              </li>
            ))}
          </ul>
          <div className="qd-modes">
            <p id="qd-mode-label">Deletion mode</p>
            <RadioGroup
              aria-labelledby="qd-mode-label"
              value={mode}
              onValueChange={(value) => setMode(value as Mode)}
            >
              <RadioItem index={0} value="delete" label="Delete permanently" />
              <RadioItem
                index={1}
                value="trash"
                label="Move to local trash (keeps the disk space)"
              />
            </RadioGroup>
          </div>
          <div className="qd-actions">
            <button type="button" className="qd-btn" onClick={back}>
              Back <kbd>Esc</kbd>
            </button>
            <button
              type="button"
              className="qd-btn qd-btn-primary"
              data-autofocus
              onClick={() => setPhase("receipt")}
            >
              Confirm
            </button>
          </div>
        </div>
      )}

      {phase === "receipt" && (
        <div className="qd-receipt" role="status">
          <p className="qd-title">Cleanup receipt</p>
          <dl>
            <div style={{ "--i": 0 } as React.CSSProperties}>
              <dt>Completed</dt>
              <dd>{queuedRows.length}</dd>
            </div>
            <div style={{ "--i": 1 } as React.CSSProperties}>
              <dt>Failed</dt>
              <dd>0</dd>
            </div>
            <div style={{ "--i": 2 } as React.CSSProperties}>
              <dt>Unattempted</dt>
              <dd>0</dd>
            </div>
            <div style={{ "--i": 3 } as React.CSSProperties}>
              <dt>{mode === "delete" ? "Freed" : "Moved, still on disk"}</dt>
              <dd>{formatBytes(queuedBytes)}</dd>
            </div>
          </dl>
          {mode === "trash" && (
            <p className="qd-note">
              In {DEMO_ROOT}/.sweep-trash-1761400000/. Move items back by hand.
            </p>
          )}
          <div className="qd-actions">
            <button type="button" className="qd-btn" data-autofocus onClick={back}>
              Start over <kbd>Esc</kbd>
            </button>
          </div>
        </div>
      )}

      <p className="qd-status" aria-live="polite">
        {phase === "scan"
          ? "Scanning. No file changes."
          : phase === "choose"
            ? notice
            : phase === "review"
              ? "Review names every queued path. Nothing has been removed yet."
              : "A sample run: nothing on your machine was touched."}
      </p>
    </div>
  );
}
