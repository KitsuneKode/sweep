import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requirePublicationCi } from "./release-ci.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
// npm publish in apps/cli must use the same source/CI gate as the orchestrator.
await requirePublicationCi(root);
execFileSync("bun", ["run", "prepublishOnly"], { cwd: root, stdio: "inherit" });
