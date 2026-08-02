import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { TaskId } from "@unityai/core";
import {
  UnityBridgeClient,
  UnityEditorResolver,
  UnityIntegrationError,
  UnityProjectAdapter,
  canonicalPathsEqual,
} from "@unityai/unity";
import type {
  UnityBridgePing,
  UnityEditorStatus,
  UnityProjectMetadata,
} from "@unityai/unity";

import type { GitSafetyService } from "./gitSafetyService.js";
import type { ProjectRegistry } from "./projectRegistry.js";
import type { TaskService } from "./taskService.js";
import { UnityBridgeInstaller } from "./unityBridgeInstaller.js";
import type {
  UnityTaskEnvironment,
} from "./unityEnvironmentStore.js";
import { UnityEnvironmentStore } from "./unityEnvironmentStore.js";
import { UnityEditorProcessManager } from "./unityEditorProcessManager.js";

export interface UnityProjectInspection {
  readonly projectId: string;
  readonly metadata: UnityProjectMetadata;
  readonly editor:
    | {
        readonly found: true;
        readonly requestedVersion: string;
        readonly executablePath: string;
        readonly resolutionMethod: string;
      }
    | {
        readonly found: false;
        readonly requestedVersion: string;
        readonly error: { readonly code: string; readonly message: string };
      };
}

export interface UnityTaskEnvironmentStatus {
  readonly environment?: UnityTaskEnvironment;
  readonly bridge: "NOT_INSTALLED" | "INSTALLED" | "CONNECTED" | "STALE";
  readonly editor: "STOPPED" | "RUNNING" | "DISCONNECTED";
  readonly ownedEditor: boolean;
  readonly editorStatus?: UnityEditorStatus;
  readonly diagnostic?: { readonly code: string; readonly message: string };
}

export interface UnityEnvironmentServiceOptions {
  readonly adapter?: UnityProjectAdapter;
  readonly resolver?: UnityEditorResolver;
  readonly installer?: UnityBridgeInstaller;
  readonly processManager?: UnityEditorProcessManager;
  readonly clientFactory?: (projectPath: string) => UnityBridgeClient;
  readonly processIsAlive?: (processId: number) => boolean;
  readonly editorStartTimeoutMs?: number;
}

const sleep = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted === true) {
      rejectPromise(new UnityIntegrationError(
        "UNITY_BRIDGE_CANCELLED",
        "Unity operation was cancelled.",
      ));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      rejectPromise(new UnityIntegrationError(
        "UNITY_BRIDGE_CANCELLED",
        "Unity operation was cancelled.",
      ));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

const nativeProcessIsAlive = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error: unknown) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
};

const diagnostic = (error: unknown): { readonly code: string; readonly message: string } => ({
  code: error instanceof UnityIntegrationError ? error.code : "UNITY_COMMAND_FAILED",
  message: error instanceof Error ? error.message : "Unknown Unity integration error",
});

export class UnityEnvironmentService {
  private readonly tasks: TaskService;
  private readonly git: GitSafetyService;
  private readonly projects: ProjectRegistry;
  private readonly store: UnityEnvironmentStore;
  private readonly runtimeRoot: string;
  private readonly adapter: UnityProjectAdapter;
  private readonly resolver: UnityEditorResolver;
  private readonly installer: UnityBridgeInstaller;
  private readonly processManager: UnityEditorProcessManager;
  private readonly clientFactory: (projectPath: string) => UnityBridgeClient;
  private readonly processIsAlive: (processId: number) => boolean;
  private readonly editorStartTimeoutMs: number;

  constructor(
    input: {
      readonly tasks: TaskService;
      readonly git: GitSafetyService;
      readonly projects: ProjectRegistry;
      readonly store: UnityEnvironmentStore;
      readonly runtimeRoot: string;
      readonly bridgeSourcePackagePath: string;
    },
    options: UnityEnvironmentServiceOptions = {},
  ) {
    this.tasks = input.tasks;
    this.git = input.git;
    this.projects = input.projects;
    this.store = input.store;
    this.runtimeRoot = resolve(input.runtimeRoot);
    this.adapter = options.adapter ?? new UnityProjectAdapter();
    this.resolver = options.resolver ?? new UnityEditorResolver();
    this.installer = options.installer ?? new UnityBridgeInstaller(
      input.bridgeSourcePackagePath,
    );
    this.processManager = options.processManager ?? new UnityEditorProcessManager();
    this.clientFactory = options.clientFactory ?? ((path) => new UnityBridgeClient(path));
    this.processIsAlive = options.processIsAlive ?? nativeProcessIsAlive;
    this.editorStartTimeoutMs = options.editorStartTimeoutMs ?? 180_000;
  }

  async inspectProject(projectId: string): Promise<UnityProjectInspection> {
    const project = this.projects.get(projectId);
    const metadata = await this.adapter.inspect(project.path);
    try {
      const editor = await this.resolver.resolve(
        metadata.unityVersion,
        project.unityEditorPath,
      );
      return { projectId: project.id, metadata, editor: { found: true, ...editor } };
    } catch (error: unknown) {
      if (!(error instanceof UnityIntegrationError)) {
        throw error;
      }
      return {
        projectId: project.id,
        metadata,
        editor: {
          found: false,
          requestedVersion: metadata.unityVersion,
          error: { code: error.code, message: error.message },
        },
      };
    }
  }

  async prepare(id: string): Promise<UnityTaskEnvironment> {
    const task = await this.tasks.get(id);
    const { environment: gitEnvironment } = await this.git.getEnvironmentWithStatus(id);
    if (
      gitEnvironment === undefined ||
      gitEnvironment.taskId !== task.id ||
      gitEnvironment.writeOwnerTaskId !== task.id ||
      gitEnvironment.status === "CLEANED"
    ) {
      throw new UnityIntegrationError(
        "UNITY_BRIDGE_OWNERSHIP_MISMATCH",
        `Task ${task.id} does not own an active managed Git worktree.`,
      );
    }
    if (await canonicalPathsEqual(
      gitEnvironment.taskWorktreePath,
      gitEnvironment.originalWorktreePath,
    )) {
      throw new UnityIntegrationError(
        "UNITY_BRIDGE_OWNERSHIP_MISMATCH",
        "UnityAI refuses to prepare Unity tooling in the original worktree.",
      );
    }
    const metadata = await this.adapter.inspect(gitEnvironment.taskWorktreePath);
    const project = this.projects.findByPath(task.targetProjectPath);
    const editor = await this.resolver.resolve(
      metadata.unityVersion,
      project?.unityEditorPath,
    );
    const installation = await this.installer.install(task.id, gitEnvironment);
    const previous = await this.store.get(task.id);
    const timestamp = new Date().toISOString();
    const environment: UnityTaskEnvironment = {
      schemaVersion: 1,
      taskId: task.id,
      projectWorktreePath: metadata.projectRoot,
      unityVersion: metadata.unityVersion,
      editorExecutablePath: editor.executablePath,
      editorResolutionMethod: editor.resolutionMethod,
      bridge: {
        installed: true,
        packagePath: installation.packagePath,
        packageVersion: installation.packageVersion,
        sourceFingerprint: installation.sourceFingerprint,
        installedAt: installation.installedAt,
      },
      ...(previous?.editorLaunch === undefined
        ? {}
        : { editorLaunch: previous.editorLaunch }),
      ...(previous?.connection === undefined
        ? {}
        : { connection: previous.connection }),
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    return this.store.save(environment);
  }

  async getEnvironment(id: string): Promise<UnityTaskEnvironment | undefined> {
    const task = await this.tasks.get(id);
    return this.store.get(task.id);
  }

  async status(id: string): Promise<UnityTaskEnvironmentStatus> {
    const task = await this.tasks.get(id);
    const environment = await this.store.get(task.id);
    if (environment === undefined) {
      return {
        bridge: "NOT_INSTALLED",
        editor: "STOPPED",
        ownedEditor: false,
      };
    }
    if (!environment.bridge.installed) {
      return {
        environment,
        bridge: "NOT_INSTALLED",
        editor: "STOPPED",
        ownedEditor: false,
      };
    }
    const ownedEditor = this.processManager.isOwned(
      task.id,
      environment.editorLaunch?.processId,
    );
    try {
      const client = this.clientFactory(environment.projectWorktreePath);
      const ping = await client.ping();
      this.assertPingIdentity(environment, ping);
      const editorStatus = await client.editorStatus();
      return {
        environment,
        bridge: "CONNECTED",
        editor: "RUNNING",
        ownedEditor,
        editorStatus,
      };
    } catch (error: unknown) {
      return {
        environment,
        bridge: environment.connection === undefined ? "INSTALLED" : "STALE",
        editor: ownedEditor ? "RUNNING" : "DISCONNECTED",
        ownedEditor,
        diagnostic: diagnostic(error),
      };
    }
  }

  async startEditor(id: string, signal?: AbortSignal): Promise<UnityTaskEnvironmentStatus> {
    const task = await this.tasks.get(id);
    const environment = await this.requireInstalled(task.id);
    const { environment: gitEnvironment } = await this.git.getEnvironmentWithStatus(id);
    if (gitEnvironment === undefined || !(await canonicalPathsEqual(
      environment.projectWorktreePath,
      gitEnvironment.taskWorktreePath,
    ))) {
      throw new UnityIntegrationError(
        "UNITY_BRIDGE_OWNERSHIP_MISMATCH",
        "Unity environment no longer matches the registered managed worktree.",
      );
    }
    const existingStatus = await this.status(id);
    if (
      existingStatus.bridge === "CONNECTED" ||
      this.processManager.isOwned(task.id)
    ) {
      return existingStatus;
    }
    const existingClient = this.clientFactory(environment.projectWorktreePath);
    const descriptorPath = existingClient.descriptorPath;
    try {
      const existingDescriptor = await existingClient.descriptor();
      if (this.processIsAlive(existingDescriptor.editorProcessId)) {
        throw new UnityIntegrationError(
          "EDITOR_NOT_OWNED",
          "A matching Unity Editor appears to be running but its bridge is not responsive; UnityAI will not replace or stop that session.",
        );
      }
    } catch (error: unknown) {
      if (
        error instanceof UnityIntegrationError &&
        error.code === "EDITOR_NOT_OWNED"
      ) {
        throw error;
      }
      // Missing, invalid, or provably stale descriptor data is replaced only
      // inside the exact managed worktree before a new owned launch.
    }
    await rm(descriptorPath, { force: true }).catch(() => undefined);
    const logPath = join(this.runtimeRoot, "tasks", task.id, "unity", "editor.log");
    const handle = await this.processManager.start({
      taskId: task.id,
      executablePath: environment.editorExecutablePath,
      projectPath: environment.projectWorktreePath,
      logPath,
    });
    const launchedAt = new Date().toISOString();
    let updated = await this.store.save({
      ...environment,
      editorLaunch: {
        processId: handle.pid,
        launchId: randomUUID(),
        launchedAt,
      },
      connection: undefined,
      updatedAt: launchedAt,
    } as unknown as UnityTaskEnvironment);
    try {
      const ping = await this.waitForBridge(
        updated,
        handle.exit,
        signal,
      );
      const descriptor = await this.clientFactory(
        updated.projectWorktreePath,
      ).descriptor();
      this.assertPingIdentity(updated, ping);
      const connectedAt = new Date().toISOString();
      updated = await this.store.save({
        ...updated,
        connection: {
          protocolVersion: descriptor.protocolVersion,
          bridgeVersion: descriptor.bridgeVersion,
          host: descriptor.host,
          port: descriptor.port,
          editorProcessId: descriptor.editorProcessId,
          sessionStartedAt: descriptor.startedAt,
          connectedAt,
        },
        updatedAt: connectedAt,
      });
      return this.status(id);
    } catch (error: unknown) {
      if (this.processManager.isOwned(task.id, handle.pid)) {
        await this.processManager.stop(task.id, handle.pid).catch(() => undefined);
      }
      await this.store.save({
        ...updated,
        connection: undefined,
        updatedAt: new Date().toISOString(),
      } as unknown as UnityTaskEnvironment);
      throw error;
    }
  }

  async stopEditor(id: string): Promise<UnityTaskEnvironmentStatus> {
    const task = await this.tasks.get(id);
    const environment = await this.requireInstalled(task.id);
    const processId = environment.editorLaunch?.processId;
    if (processId === undefined || !this.processManager.isOwned(task.id, processId)) {
      throw new UnityIntegrationError(
        "EDITOR_NOT_OWNED",
        "UnityAI did not launch this Editor in the current server session and will not stop it.",
      );
    }
    const client = this.clientFactory(environment.projectWorktreePath);
    const ownedProjectPath = this.processManager.projectPath(task.id);
    if (
      ownedProjectPath === undefined ||
      !(await canonicalPathsEqual(ownedProjectPath, environment.projectWorktreePath))
    ) {
      throw new UnityIntegrationError(
        "EDITOR_NOT_OWNED",
        "Owned Editor launch does not match the managed Unity worktree.",
      );
    }
    let ping: UnityBridgePing | undefined;
    try {
      ping = await client.ping();
    } catch (error: unknown) {
      const transientDisconnect =
        error instanceof UnityIntegrationError &&
        (error.code === "UNITY_BRIDGE_NOT_CONNECTED" ||
          error.code === "UNITY_BRIDGE_TIMEOUT");
      if (
        !transientDisconnect ||
        environment.connection?.editorProcessId !== processId
      ) {
        throw error;
      }
      // A live process handle, exact managed path, launch PID, and a previously
      // authenticated matching session still prove ownership during reload.
    }
    if (ping !== undefined) {
      this.assertPingIdentity(environment, ping);
      if (ping.processId !== processId) {
        throw new UnityIntegrationError(
          "EDITOR_NOT_OWNED",
          "Bridge process identity does not match the UnityAI-owned Editor launch.",
        );
      }
    }
    await this.processManager.stop(task.id, processId);
    await rm(client.descriptorPath, { force: true }).catch(() => undefined);
    await this.store.save({
      ...environment,
      editorLaunch: undefined,
      connection: undefined,
      updatedAt: new Date().toISOString(),
    } as unknown as UnityTaskEnvironment);
    return this.status(id);
  }

  async waitForIdle(
    id: string,
    input: { readonly timeoutMs?: number } = {},
    signal?: AbortSignal,
  ): Promise<UnityEditorStatus> {
    const task = await this.tasks.get(id);
    const environment = await this.requireInstalled(task.id);
    const timeoutMs = input.timeoutMs ?? 180_000;
    const deadline = Date.now() + timeoutMs;
    const client = this.clientFactory(environment.projectWorktreePath);
    let lastStatus: UnityEditorStatus | undefined;
    let lastConnectionError: UnityIntegrationError | undefined;
    while (Date.now() < deadline) {
      try {
        lastStatus = await client.editorStatus(signal);
        lastConnectionError = undefined;
        if (!lastStatus.isCompiling && !lastStatus.isUpdating) {
          return lastStatus;
        }
      } catch (error: unknown) {
        if (
          !(error instanceof UnityIntegrationError) ||
          (error.code !== "UNITY_BRIDGE_NOT_CONNECTED" &&
            error.code !== "UNITY_BRIDGE_TIMEOUT")
        ) {
          throw error;
        }
        // Compilation/domain reload temporarily tears down the descriptor and
        // listener. Idle waiting deliberately waits for the matching bridge to
        // reappear instead of treating that expected gap as task failure.
        lastConnectionError = error;
      }
      await sleep(300, signal);
    }
    throw new UnityIntegrationError(
      "UNITY_BRIDGE_TIMEOUT",
      `Unity Editor did not become idle within ${timeoutMs} ms.`,
      {
        lastStatus,
        ...(lastConnectionError === undefined
          ? {}
          : {
              lastConnectionError: {
                code: lastConnectionError.code,
                message: lastConnectionError.message,
              },
            }),
      },
    );
  }

  async removeBridge(id: string): Promise<UnityTaskEnvironmentStatus> {
    const task = await this.tasks.get(id);
    const environment = await this.requireInstalled(task.id);
    const live = await this.status(id);
    if (live.editor === "RUNNING") {
      throw new UnityIntegrationError(
        "UNITY_COMMAND_FAILED",
        "Stop the Unity Editor before removing the managed bridge package.",
      );
    }
    const client = this.clientFactory(environment.projectWorktreePath);
    let possibleLiveProcessId = environment.connection?.editorProcessId;
    try {
      possibleLiveProcessId = (await client.descriptor()).editorProcessId;
    } catch {
      // A missing/invalid descriptor does not prove a process exists. The last
      // authenticated connection PID remains the conservative fallback.
    }
    if (
      possibleLiveProcessId !== undefined &&
      this.processIsAlive(possibleLiveProcessId)
    ) {
      throw new UnityIntegrationError(
        "EDITOR_NOT_OWNED",
        "A Unity Editor process associated with this bridge may still be running; stop it before removing temporary tooling.",
      );
    }
    const { environment: gitEnvironment } = await this.git.getEnvironmentWithStatus(id);
    if (gitEnvironment === undefined) {
      throw new UnityIntegrationError(
        "UNITY_BRIDGE_OWNERSHIP_MISMATCH",
        "Managed Git worktree metadata is unavailable.",
      );
    }
    const packagePath = environment.bridge.packagePath;
    const packageVersion = environment.bridge.packageVersion;
    const sourceFingerprint = environment.bridge.sourceFingerprint;
    if (
      packagePath === undefined ||
      packageVersion === undefined ||
      sourceFingerprint === undefined
    ) {
      throw new UnityIntegrationError(
        "UNITY_BRIDGE_OWNERSHIP_MISMATCH",
        "Persisted bridge ownership metadata is incomplete.",
      );
    }
    await this.installer.remove(task.id, gitEnvironment, {
      packagePath,
      packageVersion,
      sourceFingerprint,
    });
    const removedAt = new Date().toISOString();
    await this.store.save({
      ...environment,
      bridge: {
        installed: false,
        removedAt,
      },
      editorLaunch: undefined,
      connection: undefined,
      updatedAt: removedAt,
    } as unknown as UnityTaskEnvironment);
    const descriptorPath = client.descriptorPath;
    await rm(descriptorPath, { force: true }).catch(() => undefined);
    return this.status(id);
  }

  async clientForTask(id: string): Promise<UnityBridgeClient> {
    const task = await this.tasks.get(id);
    const environment = await this.requireInstalled(task.id);
    return this.clientFactory(environment.projectWorktreePath);
  }

  private async requireInstalled(taskId: TaskId): Promise<UnityTaskEnvironment> {
    const environment = await this.store.get(taskId);
    if (environment === undefined || !environment.bridge.installed) {
      throw new UnityIntegrationError(
        "UNITY_BRIDGE_NOT_INSTALLED",
        `Task ${taskId} does not have a managed Unity bridge installation.`,
      );
    }
    return environment;
  }

  private assertPingIdentity(
    environment: UnityTaskEnvironment,
    ping: UnityBridgePing,
  ): void {
    const expected = resolve(environment.projectWorktreePath);
    const actual = resolve(ping.projectPath);
    const pathMatches = process.platform === "win32"
      ? expected.toLocaleLowerCase("en-US") === actual.toLocaleLowerCase("en-US")
      : expected === actual;
    if (!pathMatches) {
      throw new UnityIntegrationError(
        "UNITY_BRIDGE_NOT_CONNECTED",
        "Connected bridge reports a different project path.",
      );
    }
    if (
      environment.editorLaunch !== undefined &&
      ping.processId !== environment.editorLaunch.processId
    ) {
      throw new UnityIntegrationError(
        "UNITY_BRIDGE_NOT_CONNECTED",
        "Connected bridge process does not match the recorded Editor launch.",
      );
    }
  }

  private async waitForBridge(
    environment: UnityTaskEnvironment,
    exit: Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>,
    signal?: AbortSignal,
  ): Promise<UnityBridgePing> {
    const deadline = Date.now() + this.editorStartTimeoutMs;
    const client = this.clientFactory(environment.projectWorktreePath);
    let exited: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null } | undefined;
    void exit.then((result) => {
      exited = result;
    });
    while (Date.now() < deadline) {
      if (exited !== undefined) {
        throw new UnityIntegrationError(
          "UNITY_EDITOR_EXITED",
          "Unity Editor exited before the bridge became available.",
          exited,
        );
      }
      try {
        return await client.ping(signal);
      } catch (error: unknown) {
        if (
          error instanceof UnityIntegrationError &&
          error.code !== "UNITY_BRIDGE_NOT_CONNECTED" &&
          error.code !== "UNITY_PROJECT_METADATA_INVALID"
        ) {
          throw error;
        }
      }
      await sleep(300, signal);
    }
    throw new UnityIntegrationError(
      "UNITY_BRIDGE_TIMEOUT",
      `Unity bridge did not become available within ${this.editorStartTimeoutMs} ms.`,
    );
  }
}
