import { expect, test } from "bun:test";
import { sameFilesystemIdentity, validFilesystemIdentity } from "./filesystem-identity.js";

test("filesystem identities retain exact uint64 strings and reject unsafe forms", () => {
  const identity = {
    platform: "unix" as const,
    device: "18446744073709551615",
    inode: "9007199254740993",
  };
  expect(validFilesystemIdentity(identity)).toBe(true);
  expect(sameFilesystemIdentity(identity, { ...identity })).toBe(true);
  expect(sameFilesystemIdentity(identity, { ...identity, inode: "9007199254740992" })).toBe(false);
  for (const malformed of [
    { ...identity, inode: 9007199254740992 },
    { ...identity, inode: "0" },
    { ...identity, inode: "01" },
    { ...identity, device: "18446744073709551616" },
    { ...identity, platform: "other" },
    { ...identity, ignored: "field" },
  ])
    expect(validFilesystemIdentity(malformed)).toBe(false);
});
