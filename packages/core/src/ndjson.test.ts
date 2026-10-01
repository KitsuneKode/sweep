import { describe, expect, test } from "bun:test";
import { NdjsonDecoder } from "./ndjson.js";

describe("bounded NDJSON transport", () => {
  test("handles fragmented lines, CRLF and a final unterminated line", () => {
    const lines: string[] = [];
    const decoder = new NdjsonDecoder((line) => lines.push(line), 32);
    decoder.push('{"a":');
    decoder.push('1}\r\n\n{"b":2}');
    decoder.finish();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("rejects oversized lines before a newline arrives, counting UTF-8 bytes", () => {
    const decoder = new NdjsonDecoder(() => {}, 4);
    decoder.push("é");
    expect(() => decoder.push("éa")).toThrow("event exceeded");
  });

  test("caps individual lines rather than an entire multi-line chunk", () => {
    const lines: string[] = [];
    const decoder = new NdjsonDecoder((line) => lines.push(line), 2);
    decoder.push("a\nb\nc\n");
    expect(lines).toEqual(["a", "b", "c"]);
  });
});
