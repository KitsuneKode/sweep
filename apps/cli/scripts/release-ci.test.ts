import { expect, test } from "bun:test";
import { ciQualification } from "./release-ci.js";

const sha = "a".repeat(40);
const run = {
  databaseId: 42,
  headSha: sha,
  headBranch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
};

test("publication requires successful push CI for the exact source commit", () => {
  expect(ciQualification([run], sha)).toBe("passed");
  expect(ciQualification([{ ...run, headSha: "b".repeat(40) }], sha)).toBe("waiting");
  expect(ciQualification([{ ...run, event: "pull_request" }], sha)).toBe("waiting");
  expect(ciQualification([{ ...run, headBranch: "other" }], sha)).toBe("waiting");
  expect(ciQualification([], sha)).toBe("waiting");
  expect(ciQualification([{ ...run, status: "in_progress", conclusion: "" }], sha)).toBe("waiting");
});

test("failed, skipped or cancelled CI cannot authorize a registry write", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "skipped", "neutral", ""])
    expect(ciQualification([{ ...run, conclusion }], sha)).toBe("failed");
  expect(ciQualification([{ ...run, conclusion: "failure" }, run], sha)).toBe("failed");
});
