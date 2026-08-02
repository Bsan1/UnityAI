import { access, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { UnityIntegrationError } from "./errors.js";
import type {
  UnityInputHandling,
  UnityPackageDependency,
  UnityProjectMetadata,
} from "./types.js";

const missing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

const requireDirectory = async (path: string): Promise<void> => {
  try {
    if (!(await stat(path)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new UnityIntegrationError(
      "NOT_A_UNITY_PROJECT",
      `Required Unity project directory is missing: ${path}`,
    );
  }
};

const readJsonObject = async (
  path: string,
  code: "UNITY_MANIFEST_INVALID" | "UNITY_PROJECT_METADATA_INVALID",
  label: string,
): Promise<Record<string, unknown>> => {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${label} root must be an object.`);
    }
    return value as Record<string, unknown>;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new UnityIntegrationError(code, `${label} is invalid: ${message}`);
  }
};

const parsePackageMap = (
  value: unknown,
  name: string,
): ReadonlyMap<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnityIntegrationError(
      "UNITY_MANIFEST_INVALID",
      `${name} must be an object.`,
    );
  }
  const packages = new Map<string, string>();
  for (const [packageName, version] of Object.entries(value)) {
    if (typeof version !== "string" || version.length === 0) {
      throw new UnityIntegrationError(
        "UNITY_MANIFEST_INVALID",
        `${name}.${packageName} must be a non-empty string.`,
      );
    }
    packages.set(packageName, version);
  }
  return packages;
};

const parseLockedVersions = (value: unknown): ReadonlyMap<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new Map();
  }
  const dependencies = (value as Record<string, unknown>).dependencies;
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    return new Map();
  }
  const result = new Map<string, string>();
  for (const [name, entry] of Object.entries(dependencies)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const version = (entry as Record<string, unknown>).version;
    if (typeof version === "string" && version.length > 0) {
      result.set(name, version);
    }
  }
  return result;
};

const activeInputHandling = (settings: string | undefined): UnityInputHandling => {
  const value = /(?:^|\n)\s*activeInputHandler:\s*(\d+)/u.exec(settings ?? "")?.[1];
  switch (value) {
    case "0":
      return "OLD";
    case "1":
      return "NEW";
    case "2":
      return "BOTH";
    default:
      return "UNKNOWN";
  }
};

const boundedSetting = (settings: string | undefined, key: string): string | undefined => {
  const match = new RegExp(`(?:^|\\n)\\s*${key}:\\s*([^\\r\\n]+)`, "u").exec(
    settings ?? "",
  );
  return match?.[1]?.trim().slice(0, 2_048);
};

export class UnityProjectAdapter {
  async inspect(path: string): Promise<UnityProjectMetadata> {
    const absolute = resolve(path);
    let projectRoot: string;
    try {
      projectRoot = await realpath(absolute);
    } catch {
      throw new UnityIntegrationError(
        "NOT_A_UNITY_PROJECT",
        `Unity project path does not exist: ${absolute}`,
      );
    }

    await Promise.all([
      requireDirectory(join(projectRoot, "Assets")),
      requireDirectory(join(projectRoot, "Packages")),
      requireDirectory(join(projectRoot, "ProjectSettings")),
    ]);

    const projectVersionFile = join(
      projectRoot,
      "ProjectSettings",
      "ProjectVersion.txt",
    );
    let versionText: string;
    try {
      versionText = await readFile(projectVersionFile, "utf8");
    } catch (error: unknown) {
      if (missing(error)) {
        throw new UnityIntegrationError(
          "NOT_A_UNITY_PROJECT",
          "ProjectSettings/ProjectVersion.txt is missing.",
        );
      }
      throw new UnityIntegrationError(
        "UNITY_PROJECT_METADATA_INVALID",
        "Could not read ProjectSettings/ProjectVersion.txt.",
      );
    }
    const unityVersion = /^m_EditorVersion:\s*(\S+)\s*$/mu.exec(versionText)?.[1];
    if (unityVersion === undefined) {
      throw new UnityIntegrationError(
        "UNITY_VERSION_UNKNOWN",
        "ProjectSettings/ProjectVersion.txt does not contain a valid m_EditorVersion.",
      );
    }
    const unityRevision = /^m_EditorVersionWithRevision:\s*\S+\s*\(([^)]+)\)\s*$/mu.exec(
      versionText,
    )?.[1];

    const manifestFile = join(projectRoot, "Packages", "manifest.json");
    try {
      await access(manifestFile);
    } catch {
      throw new UnityIntegrationError(
        "UNITY_MANIFEST_INVALID",
        "Packages/manifest.json is missing.",
      );
    }
    const manifest = await readJsonObject(
      manifestFile,
      "UNITY_MANIFEST_INVALID",
      "Packages/manifest.json",
    );
    const dependencies = parsePackageMap(
      manifest.dependencies,
      "manifest.dependencies",
    );

    const lockFile = join(projectRoot, "Packages", "packages-lock.json");
    let packageLockPresent = true;
    let lockedVersions: ReadonlyMap<string, string> = new Map();
    try {
      const lock = await readJsonObject(
        lockFile,
        "UNITY_PROJECT_METADATA_INVALID",
        "Packages/packages-lock.json",
      );
      lockedVersions = parseLockedVersions(lock);
    } catch (error: unknown) {
      if (error instanceof UnityIntegrationError && !missing(error)) {
        try {
          await access(lockFile);
        } catch (accessError: unknown) {
          if (missing(accessError)) {
            packageLockPresent = false;
          } else {
            throw error;
          }
        }
        if (packageLockPresent) {
          throw error;
        }
      } else {
        throw error;
      }
    }

    let projectSettings: string | undefined;
    try {
      projectSettings = await readFile(
        join(projectRoot, "ProjectSettings", "ProjectSettings.asset"),
        "utf8",
      );
    } catch (error: unknown) {
      if (!missing(error)) {
        throw new UnityIntegrationError(
          "UNITY_PROJECT_METADATA_INVALID",
          "Could not read ProjectSettings/ProjectSettings.asset.",
        );
      }
    }

    const packages: UnityPackageDependency[] = [...dependencies.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, version]) => {
        const lockedVersion = lockedVersions.get(name);
        return {
          name,
          version,
          ...(lockedVersion === undefined ? {} : { lockedVersion }),
        };
      });

    const backendConfiguration = boundedSetting(projectSettings, "scriptingBackend");
    const apiCompatibilityConfiguration = boundedSetting(
      projectSettings,
      "apiCompatibilityLevelPerPlatform",
    );
    return {
      schemaVersion: 1,
      isUnityProject: true,
      projectRoot,
      unityVersion,
      ...(unityRevision === undefined ? {} : { unityRevision }),
      projectVersionFile,
      manifestFile,
      packageLockPresent,
      packages,
      inputSystem: {
        packagePresent: dependencies.has("com.unity.inputsystem"),
        activeInputHandling: activeInputHandling(projectSettings),
      },
      scripting: {
        ...(backendConfiguration === undefined ? {} : { backendConfiguration }),
        ...(apiCompatibilityConfiguration === undefined
          ? {}
          : { apiCompatibilityConfiguration }),
      },
      inspectedAt: new Date().toISOString(),
    };
  }
}
