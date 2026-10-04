import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";

// Only public, version-controlled content. No runtime compilation or CLI imports.
export const docs = defineDocs({ dir: "../../docs", docs: { async: true } });
export const source = loader({ baseUrl: "/docs", source: docs.toFumadocsSource() });
