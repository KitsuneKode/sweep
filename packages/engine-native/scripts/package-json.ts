import type { NativePlatform } from "@kitsunekode/sweep-core/native-platforms";

/**
 * The published package.json of one native engine, as text. Key order
 * matches the committed package.json in each native-packages folder (the
 * order oxfmt writes): the release job unpacks these over the tracked files,
 * and any byte difference dirties the checkout the publish guard requires to
 * be clean.
 */
export function nativePackageJson(platform: NativePlatform, version: string): string {
  const packageJson = {
    name: platform.npmName,
    version,
    description: `Native sweep-engine binary for ${platform.os} ${platform.cpu}`,
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/KitsuneKode/sweep.git",
    },
    files: ["bin"],
    os: [platform.os],
    cpu: [platform.cpu],
    publishConfig: {
      access: "public",
    },
  };
  return `${JSON.stringify(packageJson, null, 2)}\n`;
}
