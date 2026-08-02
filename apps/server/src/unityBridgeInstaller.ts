import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { GitTaskEnvironment, TaskId } from "@unityai/core";
import {
  UNITY_BRIDGE_PACKAGE_NAME,
  UnityIntegrationError,
  canonicalPathsEqual,
} from "@unityai/unity";

export interface UnityBridgeOwnershipMarker {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly bridgeVersion: string;
  readonly installedAt: string;
  readonly sourceFingerprint: string;
}

export interface UnityBridgeInstallation {
  readonly packagePath: string;
  readonly packageVersion: string;
  readonly sourceFingerprint: string;
  readonly installedAt: string;
  readonly idempotent: boolean;
}

const markerFileName = ".unityai-managed.json";

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const walkFiles = async (root: string, current = root): Promise<string[]> => {
  const results: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walkFiles(root, path));
    } else if (entry.isFile() && entry.name !== markerFileName) {
      results.push(relative(root, path).split(sep).join("/"));
    }
  }
  return results.sort();
};

const fingerprint = async (root: string): Promise<string> => {
  const hash = createHash("sha256");
  for (const path of await walkFiles(root)) {
    hash.update(path, "utf8");
    hash.update("\0", "utf8");
    hash.update(await readFile(join(root, ...path.split("/"))));
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
};

const parsePackageVersion = async (sourcePackagePath: string): Promise<string> => {
  try {
    const value = JSON.parse(
      await readFile(join(sourcePackagePath, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    if (
      value.name !== UNITY_BRIDGE_PACKAGE_NAME ||
      typeof value.version !== "string" ||
      value.version.length === 0
    ) {
      throw new Error("package identity is invalid");
    }
    return value.version;
  } catch (error: unknown) {
    throw new UnityIntegrationError(
      "UNITY_PROJECT_METADATA_INVALID",
      `UnityAI bridge source package is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
};

const parseMarker = async (path: string): Promise<UnityBridgeOwnershipMarker> => {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.taskId !== "string" ||
      typeof value.bridgeVersion !== "string" ||
      typeof value.installedAt !== "string" ||
      Number.isNaN(Date.parse(value.installedAt)) ||
      typeof value.sourceFingerprint !== "string"
    ) {
      throw new Error("ownership marker schema is invalid");
    }
    return value as unknown as UnityBridgeOwnershipMarker;
  } catch (error: unknown) {
    throw new UnityIntegrationError(
      "UNITY_BRIDGE_CONFLICT",
      `Existing bridge package has no valid UnityAI ownership marker: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
};

const verifyManagedWorktree = async (
  taskId: TaskId,
  environment: GitTaskEnvironment,
): Promise<string> => {
  if (
    environment.taskId !== taskId ||
    environment.writeOwnerTaskId !== taskId ||
    environment.status === "CLEANED"
  ) {
    throw new UnityIntegrationError(
      "UNITY_BRIDGE_OWNERSHIP_MISMATCH",
      "Git worktree ownership does not match the Unity task.",
    );
  }
  if (await canonicalPathsEqual(
    environment.taskWorktreePath,
    environment.originalWorktreePath,
  )) {
    throw new UnityIntegrationError(
      "UNITY_BRIDGE_OWNERSHIP_MISMATCH",
      "UnityAI refuses to install tooling into the original project worktree.",
    );
  }
  return realpath(environment.taskWorktreePath);
};

export class UnityBridgeInstaller {
  readonly sourcePackagePath: string;

  constructor(sourcePackagePath: string) {
    this.sourcePackagePath = resolve(sourcePackagePath);
  }

  async install(
    taskId: TaskId,
    environment: GitTaskEnvironment,
  ): Promise<UnityBridgeInstallation> {
    const worktree = await verifyManagedWorktree(taskId, environment);
    const packagesPath = join(worktree, "Packages");
    if (!(await stat(packagesPath).catch(() => undefined))?.isDirectory()) {
      throw new UnityIntegrationError(
        "NOT_A_UNITY_PROJECT",
        "Managed task worktree has no Packages directory.",
      );
    }
    const packagePath = join(packagesPath, UNITY_BRIDGE_PACKAGE_NAME);
    const sourceFingerprint = await fingerprint(this.sourcePackagePath);
    const packageVersion = await parsePackageVersion(this.sourcePackagePath);

    if (await pathExists(packagePath)) {
      const marker = await parseMarker(join(packagePath, markerFileName));
      if (
        marker.taskId !== taskId ||
        marker.bridgeVersion !== packageVersion ||
        marker.sourceFingerprint !== sourceFingerprint
      ) {
        throw new UnityIntegrationError(
          "UNITY_BRIDGE_CONFLICT",
          "Existing bridge package is not the exact managed bridge owned by this task.",
        );
      }
      return {
        packagePath: await realpath(packagePath),
        packageVersion,
        sourceFingerprint,
        installedAt: marker.installedAt,
        idempotent: true,
      };
    }

    const temporaryPath = join(
      packagesPath,
      `.unityai-bridge-${taskId}-${randomUUID()}`,
    );
    const installedAt = new Date().toISOString();
    const marker: UnityBridgeOwnershipMarker = {
      schemaVersion: 1,
      taskId,
      bridgeVersion: packageVersion,
      installedAt,
      sourceFingerprint,
    };
    try {
      await cp(this.sourcePackagePath, temporaryPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await writeFile(
        join(temporaryPath, markerFileName),
        `${JSON.stringify(marker, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(temporaryPath, packagePath);
    } catch (error: unknown) {
      await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
      if (await pathExists(packagePath)) {
        throw new UnityIntegrationError(
          "UNITY_BRIDGE_CONFLICT",
          "Bridge package appeared while installation was in progress; it was not overwritten.",
        );
      }
      throw error;
    }
    return {
      packagePath: await realpath(packagePath),
      packageVersion,
      sourceFingerprint,
      installedAt,
      idempotent: false,
    };
  }

  async remove(
    taskId: TaskId,
    environment: GitTaskEnvironment,
    expected: {
      readonly packagePath: string;
      readonly packageVersion: string;
      readonly sourceFingerprint: string;
    },
  ): Promise<void> {
    const worktree = await verifyManagedWorktree(taskId, environment);
    const exactPackagePath = join(
      worktree,
      "Packages",
      UNITY_BRIDGE_PACKAGE_NAME,
    );
    let matches = false;
    try {
      matches = await canonicalPathsEqual(expected.packagePath, exactPackagePath);
    } catch {
      matches = false;
    }
    if (!matches) {
      throw new UnityIntegrationError(
        "UNITY_BRIDGE_OWNERSHIP_MISMATCH",
        "Persisted bridge path is not the exact managed package location.",
      );
    }
    const marker = await parseMarker(join(exactPackagePath, markerFileName)).catch(
      (error: unknown) => {
        throw new UnityIntegrationError(
          "UNITY_BRIDGE_OWNERSHIP_MISMATCH",
          error instanceof Error ? error.message : "Bridge ownership marker is invalid.",
        );
      },
    );
    if (
      marker.taskId !== taskId ||
      marker.bridgeVersion !== expected.packageVersion ||
      marker.sourceFingerprint !== expected.sourceFingerprint
    ) {
      throw new UnityIntegrationError(
        "UNITY_BRIDGE_OWNERSHIP_MISMATCH",
        "Bridge ownership marker does not match persisted task metadata.",
      );
    }
    await rm(exactPackagePath, { recursive: true, force: false });
    await rm(`${exactPackagePath}.meta`, { force: true });
    if (await pathExists(exactPackagePath)) {
      throw new UnityIntegrationError(
        "UNITY_BRIDGE_OWNERSHIP_MISMATCH",
        "Managed bridge package still exists after removal.",
      );
    }
  }
}

export const unityBridgeMarkerPath = (packagePath: string): string =>
  join(packagePath, markerFileName);

export const unityBridgeFingerprint = fingerprint;
