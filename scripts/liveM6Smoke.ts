import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UnityIntegrationError } from "@unityai/unity";

import { GitCommandRunner } from "../apps/server/src/gitCommandRunner.js";
import { GitEnvironmentStore } from "../apps/server/src/gitEnvironmentStore.js";
import { GitSafetyService } from "../apps/server/src/gitSafetyService.js";
import { ProjectRegistry } from "../apps/server/src/projectRegistry.js";
import { TaskService } from "../apps/server/src/taskService.js";
import { TaskStore } from "../apps/server/src/taskStore.js";
import { UnityEnvironmentService } from "../apps/server/src/unityEnvironmentService.js";
import { UnityEnvironmentStore } from "../apps/server/src/unityEnvironmentStore.js";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const unityExecutable = argument("--unityExecutable");
if (unityExecutable === undefined) {
  throw new Error("--unityExecutable <path> is required.");
}

const workspaceRoot = process.cwd();
const root = await mkdtemp(join(tmpdir(), "unityai-m6-live-"));
const projectRoot = join(root, "project");
const runtimeRoot = join(root, "runtime");
let taskId: string | undefined;
let service: UnityEnvironmentService | undefined;
let git: GitSafetyService | undefined;
let succeeded = false;

const removeSuccessfulFixture = async (): Promise<void> => {
  const resolvedRoot = resolve(root);
  if (
    dirname(resolvedRoot) !== resolve(tmpdir()) ||
    !basename(resolvedRoot).startsWith("unityai-m6-live-")
  ) {
    throw new Error(`Refusing to remove unexpected live-smoke path: ${resolvedRoot}`);
  }
  await rm(resolvedRoot, { recursive: true, force: true });
};

const waitForPlayState = async (
  client: Awaited<ReturnType<UnityEnvironmentService["clientForTask"]>>,
  expected: boolean,
): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await client.editorStatus()).isPlaying === expected) {
        return;
      }
    } catch (error: unknown) {
      if (
        !(error instanceof UnityIntegrationError) ||
        (error.code !== "UNITY_BRIDGE_NOT_CONNECTED" &&
          error.code !== "UNITY_BRIDGE_TIMEOUT")
      ) {
        throw error;
      }
      // Entering/exiting Play Mode may reload the Editor domain and replace
      // the authenticated descriptor before the requested state is visible.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Unity did not reach isPlaying=${String(expected)}.`);
};

try {
  await Promise.all([
    mkdir(join(projectRoot, "Assets"), { recursive: true }),
    mkdir(join(projectRoot, "Packages"), { recursive: true }),
    mkdir(join(projectRoot, "ProjectSettings"), { recursive: true }),
  ]);
  await writeFile(join(projectRoot, "Assets", ".gitkeep"), "", "utf8");
  await writeFile(
    join(projectRoot, "Packages", "manifest.json"),
    `${JSON.stringify({ dependencies: {} }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(projectRoot, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.3.11f1\nm_EditorVersionWithRevision: 6000.3.11f1 (live-smoke)\n",
    "utf8",
  );

  const runner = new GitCommandRunner();
  await runner.runChecked(["init"], { cwd: projectRoot });
  await runner.runChecked(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: projectRoot });
  await runner.runChecked(["config", "user.name", "UnityAI Live Smoke"], { cwd: projectRoot });
  await runner.runChecked(["config", "user.email", "unityai-smoke@local"], { cwd: projectRoot });
  await runner.runChecked(["add", "--all"], { cwd: projectRoot });
  await runner.runChecked(["commit", "-m", "Initial temporary Unity project"], { cwd: projectRoot });
  const originalCommit = (await runner.runChecked(["rev-parse", "HEAD"], { cwd: projectRoot })).stdout.trim();

  const taskStore = new TaskStore(runtimeRoot);
  await taskStore.initialize();
  const tasks = new TaskService(taskStore, {
    crossReviewEnabled: true,
    automaticFixesEnabled: true,
  });
  const task = await tasks.create({
    title: "M6 live bridge smoke",
    originalRequest: "Validate Unity Editor bridge capabilities in a temporary project.",
    targetProjectPath: projectRoot,
    strength: "LIGHT",
  });
  taskId = task.id;
  const gitStore = new GitEnvironmentStore(runtimeRoot);
  await gitStore.initialize();
  git = new GitSafetyService(tasks, gitStore, join(runtimeRoot, "worktrees"), runner);
  const gitEnvironment = await git.prepare(task.id);
  const projects = new ProjectRegistry(runtimeRoot, runner);
  await projects.initialize();
  await projects.create({
    displayName: "M6 live smoke",
    path: projectRoot,
    unityEditorPath: resolve(unityExecutable),
  });
  const unityStore = new UnityEnvironmentStore(runtimeRoot);
  await unityStore.initialize();
  service = new UnityEnvironmentService(
    {
      tasks,
      git,
      projects,
      store: unityStore,
      runtimeRoot,
      bridgeSourcePackagePath: join(
        workspaceRoot,
        "unity",
        "Packages",
        "com.unityai.editor-bridge",
      ),
    },
    { editorStartTimeoutMs: 240_000 },
  );
  const prepared = await service.prepare(task.id);
  assert.equal(prepared.projectWorktreePath, gitEnvironment.taskWorktreePath);
  assert.equal(prepared.bridge.installed, true);
  assert.equal(
    await readFile(join(projectRoot, "Packages", "manifest.json"), "utf8"),
    `${JSON.stringify({ dependencies: {} }, null, 2)}\n`,
  );

  const started = await service.startEditor(task.id);
  assert.equal(started.bridge, "CONNECTED");
  assert.equal(started.ownedEditor, true);
  const client = await service.clientForTask(task.id);
  const ping = await client.ping();
  const initialStatus = await client.editorStatus();
  await service.waitForIdle(task.id, { timeoutMs: 180_000 });
  await client.requestCompilation();
  await service.waitForIdle(task.id, { timeoutMs: 180_000 });
  const consoleResult = await client.console({ limit: 100 });
  const sceneSummary = await client.sceneSummary();
  const hierarchy = await client.sceneHierarchy({ maxDepth: 6, maxObjects: 100 });
  const firstObject = hierarchy.objects[0];
  const objectSnapshot = firstObject === undefined
    ? undefined
    : await client.objectSnapshot({ instanceId: firstObject.instanceId, maxProperties: 50 });

  await client.enterPlayMode();
  await waitForPlayState(client, true);
  const playStatus = await client.editorStatus();
  await client.exitPlayMode();
  await waitForPlayState(client, false);
  const editStatus = await client.editorStatus();

  const mcp = new Client({ name: "unityai-m6-smoke", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(workspaceRoot, "apps", "unity-mcp", "dist", "main.js"),
      "--projectPath",
      gitEnvironment.taskWorktreePath,
    ],
    cwd: workspaceRoot,
    stderr: "pipe",
  });
  await mcp.connect(transport);
  const tools = await mcp.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("unity_ping"));
  assert.ok(toolNames.includes("unity_editor_status"));
  assert.equal(toolNames.some((name) => /csharp|shell|file|arbitrary/u.test(name)), false);
  const mcpPing = await mcp.callTool({ name: "unity_ping", arguments: {} });
  const mcpStatus = await mcp.callTool({ name: "unity_editor_status", arguments: {} });
  assert.equal(mcpPing.isError, undefined);
  assert.equal(mcpStatus.isError, undefined);
  await mcp.close();

  await service.stopEditor(task.id);
  const removed = await service.removeBridge(task.id);
  assert.equal(removed.bridge, "NOT_INSTALLED");
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(gitEnvironment.taskWorktreePath, "Packages", "manifest.json"),
        "utf8",
      ),
    ),
    { dependencies: {} },
  );
  assert.equal(
    (await runner.runChecked(["rev-parse", "main"], { cwd: projectRoot })).stdout.trim(),
    originalCommit,
  );
  assert.equal((await runner.runChecked(["status", "--porcelain"], { cwd: projectRoot })).stdout, "");

  console.log(JSON.stringify({
    unityVersion: ping.unityVersion,
    initialStatus,
    compileIdle: true,
    console: { complete: consoleResult.complete, count: consoleResult.count },
    sceneCount: sceneSummary.scenes.length,
    hierarchyCount: hierarchy.objects.length,
    objectSnapshot: objectSnapshot?.name,
    playModeEntered: playStatus.isPlaying,
    playModeExited: !editStatus.isPlaying,
    mcpTools: toolNames,
    originalCommitUnchanged: true,
    originalWorktreeClean: true,
    bridgeRemoved: true,
  }, null, 2));
  succeeded = true;
} finally {
  if (!succeeded) {
    console.error(`M6 live smoke retained for diagnosis: ${root}`);
  }
  if (taskId !== undefined && service !== undefined) {
    const status = await service.status(taskId).catch(() => undefined);
    if (status?.ownedEditor === true) {
      await service.stopEditor(taskId).catch(() => undefined);
    }
    if (status?.environment?.bridge.installed === true) {
      await service.removeBridge(taskId).catch(() => undefined);
    }
  }
  if (succeeded && taskId !== undefined && git !== undefined) {
    await git.cleanup(taskId, { discardChanges: true }).catch(() => undefined);
    await removeSuccessfulFixture();
  }
}
