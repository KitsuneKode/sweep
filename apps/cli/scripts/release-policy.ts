/** Pure publication policy, tested without contacting a registry. */
export interface PreState {
  mode: "pre" | "exit";
  tag: string;
}

export function releasePolicy(
  version: string,
  preState?: PreState,
): {
  distTag: string;
  gitTag: string;
  prerelease: boolean;
} {
  const semver =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const match = semver.exec(version);
  if (!match || match[4]?.split(".").some((id) => /^0\d+$/.test(id)))
    throw new Error(`Invalid release version: ${version}`);
  const prerelease = match[4] !== undefined;
  const preMode = preState?.mode === "pre";
  if (preMode && !prerelease) throw new Error("Prerelease mode requires a prerelease version");
  const distTag = prerelease ? (preMode ? preState.tag : "next") : "latest";
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(distTag) || (prerelease && distTag === "latest"))
    throw new Error(`Unsafe prerelease dist-tag: ${distTag}`);
  if (preMode && match[4]?.split(".")[0] !== distTag)
    throw new Error("Prerelease version does not match the Changesets tag");
  return { distTag, gitTag: `@kitsunekode/sweep@${version}`, prerelease };
}
