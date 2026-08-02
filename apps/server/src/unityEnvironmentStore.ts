import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseTaskId } from "@unityai/core";
import type { TaskId } from "@unityai/core";
import type { UnityEditorResolutionMethod } from "@unityai/unity";

import { ServerError } from "./errors.js";

export interface UnityBridgeInstallationMetadata {
  readonly installed: boolean;
  readonly packagePath?: string;
  readonly packageVersion?: string;
  readonly sourceFingerprint?: string;
  readonly installedAt?: string;
  readonly removedAt?: string;
}

export interface UnityEditorLaunchMetadata {
  readonly processId: number;
  readonly launchId: string;
  readonly launchedAt: string;
}

export interface UnityBridgeConnectionMetadata {
  readonly protocolVersion: number;
  readonly bridgeVersion: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly editorProcessId: number;
  readonly sessionStartedAt: string;
  readonly connectedAt: string;
}

export interface UnityTaskEnvironment {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly projectWorktreePath: string;
  readonly unityVersion: string;
  readonly editorExecutablePath: string;
  readonly editorResolutionMethod: UnityEditorResolutionMethod;
  readonly bridge: UnityBridgeInstallationMetadata;
  readonly editorLaunch?: UnityEditorLaunchMetadata;
  readonly connection?: UnityBridgeConnectionMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const string = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
};

const timestamp = (value: unknown, name: string): string => {
  const result = string(value, name);
  if (Number.isNaN(Date.parse(result))) {
    throw new Error(`${name} must be a timestamp.`);
  }
  return result;
};

const optionalString = (value: unknown, name: string): string | undefined =>
  value === undefined ? undefined : string(value, name);

const optionalTimestamp = (value: unknown, name: string): string | undefined =>
  value === undefined ? undefined : timestamp(value, name);

export const parseUnityTaskEnvironment = (value: unknown): UnityTaskEnvironment => {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unity environment must be a schemaVersion 1 object.");
  }
  if (!isRecord(value.bridge) || typeof value.bridge.installed !== "boolean") {
    throw new Error("Unity environment bridge metadata is invalid.");
  }
  const packagePath = optionalString(value.bridge.packagePath, "bridge.packagePath");
  const packageVersion = optionalString(value.bridge.packageVersion, "bridge.packageVersion");
  const sourceFingerprint = optionalString(
    value.bridge.sourceFingerprint,
    "bridge.sourceFingerprint",
  );
  const installedAt = optionalTimestamp(value.bridge.installedAt, "bridge.installedAt");
  const removedAt = optionalTimestamp(value.bridge.removedAt, "bridge.removedAt");
  if (
    value.bridge.installed &&
    (packagePath === undefined ||
      packageVersion === undefined ||
      sourceFingerprint === undefined ||
      installedAt === undefined)
  ) {
    throw new Error("Installed bridge metadata is incomplete.");
  }

  let editorLaunch: UnityEditorLaunchMetadata | undefined;
  if (value.editorLaunch !== undefined) {
    if (
      !isRecord(value.editorLaunch) ||
      !Number.isSafeInteger(value.editorLaunch.processId) ||
      Number(value.editorLaunch.processId) < 1
    ) {
      throw new Error("Unity environment editor launch metadata is invalid.");
    }
    editorLaunch = {
      processId: Number(value.editorLaunch.processId),
      launchId: string(value.editorLaunch.launchId, "editorLaunch.launchId"),
      launchedAt: timestamp(value.editorLaunch.launchedAt, "editorLaunch.launchedAt"),
    };
  }

  let connection: UnityBridgeConnectionMetadata | undefined;
  if (value.connection !== undefined) {
    if (
      !isRecord(value.connection) ||
      value.connection.host !== "127.0.0.1" ||
      !Number.isSafeInteger(value.connection.protocolVersion) ||
      !Number.isSafeInteger(value.connection.port) ||
      Number(value.connection.port) < 1 ||
      Number(value.connection.port) > 65_535 ||
      !Number.isSafeInteger(value.connection.editorProcessId) ||
      Number(value.connection.editorProcessId) < 1
    ) {
      throw new Error("Unity environment bridge connection metadata is invalid.");
    }
    connection = {
      protocolVersion: Number(value.connection.protocolVersion),
      bridgeVersion: string(value.connection.bridgeVersion, "connection.bridgeVersion"),
      host: "127.0.0.1",
      port: Number(value.connection.port),
      editorProcessId: Number(value.connection.editorProcessId),
      sessionStartedAt: timestamp(
        value.connection.sessionStartedAt,
        "connection.sessionStartedAt",
      ),
      connectedAt: timestamp(value.connection.connectedAt, "connection.connectedAt"),
    };
  }

  const resolutionMethod = string(
    value.editorResolutionMethod,
    "editorResolutionMethod",
  );
  if (
    resolutionMethod !== "EXPLICIT_OVERRIDE" &&
    resolutionMethod !== "UNITY_HUB_EXACT_VERSION"
  ) {
    throw new Error("editorResolutionMethod is invalid.");
  }
  return {
    schemaVersion: 1,
    taskId: parseTaskId(value.taskId),
    projectWorktreePath: string(value.projectWorktreePath, "projectWorktreePath"),
    unityVersion: string(value.unityVersion, "unityVersion"),
    editorExecutablePath: string(
      value.editorExecutablePath,
      "editorExecutablePath",
    ),
    editorResolutionMethod: resolutionMethod,
    bridge: {
      installed: value.bridge.installed,
      ...(packagePath === undefined ? {} : { packagePath }),
      ...(packageVersion === undefined ? {} : { packageVersion }),
      ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
      ...(installedAt === undefined ? {} : { installedAt }),
      ...(removedAt === undefined ? {} : { removedAt }),
    },
    ...(editorLaunch === undefined ? {} : { editorLaunch }),
    ...(connection === undefined ? {} : { connection }),
    createdAt: timestamp(value.createdAt, "createdAt"),
    updatedAt: timestamp(value.updatedAt, "updatedAt"),
  };
};

const missing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

export class UnityEnvironmentStore {
  private readonly tasksRoot: string;

  constructor(runtimeRoot: string) {
    this.tasksRoot = join(runtimeRoot, "tasks");
  }

  async initialize(): Promise<void> {
    await mkdir(this.tasksRoot, { recursive: true });
  }

  async get(taskId: TaskId): Promise<UnityTaskEnvironment | undefined> {
    const path = join(this.tasksRoot, parseTaskId(taskId), "unity.json");
    try {
      return parseUnityTaskEnvironment(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch (error: unknown) {
      if (missing(error)) {
        return undefined;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "UNITY_PROJECT_METADATA_INVALID",
        `Could not read or validate Unity metadata for ${taskId}: ${message}`,
        500,
      );
    }
  }

  async save(value: UnityTaskEnvironment): Promise<UnityTaskEnvironment> {
    const environment = parseUnityTaskEnvironment(value);
    const directory = join(this.tasksRoot, environment.taskId);
    const destination = join(directory, "unity.json");
    const temporary = join(directory, `.unity.${process.pid}.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(environment, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(temporary, destination);
      return environment;
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "UNITY_PROJECT_METADATA_INVALID",
        `Could not persist Unity metadata for ${environment.taskId}: ${message}`,
        500,
      );
    }
  }
}
