import { buildCliBundle, buildUiBundle } from "../../../scripts/bundle.ts";

await buildUiBundle();
await buildCliBundle();
