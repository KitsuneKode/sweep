import "@tanstack/react-start/server-only";
import { createFromSource } from "fumadocs-core/search/server";
import { source } from "./source";
export const search = createFromSource(source, { language: "english" });
