import { describe, expect, test } from "bun:test";
import type { NativePlatform } from "@kitsunekode/sweep-core/native-platforms";
import {
  CLI_PACKAGE,
  REPO,
  WORKFLOW,
  hasMatchingGitHubTrust,
  parseTrustListOutput,
  runBootstrap,
  type NpmCommandResult,
  type NpmRunner,
} from "../../../scripts/bootstrap-npm-trusted-publishing.js";

const TEST_PLATFORMS: readonly NativePlatform[] = [
  {
    id: "linux-64",
    npmName: "@kitsunekode/sweep-engine-linux-64",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    cargoTarget: "x86_64-unknown-linux-gnu",
    binaryName: "sweep-engine",
  },
  {
    id: "linux-64-musl",
    npmName: "@kitsunekode/sweep-engine-linux-64-musl",
    os: "linux",
    cpu: "x64",
    libc: "musl",
    cargoTarget: "x86_64-unknown-linux-musl",
    binaryName: "sweep-engine",
  },
];

describe("bootstrap-npm-trusted-publishing", () => {
  test("parseTrustListOutput handles empty, single object, array, and npm 11.20 concatenated objects", () => {
    expect(parseTrustListOutput("")).toEqual([]);
    expect(parseTrustListOutput("   \n  ")).toEqual([]);

    const single = JSON.stringify(
      {
        id: "t1",
        type: "github",
        repository: REPO,
        file: WORKFLOW,
        permissions: ["createPackage"],
      },
      null,
      2,
    );
    expect(parseTrustListOutput(single)).toEqual([
      {
        id: "t1",
        type: "github",
        repository: REPO,
        file: WORKFLOW,
        permissions: ["createPackage"],
      },
    ]);

    const array = JSON.stringify([
      { id: "t1", type: "github", repository: "other/repo", file: WORKFLOW },
      {
        id: "t2",
        type: "github",
        repository: REPO,
        file: WORKFLOW,
        permissions: ["createPackage"],
      },
    ]);
    expect(parseTrustListOutput(array)).toHaveLength(2);

    // npm 11.20 prints separate formatted JSON objects separated by blank lines.
    const multi = `\n${JSON.stringify(
      {
        id: "t1",
        type: "github",
        repository: "other/repo",
        file: "other.yml",
        permissions: ["createStagedPackage"],
      },
      null,
      2,
    )}\n\n${JSON.stringify(
      {
        id: "t2",
        type: "github",
        repository: REPO,
        file: WORKFLOW,
        permissions: ["createPackage"],
      },
      null,
      2,
    )}\n`;
    const parsedMulti = parseTrustListOutput(multi);
    expect(parsedMulti).toHaveLength(2);
    expect(hasMatchingGitHubTrust(parsedMulti ?? [])).toBe(true);

    expect(parseTrustListOutput("not valid json")).toBeNull();
  });

  test("hasMatchingGitHubTrust requires matching repo, workflow, no environment restriction, and publish permission", () => {
    expect(
      hasMatchingGitHubTrust([
        {
          type: "github",
          repository: REPO,
          file: WORKFLOW,
          permissions: ["createPackage"],
        },
      ]),
    ).toBe(true);

    // Stage-only publish does not satisfy publish permission.
    expect(
      hasMatchingGitHubTrust([
        {
          type: "github",
          repository: REPO,
          file: WORKFLOW,
          permissions: ["createStagedPackage"],
        },
      ]),
    ).toBe(false);

    // Empty permissions array does not allow publish.
    expect(
      hasMatchingGitHubTrust([
        {
          type: "github",
          repository: REPO,
          file: WORKFLOW,
          permissions: [],
        },
      ]),
    ).toBe(false);

    // Legacy entry without permissions field still matches.
    expect(
      hasMatchingGitHubTrust([
        {
          type: "github",
          repository: REPO.toLowerCase(),
          file: WORKFLOW,
        },
      ]),
    ).toBe(true);

    // Environment-restricted trust config does not match release.yml (no environment).
    expect(
      hasMatchingGitHubTrust([
        {
          type: "github",
          repository: REPO,
          file: WORKFLOW,
          environment: "production",
          permissions: ["createPackage"],
        },
      ]),
    ).toBe(false);

    // Raw registry claims shape is also recognized.
    expect(
      hasMatchingGitHubTrust([
        {
          type: "github",
          claims: {
            repository: REPO,
            workflow_ref: { file: WORKFLOW },
          },
          permissions: ["createPackage"],
        },
      ]),
    ).toBe(true);
  });

  test("publishes only missing placeholders, skips already-trusted packages, and passes --allow-publish", () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const errors: string[] = [];

    const existing = new Set<string>([CLI_PACKAGE, "@kitsunekode/sweep-engine-linux-64"]);

    const runNpm: NpmRunner = (args): NpmCommandResult => {
      calls.push(args);
      if (args[0] === "view") {
        const pkg = args[1]!;
        return existing.has(pkg)
          ? { status: 0, stdout: "0.5.3\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "E404" };
      }
      if (args[0] === "publish") {
        existing.add("@kitsunekode/sweep-engine-linux-64-musl");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "trust" && args[1] === "list") {
        const pkg = args[2]!;
        if (pkg === CLI_PACKAGE || pkg === "@kitsunekode/sweep-engine-linux-64") {
          return {
            status: 0,
            stdout: JSON.stringify({
              id: `trust-${pkg}`,
              type: "github",
              repository: REPO,
              file: WORKFLOW,
              permissions: ["createPackage"],
            }),
            stderr: "",
          };
        }
        // Newly published package has no trust config yet.
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "trust" && args[1] === "github") {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected npm args: ${args.join(" ")}`);
    };

    const result = runBootstrap({
      publishMissing: true,
      configureTrust: true,
      platforms: TEST_PLATFORMS,
      runNpm,
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });

    expect(result.exitCode).toBe(0);
    expect(result.published).toEqual(["@kitsunekode/sweep-engine-linux-64-musl"]);
    expect(result.alreadyTrusted).toEqual([CLI_PACKAGE, "@kitsunekode/sweep-engine-linux-64"]);
    expect(result.trusted).toEqual(["@kitsunekode/sweep-engine-linux-64-musl"]);
    expect(result.failed).toEqual([]);
    expect(errors).toEqual([]);

    // npm trust github must only be called for the untrusted package, with --allow-publish.
    const trustGithubCalls = calls.filter((c) => c[0] === "trust" && c[1] === "github");
    expect(trustGithubCalls).toEqual([
      [
        "trust",
        "github",
        "@kitsunekode/sweep-engine-linux-64-musl",
        "--file",
        WORKFLOW,
        "--repo",
        REPO,
        "--allow-publish",
        "--yes",
      ],
    ]);

    const summary = logs.join("\n");
    expect(summary).toContain("Summary:");
    expect(summary).toContain("published:");
    expect(summary).toContain("trusted:");
    expect(summary).toContain("already trusted:");
    expect(summary).toContain("failed:");
  });

  test("falls back to npm trust github when npm trust list fails or is unsupported", () => {
    const calls: string[][] = [];

    const runNpm: NpmRunner = (args): NpmCommandResult => {
      calls.push(args);
      if (args[0] === "view") {
        return { status: 0, stdout: "0.5.3\n", stderr: "" };
      }
      if (args[0] === "trust" && args[1] === "list") {
        return { status: 1, stdout: "", stderr: "Unknown command: list" };
      }
      if (args[0] === "trust" && args[1] === "github") {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected npm args: ${args.join(" ")}`);
    };

    const result = runBootstrap({
      publishMissing: false,
      configureTrust: true,
      platforms: [TEST_PLATFORMS[0]!],
      runNpm,
      log: () => {},
      error: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.alreadyTrusted).toEqual([]);
    expect(result.trusted).toEqual([CLI_PACKAGE, "@kitsunekode/sweep-engine-linux-64"]);
    const trustGithubCalls = calls.filter((c) => c[0] === "trust" && c[1] === "github");
    expect(trustGithubCalls).toHaveLength(2);
    for (const call of trustGithubCalls) {
      expect(call).toContain("--allow-publish");
    }
  });

  test("exits non-zero and reports failures when publish or trust fails", () => {
    const errors: string[] = [];

    const runNpm: NpmRunner = (args): NpmCommandResult => {
      if (args[0] === "view") {
        const pkg = args[1]!;
        return pkg === CLI_PACKAGE
          ? { status: 0, stdout: "0.5.3\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "E404" };
      }
      if (args[0] === "publish") {
        return { status: 1, stdout: "", stderr: "EOTP" };
      }
      if (args[0] === "trust" && args[1] === "list") {
        return {
          status: 0,
          stdout: JSON.stringify({
            type: "github",
            repository: REPO,
            file: WORKFLOW,
            permissions: ["createStagedPackage"],
          }),
          stderr: "",
        };
      }
      if (args[0] === "trust" && args[1] === "github") {
        return { status: 1, stdout: "", stderr: "E403" };
      }
      throw new Error(`unexpected npm args: ${args.join(" ")}`);
    };

    const result = runBootstrap({
      publishMissing: true,
      configureTrust: true,
      platforms: [TEST_PLATFORMS[1]!],
      runNpm,
      log: () => {},
      error: (msg) => errors.push(msg),
    });

    expect(result.exitCode).toBe(1);
    expect(result.published).toEqual([]);
    expect(result.trusted).toEqual([]);
    expect(result.alreadyTrusted).toEqual([]);
    expect(result.failed.map((f) => `${f.name}:${f.step}`)).toEqual([
      "@kitsunekode/sweep-engine-linux-64-musl:publish",
      `${CLI_PACKAGE}:trust`,
      "@kitsunekode/sweep-engine-linux-64-musl:trust",
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });
});
