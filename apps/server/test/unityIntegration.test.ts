import assert from "node:assert/strict";
import { once } from "node:events";
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { GitTaskEnvironment } from "@unityai/core";
import {
  UnityBridgeClient,
  UnityEditorResolver,
  UnityIntegrationError,
} from "@unityai/unity";
import type {
  UnityBridgePing,
  UnityBridgeSessionDescriptor,
  UnityEditorStatus,
} from "@unityai/unity";

import { createUnityAiServer } from "../src/app.js";
import type { M5ServerServices } from "../src/app.js";
import { ProjectRegistry } from "../src/projectRegistry.js";
import { UnityBridgeInstaller } from "../src/unityBridgeInstaller.js";
import {
  UnityEditorProcessManager,
  buildUnityEditorArguments,
} from "../src/unityEditorProcessManager.js";
import type {
  UnityEditorExit,
  UnityEditorLauncher,
  UnityEditorProcessHandle,
} from "../src/unityEditorProcessManager.js";
import { UnityEnvironmentService } from "../src/unityEnvironmentService.js";
import { UnityEnvironmentStore } from "../src/unityEnvironmentStore.js";
import type { UnityTaskEnvironment } from "../src/unityEnvironmentStore.js";
import {
  createGitTestContext,
  removeTemporaryRoot,
} from "./gitTestHelpers.js";

const roots = new Set<string>();
const bridgeSource = join(
  process.cwd(),
  "unity",
  "Packages",
  "com.unityai.editor-bridge",
);

afterEach(async () => {
  const values = [...roots];
  roots.clear();
  await Promise.all(values.map((root) => removeTemporaryRoot(root)));
});

const missing = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
};

const addUnityFixture = async (context: Awaited<ReturnType<typeof createGitTestContext>>): Promise<void> => {
  await Promise.all([
    mkdir(join(context.repositoryRoot, "Assets")),
    mkdir(join(context.repositoryRoot, "Packages")),
    mkdir(join(context.repositoryRoot, "ProjectSettings")),
  ]);
  await writeFile(
    join(context.repositoryRoot, "Assets", ".gitkeep"),
    "",
    "utf8",
  );
  await writeFile(
    join(context.repositoryRoot, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.3.11f1\nm_EditorVersionWithRevision: 6000.3.11f1 (fixture)\n",
    "utf8",
  );
  await writeFile(
    join(context.repositoryRoot, "Packages", "manifest.json"),
    JSON.stringify({ dependencies: {} }),
    "utf8",
  );
  await context.runner.runChecked(["add", "--all"], { cwd: context.repositoryRoot });
  await context.runner.runChecked(["commit", "-m", "Add Unity fixture"], {
    cwd: context.repositoryRoot,
  });
};

const unityError = (code: string) => (error: unknown): boolean =>
  error instanceof UnityIntegrationError && error.code === code;

test("managed bridge install is isolated, marked, idempotent, and removable without touching original or unrelated packages", async () => {
  const context = await createGitTestContext();
  roots.add(context.root);
  await addUnityFixture(context);
  const environment = await context.gitService.prepare(context.task.id);
  const installer = new UnityBridgeInstaller(bridgeSource);
  const originalBridge = join(
    context.repositoryRoot,
    "Packages",
    "com.unityai.editor-bridge",
  );
  const unrelated = join(environment.taskWorktreePath, "Packages", "unrelated.txt");
  await writeFile(unrelated, "keep", "utf8");

  const installed = await installer.install(context.task.id, environment);
  assert.equal(installed.idempotent, false);
  assert.equal(await missing(originalBridge), true);
  const marker = JSON.parse(
    await readFile(join(installed.packagePath, ".unityai-managed.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(marker.taskId, context.task.id);
  assert.equal(marker.sourceFingerprint, installed.sourceFingerprint);
  assert.equal((await installer.install(context.task.id, environment)).idempotent, true);

  await installer.remove(context.task.id, environment, installed);
  assert.equal(await missing(installed.packagePath), true);
  assert.equal(await readFile(unrelated, "utf8"), "keep");
  assert.equal(await missing(originalBridge), true);
  assert.equal((await context.gitService.status(context.task.id)).branch, environment.taskBranch);
  assert.equal((await context.runner.runChecked(["status", "--porcelain"], { cwd: context.repositoryRoot })).stdout, "");
});

test("bridge conflict and ownership mismatch protections never overwrite or delete unknown content", async (t) => {
  await t.test("pre-existing conflict", async () => {
    const context = await createGitTestContext();
    roots.add(context.root);
    await addUnityFixture(context);
    const environment = await context.gitService.prepare(context.task.id);
    const conflict = join(environment.taskWorktreePath, "Packages", "com.unityai.editor-bridge");
    await mkdir(conflict);
    await writeFile(join(conflict, "user-file.txt"), "user", "utf8");
    await assert.rejects(
      () => new UnityBridgeInstaller(bridgeSource).install(context.task.id, environment),
      unityError("UNITY_BRIDGE_CONFLICT"),
    );
    assert.equal(await readFile(join(conflict, "user-file.txt"), "utf8"), "user");
  });

  await t.test("tampered ownership marker", async () => {
    const context = await createGitTestContext();
    roots.add(context.root);
    await addUnityFixture(context);
    const environment = await context.gitService.prepare(context.task.id);
    const installer = new UnityBridgeInstaller(bridgeSource);
    const installed = await installer.install(context.task.id, environment);
    const markerPath = join(installed.packagePath, ".unityai-managed.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    await writeFile(markerPath, JSON.stringify({ ...marker, taskId: "TASK-9999" }), "utf8");
    await assert.rejects(
      () => installer.remove(context.task.id, environment, installed),
      unityError("UNITY_BRIDGE_OWNERSHIP_MISMATCH"),
    );
    assert.equal(await missing(installed.packagePath), false);
  });

  await t.test("original worktree is rejected even with forged metadata", async () => {
    const context = await createGitTestContext();
    roots.add(context.root);
    await addUnityFixture(context);
    const forged: GitTaskEnvironment = {
      schemaVersion: 1,
      taskId: context.task.id,
      repositoryRoot: context.repositoryRoot,
      originalWorktreePath: context.repositoryRoot,
      gitCommonDirectory: join(context.repositoryRoot, ".git"),
      baseBranch: "main",
      baseCommit: context.baseCommit,
      taskBranch: `ai/${context.task.id}`,
      taskWorktreePath: context.repositoryRoot,
      writeOwnerTaskId: context.task.id,
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
      checkpoints: [],
    };
    await assert.rejects(
      () => new UnityBridgeInstaller(bridgeSource).install(context.task.id, forged),
      unityError("UNITY_BRIDGE_OWNERSHIP_MISMATCH"),
    );
    assert.equal(
      await missing(join(context.repositoryRoot, "Packages", "com.unityai.editor-bridge")),
      true,
    );
  });
});

test("M2 checkpoint staging excludes temporary bridge package and generated package meta", async () => {
  const context = await createGitTestContext();
  roots.add(context.root);
  await addUnityFixture(context);
  const environment = await context.gitService.prepare(context.task.id);
  const installer = new UnityBridgeInstaller(bridgeSource);
  const installed = await installer.install(context.task.id, environment);
  await writeFile(`${installed.packagePath}.meta`, "fileFormatVersion: 2\n", "utf8");
  await writeFile(join(environment.taskWorktreePath, "feature.txt"), "product change\n", "utf8");
  const checkpoint = await context.gitService.checkpoint(context.task.id, { label: "with-unity-tooling" });
  const committed = (
    await context.runner.runChecked(
      ["show", "--pretty=format:", "--name-only", checkpoint.checkpoint.commit],
      { cwd: environment.taskWorktreePath },
    )
  ).stdout;
  assert.match(committed, /feature\.txt/u);
  assert.doesNotMatch(committed, /com\.unityai\.editor-bridge/u);
  const status = await context.gitService.status(context.task.id);
  assert.ok(status.untrackedFiles.some((path) => path.startsWith("Packages/com.unityai.editor-bridge")));
  assert.equal((await context.runner.runChecked(["status", "--porcelain"], { cwd: context.repositoryRoot })).stdout, "");
});

test("Unity environment JSON validates, persists, reloads, and rejects corruption", async () => {
  const context = await createGitTestContext();
  roots.add(context.root);
  const store = new UnityEnvironmentStore(context.runtimeRoot);
  await store.initialize();
  const timestamp = new Date().toISOString();
  const environment: UnityTaskEnvironment = {
    schemaVersion: 1,
    taskId: context.task.id,
    projectWorktreePath: join(context.runtimeRoot, "worktrees", context.task.id),
    unityVersion: "6000.3.11f1",
    editorExecutablePath: "C:/Unity/Editor/Unity.exe",
    editorResolutionMethod: "EXPLICIT_OVERRIDE",
    bridge: {
      installed: true,
      packagePath: "C:/worktree/Packages/com.unityai.editor-bridge",
      packageVersion: "0.1.0",
      sourceFingerprint: "sha256:fixture",
      installedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await store.save(environment);
  assert.deepEqual(await new UnityEnvironmentStore(context.runtimeRoot).get(context.task.id), environment);
  await writeFile(
    join(context.runtimeRoot, "tasks", context.task.id, "unity.json"),
    "{\"schemaVersion\":1}",
    "utf8",
  );
  await assert.rejects(
    () => store.get(context.task.id),
    (error: unknown) => error instanceof Error && /Could not read or validate Unity metadata/u.test(error.message),
  );
});

class FakeLauncher implements UnityEditorLauncher {
  readonly calls: Array<{ readonly executablePath: string; readonly args: readonly string[]; readonly logPath: string }> = [];
  readonly pid: number;
  terminated = false;
  private resolveExit: ((value: UnityEditorExit) => void) | undefined;

  constructor(pid = 4242) {
    this.pid = pid;
  }

  async launch(input: {
    readonly executablePath: string;
    readonly args: readonly string[];
    readonly logPath: string;
  }): Promise<UnityEditorProcessHandle> {
    this.calls.push(input);
    const exit = new Promise<UnityEditorExit>((resolvePromise) => {
      this.resolveExit = resolvePromise;
    });
    return {
      pid: this.pid,
      exit,
      terminate: async () => {
        this.terminated = true;
        this.resolveExit?.({ exitCode: 0, signal: null });
      },
    };
  }
}

test("Unity Editor launcher uses executable plus argument array, targets managed worktree, and stops only owned PIDs", async () => {
  const launcher = new FakeLauncher();
  const manager = new UnityEditorProcessManager(launcher);
  const handle = await manager.start({
    taskId: "TASK-0001",
    executablePath: "C:/Unity/Editor/Unity.exe",
    projectPath: "C:/managed/TASK-0001",
    logPath: "C:/runtime/editor.log",
  });
  assert.equal(handle.pid, 4242);
  assert.deepEqual(
    launcher.calls[0]?.args,
    buildUnityEditorArguments("C:/managed/TASK-0001", "C:/runtime/editor.log"),
  );
  assert.deepEqual(launcher.calls[0]?.args.slice(0, 2), ["-projectPath", join("C:/managed/TASK-0001")]);
  await assert.rejects(() => manager.stop("TASK-0001", 9999), unityError("EDITOR_NOT_OWNED"));
  assert.equal(launcher.terminated, false);
  await manager.stop("TASK-0001", 4242);
  assert.equal(launcher.terminated, true);
  await assert.rejects(() => manager.stop("TASK-0001", 4242), unityError("EDITOR_NOT_OWNED"));
});

interface ServiceHarness {
  readonly context: Awaited<ReturnType<typeof createGitTestContext>>;
  readonly projects: ProjectRegistry;
  readonly store: UnityEnvironmentStore;
  readonly service: UnityEnvironmentService;
  readonly launcher: FakeLauncher;
  readonly ping: UnityBridgePing;
  readonly descriptor: UnityBridgeSessionDescriptor;
}

const createServiceHarness = async (): Promise<ServiceHarness> => {
  const context = await createGitTestContext();
  roots.add(context.root);
  await addUnityFixture(context);
  await context.gitService.prepare(context.task.id);
  const editorPath = join(context.root, "Unity.exe");
  await writeFile(editorPath, "fake editor", "utf8");
  const projects = new ProjectRegistry(context.runtimeRoot, context.runner);
  await projects.initialize();
  await projects.create({
    displayName: "Unity fixture",
    path: context.repositoryRoot,
    unityEditorPath: editorPath,
  });
  const store = new UnityEnvironmentStore(context.runtimeRoot);
  await store.initialize();
  const launcher = new FakeLauncher(5252);
  const manager = new UnityEditorProcessManager(launcher);
  const worktree = (await context.gitService.getEnvironment(context.task.id))?.taskWorktreePath;
  if (worktree === undefined) {
    throw new Error("Expected managed worktree.");
  }
  const descriptor: UnityBridgeSessionDescriptor = {
    protocolVersion: 1,
    bridgeVersion: "0.1.0",
    projectRoot: worktree,
    unityVersion: "6000.3.11f1",
    editorProcessId: 5252,
    host: "127.0.0.1",
    port: 45678,
    sessionToken: "t".repeat(48),
    startedAt: new Date().toISOString(),
  };
  const ping: UnityBridgePing = {
    protocolVersion: 1,
    bridgeVersion: "0.1.0",
    unityVersion: "6000.3.11f1",
    projectPath: worktree,
    processId: 5252,
  };
  const editorStatus: UnityEditorStatus = {
    isPlaying: false,
    isPaused: false,
    isCompiling: false,
    isUpdating: false,
    activeScene: "SampleScene",
    activePlatform: "StandaloneWindows64",
  };
  const client = {
    descriptorPath: join(worktree, "Library", "UnityAI", "bridge-session.json"),
    descriptor: async () => descriptor,
    ping: async () => {
      if (launcher.calls.length === 0 || launcher.terminated) {
        throw new UnityIntegrationError("UNITY_BRIDGE_NOT_CONNECTED", "fixture stopped");
      }
      return ping;
    },
    editorStatus: async () => {
      if (launcher.calls.length === 0 || launcher.terminated) {
        throw new UnityIntegrationError("UNITY_BRIDGE_NOT_CONNECTED", "fixture stopped");
      }
      return editorStatus;
    },
  } as unknown as UnityBridgeClient;
  const service = new UnityEnvironmentService(
    {
      tasks: context.taskService,
      git: context.gitService,
      projects,
      store,
      runtimeRoot: context.runtimeRoot,
      bridgeSourcePackagePath: bridgeSource,
    },
    {
      resolver: new UnityEditorResolver({ platform: "win32", searchRoots: [] }),
      processManager: manager,
      clientFactory: () => client,
      processIsAlive: () => false,
      editorStartTimeoutMs: 1_000,
    },
  );
  return { context, projects, store, service, launcher, ping, descriptor };
};

test("prepareUnityEnvironment uses managed worktree, project override, persists metadata, and protects original", async () => {
  const harness = await createServiceHarness();
  const prepared = await harness.service.prepare(harness.context.task.id);
  assert.equal(prepared.projectWorktreePath, harness.ping.projectPath);
  assert.equal(prepared.editorResolutionMethod, "EXPLICIT_OVERRIDE");
  assert.equal(prepared.bridge.installed, true);
  assert.equal(
    await missing(join(harness.context.repositoryRoot, "Packages", "com.unityai.editor-bridge")),
    true,
  );
  assert.deepEqual(await harness.store.get(harness.context.task.id), prepared);
  const projectInspection = await harness.service.inspectProject(harness.projects.list()[0]?.id ?? "");
  assert.equal(projectInspection.metadata.unityVersion, "6000.3.11f1");
  assert.equal(projectInspection.editor.found, true);
});

test("owned Editor lifecycle connects by matching PID/project, waits idle, stops safely, and removal is scoped", async () => {
  const harness = await createServiceHarness();
  await harness.service.prepare(harness.context.task.id);
  const started = await harness.service.startEditor(harness.context.task.id);
  assert.equal(started.bridge, "CONNECTED");
  assert.equal(started.ownedEditor, true);
  assert.equal(harness.launcher.calls.length, 1);
  assert.equal(harness.launcher.calls[0]?.args[1], harness.ping.projectPath);
  assert.equal((await harness.service.waitForIdle(harness.context.task.id)).isCompiling, false);
  await assert.rejects(
    () => harness.service.removeBridge(harness.context.task.id),
    unityError("UNITY_COMMAND_FAILED"),
  );
  const persisted = await readFile(
    join(harness.context.runtimeRoot, "tasks", harness.context.task.id, "unity.json"),
    "utf8",
  );
  assert.doesNotMatch(persisted, /sessionToken|"token"/u);
  const stopped = await harness.service.stopEditor(harness.context.task.id);
  assert.equal(stopped.editor, "DISCONNECTED");
  assert.equal(harness.launcher.terminated, true);
  const removed = await harness.service.removeBridge(harness.context.task.id);
  assert.equal(removed.bridge, "NOT_INSTALLED");
  assert.equal(
    await missing(join(harness.context.repositoryRoot, "Packages", "com.unityai.editor-bridge")),
    true,
  );
});

test("Editor startup tolerates a transient bridge request timeout during initial Unity import", async () => {
  const harness = await createServiceHarness();
  await harness.service.prepare(harness.context.task.id);
  const launcher = new FakeLauncher(5252);
  const manager = new UnityEditorProcessManager(launcher);
  let launchedPingCalls = 0;
  const service = new UnityEnvironmentService(
    {
      tasks: harness.context.taskService,
      git: harness.context.gitService,
      projects: harness.projects,
      store: harness.store,
      runtimeRoot: harness.context.runtimeRoot,
      bridgeSourcePackagePath: bridgeSource,
    },
    {
      resolver: new UnityEditorResolver({ platform: "win32", searchRoots: [] }),
      processManager: manager,
      processIsAlive: () => false,
      editorStartTimeoutMs: 2_000,
      clientFactory: () => ({
        descriptorPath: join(
          harness.ping.projectPath,
          "Library",
          "UnityAI",
          "bridge-session.json",
        ),
        descriptor: async () => harness.descriptor,
        ping: async () => {
          if (launcher.calls.length === 0) {
            throw new UnityIntegrationError(
              "UNITY_BRIDGE_NOT_CONNECTED",
              "Editor has not started.",
            );
          }
          launchedPingCalls += 1;
          if (launchedPingCalls === 1) {
            throw new UnityIntegrationError(
              "UNITY_BRIDGE_TIMEOUT",
              "Unity main thread is busy importing packages.",
            );
          }
          return harness.ping;
        },
        editorStatus: async () => ({
          isPlaying: false,
          isPaused: false,
          isCompiling: false,
          isUpdating: false,
          activeScene: "SampleScene",
          activePlatform: "StandaloneWindows64",
        }),
      }) as unknown as UnityBridgeClient,
    },
  );

  const started = await service.startEditor(harness.context.task.id);
  assert.equal(started.bridge, "CONNECTED");
  assert.equal(started.ownedEditor, true);
  assert.ok(launchedPingCalls >= 2);
  await service.stopEditor(harness.context.task.id);
});

test("restart-like service instance revalidates bridge but refuses to kill an Editor it does not own", async () => {
  const harness = await createServiceHarness();
  await harness.service.prepare(harness.context.task.id);
  await harness.service.startEditor(harness.context.task.id);
  const restarted = new UnityEnvironmentService(
    {
      tasks: harness.context.taskService,
      git: harness.context.gitService,
      projects: harness.projects,
      store: harness.store,
      runtimeRoot: harness.context.runtimeRoot,
      bridgeSourcePackagePath: bridgeSource,
    },
    {
      resolver: new UnityEditorResolver({ platform: "win32", searchRoots: [] }),
      processManager: new UnityEditorProcessManager(new FakeLauncher(5252)),
      clientFactory: () => ({
        ping: async () => harness.ping,
        editorStatus: async () => ({
          isPlaying: false,
          isPaused: false,
          isCompiling: false,
          isUpdating: false,
          activeScene: "SampleScene",
          activePlatform: "StandaloneWindows64",
        }),
      }) as unknown as UnityBridgeClient,
    },
  );
  const status = await restarted.status(harness.context.task.id);
  assert.equal(status.bridge, "CONNECTED");
  assert.equal(status.ownedEditor, false);
  await assert.rejects(
    () => restarted.stopEditor(harness.context.task.id),
    unityError("EDITOR_NOT_OWNED"),
  );
});

test("start reuses a matching manually connected Editor without claiming or replacing it", async () => {
  const harness = await createServiceHarness();
  await harness.service.prepare(harness.context.task.id);
  const externalLauncher = new FakeLauncher(6262);
  const externalService = new UnityEnvironmentService(
    {
      tasks: harness.context.taskService,
      git: harness.context.gitService,
      projects: harness.projects,
      store: harness.store,
      runtimeRoot: harness.context.runtimeRoot,
      bridgeSourcePackagePath: bridgeSource,
    },
    {
      resolver: new UnityEditorResolver({ platform: "win32", searchRoots: [] }),
      processManager: new UnityEditorProcessManager(externalLauncher),
      clientFactory: () => ({
        descriptorPath: join(harness.ping.projectPath, "Library", "UnityAI", "bridge-session.json"),
        ping: async () => harness.ping,
        editorStatus: async () => ({
          isPlaying: false,
          isPaused: false,
          isCompiling: false,
          isUpdating: false,
          activeScene: "SampleScene",
          activePlatform: "StandaloneWindows64",
        }),
      }) as unknown as UnityBridgeClient,
    },
  );
  const status = await externalService.startEditor(harness.context.task.id);
  assert.equal(status.bridge, "CONNECTED");
  assert.equal(status.ownedEditor, false);
  assert.equal(externalLauncher.calls.length, 0);
  await assert.rejects(
    () => externalService.stopEditor(harness.context.task.id),
    unityError("EDITOR_NOT_OWNED"),
  );
});

test("waitForUnityIdle tolerates the transient bridge gap caused by script compilation reload", async () => {
  const harness = await createServiceHarness();
  await harness.service.prepare(harness.context.task.id);
  let calls = 0;
  const reloadingService = new UnityEnvironmentService(
    {
      tasks: harness.context.taskService,
      git: harness.context.gitService,
      projects: harness.projects,
      store: harness.store,
      runtimeRoot: harness.context.runtimeRoot,
      bridgeSourcePackagePath: bridgeSource,
    },
    {
      resolver: new UnityEditorResolver({ platform: "win32", searchRoots: [] }),
      clientFactory: () => ({
        editorStatus: async () => {
          calls += 1;
          if (calls === 1) {
            throw new UnityIntegrationError(
              "UNITY_BRIDGE_NOT_CONNECTED",
              "domain reload",
            );
          }
          return {
            isPlaying: false,
            isPaused: false,
            isCompiling: false,
            isUpdating: false,
            activeScene: "SampleScene",
            activePlatform: "StandaloneWindows64",
          };
        },
      }) as unknown as UnityBridgeClient,
    },
  );
  assert.equal(
    (await reloadingService.waitForIdle(harness.context.task.id, { timeoutMs: 2_000 })).isCompiling,
    false,
  );
  assert.equal(calls, 2);
});

test("M6 HTTP exposes project inspection and task Unity preparation/status without generic RPC", async () => {
  const harness = await createServiceHarness();
  const m5 = {
    projects: harness.projects,
    unity: harness.service,
  } as unknown as M5ServerServices;
  const server = createUnityAiServer(
    harness.context.taskService,
    harness.context.gitService,
    undefined,
    undefined,
    m5,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected HTTP address.");
  }
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const projectId = harness.projects.list()[0]?.id;
    assert.ok(projectId);
    const inspection = await fetch(`${base}/projects/${projectId}/unity`);
    assert.equal(inspection.status, 200);
    assert.equal((await inspection.json() as { metadata: { unityVersion: string } }).metadata.unityVersion, "6000.3.11f1");
    const prepared = await fetch(`${base}/tasks/${harness.context.task.id}/unity`, { method: "POST" });
    assert.equal(prepared.status, 200);
    const status = await fetch(`${base}/tasks/${harness.context.task.id}/unity`);
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { bridge: string }).bridge, "INSTALLED");
    const arbitrary = await fetch(`${base}/tasks/${harness.context.task.id}/unity/execute-anything`, { method: "POST" });
    assert.equal(arbitrary.status, 404);
  } finally {
    server.close();
    await once(server, "close");
  }
});
