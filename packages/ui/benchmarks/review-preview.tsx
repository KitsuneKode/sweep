#!/usr/bin/env bun
/** Dev-only plan-boundary stress preview. It never imports an apply engine. */
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useMemo, useState } from "react";
import { SweepApp } from "../src/app.js";
import {
  REVIEW_FIXTURES,
  reviewFixture,
  type ReviewFixture,
} from "../src/testing/review-fixtures.js";
import { releaseUiCaches } from "../src/state/store.js";

const renderer = await createCliRenderer({
  screenMode: "alternate-screen",
  exitOnCtrlC: false,
  useMouse: true,
});
const root = createRoot(renderer);
const closed = new Promise<void>((resolve) => renderer.once("destroy", resolve));
function Preview() {
  const { width } = useTerminalDimensions();
  const [mode, setMode] = useState<ReviewFixture>("Demo");
  const [generation, setGeneration] = useState(0);
  const [message, setMessage] = useState("Preview only · no filesystem actions");
  const plan = useMemo(() => reviewFixture(mode), [mode]);
  useKeyboard((key) => {
    const index = ["f1", "f2", "f3", "f4", "f5"].indexOf(key.name);
    if (index !== -1) {
      setMode(REVIEW_FIXTURES[index]!);
      setMessage("Preview only · no filesystem actions");
    }
  });
  return (
    <box height="100%" flexDirection="column">
      <box flexGrow={1} minHeight={0}>
        <SweepApp
          key={`${mode}-${generation}`}
          plan={plan}
          dryRun
          onDone={(outcome) => {
            if (outcome.type === "abort" || outcome.type === "done") renderer.destroy();
            else {
              setMessage("Preview complete · no files changed · F1–F5 switch data");
              setGeneration((value) => value + 1);
            }
          }}
        />
      </box>
      <box height={1} flexShrink={0} flexDirection="row">
        {width < 72 ? (
          <text content={`F1–F5 data: ${mode}`} />
        ) : (
          REVIEW_FIXTURES.map((fixture, index) => (
            <text
              key={fixture}
              content={`${index + 1 === 1 ? "" : " · "}F${index + 1} ${fixture === mode ? `[${fixture}]` : fixture}`}
              onMouseDown={() => setMode(fixture)}
            />
          ))
        )}
      </box>
      <text content={message} height={1} flexShrink={0} />
    </box>
  );
}
try {
  root.render(<Preview />);
  await closed;
} finally {
  root.unmount();
  renderer.destroy();
  releaseUiCaches();
}
