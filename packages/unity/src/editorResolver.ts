import { homedir } from "node:os";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { UnityIntegrationError } from "./errors.js";
import type { UnityEditorResolution } from "./types.js";

export interface UnityEditorResolverOptions {
  readonly platform?: NodeJS.Platform;
  readonly searchRoots?: readonly string[];
}

const executableParts = (
  platform: NodeJS.Platform,
): readonly string[] => {
  switch (platform) {
    case "win32":
      return ["Editor", "Unity.exe"];
    case "darwin":
      return ["Unity.app", "Contents", "MacOS", "Unity"];
    default:
      return ["Editor", "Unity"];
  }
};

const defaultRoots = (platform: NodeJS.Platform): readonly string[] => {
  switch (platform) {
    case "win32":
      return [
        "C:\\Program Files\\Unity\\Hub\\Editor",
        "C:\\Program Files\\Unity Hub\\Editor",
      ];
    case "darwin":
      return ["/Applications/Unity/Hub/Editor"];
    default:
      return ["/opt/unityhub/editor", join(homedir(), "Unity", "Hub", "Editor")];
  }
};

const validFile = async (path: string): Promise<string | undefined> => {
  try {
    const canonical = await realpath(resolve(path));
    return (await stat(canonical)).isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
};

export class UnityEditorResolver {
  private readonly platform: NodeJS.Platform;
  private readonly searchRoots: readonly string[];

  constructor(options: UnityEditorResolverOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.searchRoots = options.searchRoots ?? defaultRoots(this.platform);
  }

  async resolve(
    requestedVersion: string,
    explicitExecutablePath?: string,
  ): Promise<UnityEditorResolution> {
    if (requestedVersion.trim().length === 0) {
      throw new UnityIntegrationError(
        "UNITY_VERSION_UNKNOWN",
        "A Unity project version is required to resolve the Editor.",
      );
    }
    if (explicitExecutablePath !== undefined) {
      const executablePath = await validFile(explicitExecutablePath);
      if (executablePath === undefined) {
        throw new UnityIntegrationError(
          "UNITY_EDITOR_NOT_FOUND",
          "The configured Unity Editor executable override is not a readable file.",
          { explicitExecutablePath },
        );
      }
      const name = basename(executablePath).toLocaleLowerCase("en-US");
      if (name !== (this.platform === "win32" ? "unity.exe" : "unity")) {
        throw new UnityIntegrationError(
          "UNITY_EDITOR_NOT_FOUND",
          "The configured Editor override does not point to a Unity executable.",
          { explicitExecutablePath: executablePath },
        );
      }
      return {
        requestedVersion,
        executablePath,
        resolutionMethod: "EXPLICIT_OVERRIDE",
      };
    }

    const executableSuffix = executableParts(this.platform);
    const installedVersions: string[] = [];
    for (const root of this.searchRoots) {
      try {
        installedVersions.push(
          ...(await readdir(root, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name),
        );
      } catch {
        // Missing optional search roots are expected.
      }
      const candidate = join(root, requestedVersion, ...executableSuffix);
      const executablePath = await validFile(candidate);
      if (executablePath !== undefined) {
        return {
          requestedVersion,
          executablePath,
          resolutionMethod: "UNITY_HUB_EXACT_VERSION",
        };
      }
    }

    throw new UnityIntegrationError(
      "UNITY_EDITOR_NOT_FOUND",
      `Unity Editor ${requestedVersion} was not found in configured Unity Hub locations.`,
      { requestedVersion, installedVersions: [...new Set(installedVersions)].sort() },
    );
  }
}
