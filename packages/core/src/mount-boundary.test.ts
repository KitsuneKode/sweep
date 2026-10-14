import { expect, test } from "bun:test";
import { mountPointsFromInfo, assertNoMountsWithin } from "./mount-boundary.js";

test("mount policy rejects nested mounts including same-device bind mounts", () => {
  const mounts = mountPointsFromInfo(
    "42 1 8:1 / /fixture/node_modules/volume rw - ext4 /dev/fake rw\n43 1 8:1 /data /fixture/node_modules/bind rw - ext4 /dev/fake rw\n",
  );
  expect(() => assertNoMountsWithin("/fixture/node_modules", mounts)).toThrow("mounted filesystem");
  expect(() => assertNoMountsWithin("/fixture/node", mounts)).not.toThrow();
});

test("mount path escapes are decoded and malformed snapshots refuse checking", () => {
  const mounts = mountPointsFromInfo("42 1 8:1 / /fixture/a\\040b rw - ext4 /dev/fake rw\n");
  expect(mounts).toEqual(["/fixture/a b"]);
  expect(() => assertNoMountsWithin("/fixture/a b", mounts)).toThrow("mounted filesystem");
  expect(() => mountPointsFromInfo("not mountinfo")).toThrow("mount table");
});

test("mount policy rejects ancestor mounts crossed below an explicitly selected root", () => {
  const mounts = ["/", "/fixture", "/fixture/alias", "/other"];
  expect(() => assertNoMountsWithin("/fixture/alias/pkg/node_modules", mounts, "/fixture")).toThrow(
    "mounted filesystem",
  );
  expect(() =>
    assertNoMountsWithin("/fixture/alias/pkg/tsconfig.tsbuildinfo", mounts, "/fixture"),
  ).toThrow("mounted filesystem");
  // Explicitly choosing a root on a mounted filesystem does not cross its
  // boundary. This keeps mounted workspaces usable without traversing mounts
  // introduced beneath the reviewed root.
  expect(() =>
    assertNoMountsWithin("/fixture/alias/pkg/node_modules", mounts, "/fixture/alias"),
  ).not.toThrow();
  expect(() =>
    assertNoMountsWithin("/fixture/alias-other/node_modules", mounts, "/fixture"),
  ).not.toThrow();
});
