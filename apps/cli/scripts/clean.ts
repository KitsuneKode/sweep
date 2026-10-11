import { rmSync } from "node:fs";

// Resolve from the script, regardless of the invoking shell or working directory.
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
