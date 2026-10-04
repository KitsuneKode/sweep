import { execFileSync } from "node:child_process";

interface CiRun {
  databaseId: number;
  headSha: string;
  headBranch: string;
  event: string;
  status: string;
  conclusion: string;
}

/** GitHub lists newest runs first; a failed rerun cannot borrow an older pass. */
export function ciQualification(runs: CiRun[], sha: string): "waiting" | "passed" | "failed" {
  const run = runs.find(
    (item) => item.headSha === sha && item.headBranch === "main" && item.event === "push",
  );
  if (!run || run.status !== "completed") return "waiting";
  return run.conclusion === "success" ? "passed" : "failed";
}

/** Read-only GitHub gate, called before any CI publication side effects. */
export async function requireQualifiedCi(repository: string | undefined, sha: string | undefined) {
  if (
    !repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !sha ||
    !/^[a-f0-9]{40}$/.test(sha)
  )
    throw new Error("CI publication requires GITHUB_REPOSITORY and an exact GITHUB_SHA");
  const deadline = Date.now() + 30 * 60 * 1000;
  console.log(`Waiting for successful push CI on ${sha}`);
  while (Date.now() < deadline) {
    const output = execFileSync(
      "gh",
      [
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        "ci.yml",
        "--commit",
        sha,
        "--event",
        "push",
        "--branch",
        "main",
        "--limit",
        "10",
        "--json",
        "databaseId,headSha,headBranch,event,status,conclusion",
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const state = ciQualification(JSON.parse(output) as CiRun[], sha);
    if (state === "passed") {
      console.log("Exact-commit CI qualification passed");
      return;
    }
    if (state === "failed")
      throw new Error("CI failed for the publication commit; refusing publication");
    await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error("Timed out waiting for exact-commit CI; refusing publication");
}
