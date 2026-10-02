import { expect, test } from "bun:test";
import { releasePolicy } from "./release-policy.js";

test("stable publishes explicitly use latest and the monorepo scoped git tag", () => {
  const policy = releasePolicy("0.4.0");
  expect(policy.distTag).toBe("latest");
  expect(policy.gitTag).toBe("@kitsunekode/sweep@0.4.0");
  expect(policy.changesetArgs).toEqual(["changeset", "publish", "--tag", "latest"]);
});

test("previews never default to latest and respect installed Changesets pre mode", () => {
  expect(releasePolicy("0.4.0-next.0").distTag).toBe("next");
  const policy = releasePolicy("0.4.0-beta.0", { mode: "pre", tag: "beta" });
  expect(policy.distTag).toBe("beta");
  expect(policy.changesetArgs).toEqual(["changeset", "publish"]);
  expect(policy.prerelease).toBe(true);
  expect(() => releasePolicy("0.4.0-latest.0", { mode: "pre", tag: "latest" })).toThrow("Unsafe");
  expect(() => releasePolicy("0.4.0", { mode: "pre", tag: "next" })).toThrow("requires");
  expect(() => releasePolicy("0.4.0-beta.0", { mode: "pre", tag: "next" })).toThrow("match");
});

test("malformed versions fail before publication", () => {
  for (const version of ["", "01.2.3", "0.4.0-next.01", "0.4.0;echo", "0.4.0-"])
    expect(() => releasePolicy(version)).toThrow("Invalid release version");
});
