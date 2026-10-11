import { expect, test } from "bun:test";
import { NATIVE_PLATFORMS } from "@kitsunekode/sweep-core/native-platforms";
import { assertBinaryFormat } from "./binary-format.js";

function header(id: string): Buffer {
  const bytes = Buffer.alloc(512);
  if (id.startsWith("linux")) {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    bytes.writeUInt16LE(3, 16);
    bytes.writeUInt16LE(id.endsWith("arm64") ? 183 : 62, 18);
  } else if (id.startsWith("darwin")) {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(id.endsWith("arm64") ? 0x0100000c : 0x01000007, 4);
    bytes.writeUInt32LE(2, 12);
  } else {
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(128, 60);
    bytes.writeUInt32LE(0x00004550, 128);
    bytes.writeUInt16LE(0x8664, 132);
    bytes.writeUInt16LE(2, 150);
    bytes.writeUInt16LE(0x20b, 152);
  }
  return bytes;
}

test("native packaging rejects every foreign platform header, including explicit --binary payloads", () => {
  for (const platform of NATIVE_PLATFORMS) {
    expect(() => assertBinaryFormat(header(platform.id), 512, platform)).not.toThrow();
    for (const other of NATIVE_PLATFORMS.filter((other) => other.id !== platform.id))
      expect(() => assertBinaryFormat(header(other.id), 512, platform)).toThrow(/Expected/);
    expect(() => assertBinaryFormat(Buffer.from("arbitrary text"), 512, platform)).toThrow();
    expect(() => assertBinaryFormat(header(platform.id), 16, platform)).toThrow();
  }
});

test("PE headers cannot seek beyond the bounded header or accept a DLL as the CLI", () => {
  const platform = NATIVE_PLATFORMS.find((p) => p.id === "windows-64")!;
  const truncated = header(platform.id);
  truncated.writeUInt32LE(1024 * 1024, 60);
  expect(() => assertBinaryFormat(truncated, 2 * 1024 * 1024, platform)).toThrow();
  const dll = header(platform.id);
  dll.writeUInt16LE(0x2002, 150);
  expect(() => assertBinaryFormat(dll, 512, platform)).toThrow();
});
