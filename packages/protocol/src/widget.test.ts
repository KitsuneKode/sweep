import { describe, expect, test } from "bun:test";
import {
  REBUILD_COSTS,
  WIDGET_ACTION_INTENTS,
  WIDGET_CACHE_SCHEMA,
  WIDGET_CACHE_VERSION,
  WIDGET_ERROR_CODES,
  WIDGET_EVENT_SCHEMA,
  WIDGET_EVENT_TYPES,
  WIDGET_SCHEMA_VERSION,
  WIDGET_SNAPSHOT_SCHEMA,
  WIDGET_VIEWS,
} from "./index.js";

describe("widget protocol exports", () => {
  test("exports versioned constants and closed enums", () => {
    expect(WIDGET_SCHEMA_VERSION).toBe(1);
    expect(WIDGET_CACHE_VERSION).toBe(1);
    expect(WIDGET_VIEWS).toEqual(["projects"]);
    expect(REBUILD_COSTS).toEqual(["cache", "install", "build", "custom"]);
    expect(WIDGET_EVENT_TYPES).toEqual([
      "widget_started",
      "widget_progress",
      "widget_snapshot",
      "widget_error",
    ]);
    expect(WIDGET_ERROR_CODES).toEqual([
      "not_installed",
      "engine_missing",
      "permission_denied",
      "target_missing",
      "target_refused",
      "config_invalid",
      "timeout",
      "scan_failed",
      "schema_mismatch",
    ]);
    expect(WIDGET_ACTION_INTENTS).toContain("review_projects");
  });

  test("exports Draft 2020-12 JSON Schemas for snapshot, event, and cache", () => {
    expect(WIDGET_SNAPSHOT_SCHEMA.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(WIDGET_SNAPSHOT_SCHEMA.title).toBe("WidgetSnapshot");
    expect(WIDGET_SNAPSHOT_SCHEMA.properties.readOnly.const).toBe(true);
    expect(WIDGET_SNAPSHOT_SCHEMA.properties.widgetSchemaVersion.const).toBe(1);

    expect(WIDGET_EVENT_SCHEMA.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(WIDGET_EVENT_SCHEMA.title).toBe("WidgetEvent");
    expect(WIDGET_EVENT_SCHEMA.oneOf).toHaveLength(4);

    expect(WIDGET_CACHE_SCHEMA.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(WIDGET_CACHE_SCHEMA.title).toBe("WidgetCacheEnvelope");
    expect(WIDGET_CACHE_SCHEMA.properties.cacheVersion.const).toBe(1);
  });
});
