import { buildCliBundle, buildLibBundle, buildUiBundle } from "../../../scripts/bundle.ts";

await buildUiBundle();
await buildCliBundle();
await buildLibBundle();
