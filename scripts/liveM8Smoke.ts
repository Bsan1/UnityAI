import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  beginTaskImplementation,
  beginTaskQA,
  buildExecutionRoutingSnapshot,
  completeTaskImplementation,
  completeTaskQAForGameplay,
} from "@unityai/core";

import { bootstrapAIService } from "../apps/server/src/aiBootstrap.js";
import { loadModelConfiguration } from "../apps/server/src/aiConfig.js";
import { AnalysisArtifactStore } from "../apps/server/src/analysisArtifactStore.js";
import { GitCommandRunner } from "../apps/server/src/gitCommandRunner.js";
import { GitEnvironmentStore } from "../apps/server/src/gitEnvironmentStore.js";
import { GitSafetyService } from "../apps/server/src/gitSafetyService.js";
import { OrchestrationArtifactStore } from "../apps/server/src/orchestrationArtifactStore.js";
import { ProjectRegistry } from "../apps/server/src/projectRegistry.js";
import { SafeProcessRunner } from "../apps/server/src/processRunner.js";
import { QAArtifactStore } from "../apps/server/src/qaArtifactStore.js";
import { QAOrchestrator } from "../apps/server/src/qaOrchestrator.js";
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
const root = await mkdtemp(join(tmpdir(), "unityai-m8-live-"));
const projectRoot = join(root, "project");
const runtimeRoot = join(root, "runtime");
let taskId: string | undefined;
let unity: UnityEnvironmentService | undefined;
let git: GitSafetyService | undefined;
let succeeded = false;

const removeSuccessfulFixture = async (): Promise<void> => {
  const resolvedRoot = resolve(root);
  if (
    dirname(resolvedRoot) !== resolve(tmpdir()) ||
    !basename(resolvedRoot).startsWith("unityai-m8-live-")
  ) {
    throw new Error(`Refusing to remove unexpected live-smoke path: ${resolvedRoot}`);
  }
  await rm(resolvedRoot, { recursive: true, force: true });
};

const recursivelyReadText = async (directory: string): Promise<string> => {
  let text = "";
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      text += await recursivelyReadText(path);
    } else if (entry.isFile()) {
      text += await readFile(path, "utf8").catch(() => "");
    }
  }
  return text;
};

try {
  const processRunner = new SafeProcessRunner();
  const createProject = await processRunner.run({
    executable: resolve(unityExecutable),
    arguments: [
      "-batchmode",
      "-quit",
      "-createProject",
      projectRoot,
      "-logFile",
      join(root, "create-project.log"),
    ],
    workingDirectory: root,
    timeoutMs: 300_000,
    maximumCaptureBytes: 64 * 1024,
  });
  if (createProject.status !== "EXITED" || createProject.exitCode !== 0) {
    throw new Error(`Unity project creation failed: ${createProject.stderr || createProject.status}`);
  }
  const manifestPath = join(projectRoot, "Packages", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  await writeFile(manifestPath, `${JSON.stringify({
    ...manifest,
    dependencies: {
      ...(manifest.dependencies ?? {}),
      "com.unity.inputsystem": "1.17.0",
    },
  }, null, 2)}\n`, "utf8");
  const projectSettingsPath = join(
    projectRoot,
    "ProjectSettings",
    "ProjectSettings.asset",
  );
  const projectSettings = await readFile(projectSettingsPath, "utf8");
  if (!/^\s*activeInputHandler:\s*\d+\s*$/mu.test(projectSettings)) {
    throw new Error("Generated Unity fixture did not expose activeInputHandler.");
  }
  await writeFile(
    projectSettingsPath,
    projectSettings.replace(
      /^(\s*activeInputHandler:)\s*\d+\s*$/mu,
      "$1 1",
    ),
    "utf8",
  );
  await writeFile(join(projectRoot, "Assets", ".gitkeep"), "", "utf8");
  await writeFile(
    join(projectRoot, ".gitignore"),
    "/[Ll]ibrary/\n/[Tt]emp/\n/[Oo]bj/\n/[Ll]ogs/\n/[Uu]ser[Ss]ettings/\n",
    "utf8",
  );
  const resolvePackages = await processRunner.run({
    executable: resolve(unityExecutable),
    arguments: [
      "-batchmode",
      "-quit",
      "-projectPath",
      projectRoot,
      "-logFile",
      join(root, "resolve-packages.log"),
    ],
    workingDirectory: root,
    timeoutMs: 600_000,
    maximumCaptureBytes: 64 * 1024,
  });
  if (resolvePackages.status !== "EXITED" || resolvePackages.exitCode !== 0) {
    throw new Error(`Unity Input System resolution failed: ${resolvePackages.stderr || resolvePackages.status}`);
  }

  const runner = new GitCommandRunner();
  await runner.runChecked(["init"], { cwd: projectRoot });
  await runner.runChecked(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: projectRoot });
  await runner.runChecked(["config", "user.name", "UnityAI M8 Live Smoke"], { cwd: projectRoot });
  await runner.runChecked(["config", "user.email", "unityai-m8-smoke@local"], { cwd: projectRoot });
  await runner.runChecked(["add", "--all"], { cwd: projectRoot });
  await runner.runChecked(["commit", "-m", "Initial disposable Input System project"], { cwd: projectRoot });
  const originalCommit = (await runner.runChecked(["rev-parse", "HEAD"], { cwd: projectRoot })).stdout.trim();

  const taskStore = new TaskStore(runtimeRoot);
  await taskStore.initialize();
  const tasks = new TaskService(taskStore, {
    crossReviewEnabled: false,
    automaticFixesEnabled: false,
  });
  const modelConfiguration = await loadModelConfiguration(join(workspaceRoot, "config", "models.json"));
  const route = buildExecutionRoutingSnapshot(modelConfiguration, "LIGHT", false, true);
  let task = await tasks.create({
    title: "Add Space-bound dash behavior",
    originalRequest: "Add a visible player cube whose real Input System Space binding performs a two-unit dash with a one-second cooldown.",
    targetProjectPath: projectRoot,
    strength: "LIGHT",
    crossReviewEnabled: false,
    automaticFixesEnabled: false,
  });
  taskId = task.id;
  task = await tasks.analyze(task.id);
  task = await tasks.storeFeasibility(task.id, {
    status: "READY",
    summary: "The disposable project has the Unity Input System and supports the requested isolated fixture.",
    missingCapabilities: [],
  });
  task = await tasks.storeContract(task.id, {
    originalTaskSummary: "Add a visible Space-bound dash fixture with a cooldown.",
    understoodExplicitRequirements: [
      "Space drives a visible player dash through the Unity Input System.",
      "An immediate repeated Space press is rejected for one second.",
      "Space works again after the cooldown.",
    ],
    inferredRequirements: ["The behavior is observable through runtime state without directly invoking gameplay methods."],
    prerequisites: ["Unity Input System package"],
    implementationScope: ["Assets/DashPlayer.cs"],
    nonGoals: ["No OS input is required.", "Do not directly invoke Dash or InputAction callbacks during QA."],
    acceptanceCriteria: [
      "Space moves DashPlayer two units and increments dashCount once.",
      "An immediate second Space press is rejected during cooldown.",
      "Dash works again after the cooldown.",
      "The runtime fixture is visibly present.",
    ],
    acceptanceCriteriaDetails: [
      {
        id: "AC-001",
        description: "Space moves DashPlayer two units and increments dashCount once.",
        evidenceExpectation: ["Resolve the Dash binding, send virtual Space, compare Transform.position and dashCount."],
      },
      {
        id: "AC-002",
        description: "An immediate second Space press is rejected during cooldown.",
        evidenceExpectation: ["Send virtual Space again immediately and verify position and dashCount are unchanged."],
      },
      {
        id: "AC-003",
        description: "Dash works again after the cooldown.",
        evidenceExpectation: ["Wait at least 180 unpaused Unity frames, send virtual Space, and verify a second change."],
      },
      {
        id: "AC-004",
        description: "The runtime fixture is visibly present.",
        evidenceExpectation: ["Capture one bounded Game View screenshot in Play Mode."],
      },
    ],
    testRequirements: [
      "STATIC: DashPlayer.cs compiles and remains scoped.",
      "STRUCTURAL: DashPlayer source uses a real <Keyboard>/space InputAction binding.",
      "RUNTIME: DashPlayer exists and is active in Play Mode without new relevant errors.",
      "GAMEPLAY: Virtual Space moves DashPlayer and increments dashCount once.",
      "GAMEPLAY: Immediate repeated virtual Space is rejected during cooldown.",
      "GAMEPLAY: Virtual Space works after cooldown and bounded Game View evidence is captured.",
    ],
    testRequirementDetails: [
      { id: "TEST-001", category: "STATIC", description: "DashPlayer.cs compiles and remains scoped." },
      { id: "TEST-002", category: "STRUCTURAL", description: "DashPlayer source uses a real <Keyboard>/space InputAction binding." },
      { id: "TEST-003", category: "RUNTIME", description: "DashPlayer exists and is active in Play Mode without new relevant errors." },
      { id: "TEST-004", category: "GAMEPLAY", description: "Virtual Space moves DashPlayer and increments dashCount once." },
      { id: "TEST-005", category: "GAMEPLAY", description: "Immediate repeated virtual Space is rejected during cooldown." },
      { id: "TEST-006", category: "GAMEPLAY", description: "Virtual Space works after cooldown and bounded Game View evidence is captured." },
    ],
    taskStrength: "LIGHT",
    executionPlan: route,
  });
  task = await tasks.approve(task.id);

  const gitStore = new GitEnvironmentStore(runtimeRoot);
  await gitStore.initialize();
  git = new GitSafetyService(tasks, gitStore, join(runtimeRoot, "worktrees"), runner);
  const environment = await git.prepare(task.id);
  task = beginTaskImplementation(task, {
    taskBranch: environment.taskBranch,
    worktreePath: environment.taskWorktreePath,
    baseCommit: environment.baseCommit,
  });
  await tasks.saveTask(task);
  await writeFile(join(environment.taskWorktreePath, "Assets", "DashPlayer.cs"), `using UnityEngine;
using UnityEngine.InputSystem;

public sealed class DashPlayer : MonoBehaviour
{
    [SerializeField] private int dashCount;
    [SerializeField] private float lastDashTime = -100f;
    private InputAction dash;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void Bootstrap()
    {
        var player = GameObject.CreatePrimitive(PrimitiveType.Cube);
        player.name = "DashPlayer";
        player.AddComponent<DashPlayer>();
        var cameraObject = new GameObject("GameplayCamera");
        var camera = cameraObject.AddComponent<Camera>();
        cameraObject.transform.position = new Vector3(2f, 3f, -10f);
        cameraObject.transform.LookAt(new Vector3(2f, 0f, 0f));
        var lightObject = new GameObject("GameplayLight");
        lightObject.AddComponent<Light>().type = LightType.Directional;
        lightObject.transform.rotation = Quaternion.Euler(45f, -30f, 0f);
    }

    private void Awake()
    {
        dash = new InputAction("Dash", InputActionType.Button, "<Keyboard>/space");
        dash.performed += OnDash;
        dash.Enable();
    }

    private void OnDash(InputAction.CallbackContext _)
    {
        if (Time.time - lastDashTime < 1f) return;
        lastDashTime = Time.time;
        dashCount++;
        transform.position += Vector3.right * 2f;
    }

    private void OnDestroy()
    {
        dash?.Dispose();
    }
}
`, "utf8");
  const checkpoint = await git.checkpoint(task.id, { label: "implementation-1" });
  task = completeTaskImplementation(task, {
    runId: "RUN-LIVE-M8-SYNTHETIC-IMPLEMENTATION",
    checkpointId: checkpoint.checkpoint.id,
    checkpointCommit: checkpoint.checkpoint.commit,
    changedFileCount: 1,
    reviewEnabled: false,
  });
  task = beginTaskQA(task, { sessionId: "QA-LIVE-M8-PRIOR", cycleNumber: 0 });
  task = completeTaskQAForGameplay(task, { sessionId: "QA-LIVE-M8-PRIOR", gameplayTests: 3 });
  await tasks.saveTask(task);

  const orchestration = new OrchestrationArtifactStore(runtimeRoot);
  await orchestration.initialize();
  await orchestration.saveImplementation(task.id, {
    schemaVersion: 1,
    summary: "Added the disposable Space-bound DashPlayer fixture.",
    changedFiles: ["Assets/DashPlayer.cs"],
    implementationNotes: ["Uses the real Unity Input System binding path."],
    sanityChecks: ["Inspected the generated source."],
    warnings: [],
    runId: "RUN-LIVE-M8-SYNTHETIC-IMPLEMENTATION",
    providerId: route.implementation.providerId,
    modelId: route.implementation.modelId,
    effort: route.implementation.effort,
    status: "SUCCEEDED",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    checkpointId: checkpoint.checkpoint.id,
    checkpointCommit: checkpoint.checkpoint.commit,
  });

  const projects = new ProjectRegistry(runtimeRoot, runner);
  await projects.initialize();
  await projects.create({
    displayName: "M8 disposable live smoke",
    path: projectRoot,
    unityEditorPath: resolve(unityExecutable),
  });
  const unityStore = new UnityEnvironmentStore(runtimeRoot);
  await unityStore.initialize();
  unity = new UnityEnvironmentService({
    tasks,
    git,
    projects,
    store: unityStore,
    runtimeRoot,
    bridgeSourcePackagePath: join(workspaceRoot, "unity", "Packages", "com.unityai.editor-bridge"),
  }, { editorStartTimeoutMs: 600_000 });

  await unity.prepare(task.id);
  await unity.startEditor(task.id);
  await unity.waitForIdle(task.id, { timeoutMs: 300_000 });
  const bridge = await unity.clientForTask(task.id);
  await bridge.enterPlayMode();
  await bridge.waitForPlayModeState(true, { timeoutMs: 120_000, stableForMs: 1_000 });
  const capabilities = await bridge.inputCapabilities();
  assert.equal(capabilities.inputSystemAvailable, true);
  assert.ok(capabilities.virtualDevicesSupported.includes("KEYBOARD"));
  const bindings = await bridge.inputBindings({ action: "Dash", maxBindings: 20 });
  assert.ok(bindings.bindings.some((binding) => binding.effectivePath.toLowerCase() === "<keyboard>/space"));
  const liveHierarchy = await bridge.sceneHierarchy({ maxDepth: 4, maxObjects: 100 });
  const livePlayer = liveHierarchy.objects.find((object) => object.name === "DashPlayer");
  assert.ok(livePlayer);
  const playerSelector = { instanceId: livePlayer.instanceId };
  const before = await bridge.runtimeProbe({ ...playerSelector, componentType: "DashPlayer", propertyPath: "dashCount" });
  const positionBefore = await bridge.runtimeProbe({ ...playerSelector, componentType: "Transform", propertyPath: "position" });
  await bridge.inputAction({ action: "Dash", holdFrames: 2 });
  const afterFirst = await bridge.runtimeProbe({ ...playerSelector, componentType: "DashPlayer", propertyPath: "dashCount" });
  const positionAfterFirst = await bridge.runtimeProbe({ ...playerSelector, componentType: "Transform", propertyPath: "position" });
  await bridge.inputAction({ action: "Dash", holdFrames: 2 });
  const afterImmediate = await bridge.runtimeProbe({ ...playerSelector, componentType: "DashPlayer", propertyPath: "dashCount" });
  await bridge.waitFrames(180);
  await bridge.inputAction({ action: "Dash", holdFrames: 2 });
  const afterCooldown = await bridge.runtimeProbe({ ...playerSelector, componentType: "DashPlayer", propertyPath: "dashCount" });
  assert.equal(Number(before.value), 0);
  assert.equal(Number(afterFirst.value), 1);
  assert.equal(Number(afterImmediate.value), 1);
  assert.equal(Number(afterCooldown.value), 2);
  assert.notEqual(positionAfterFirst.value, positionBefore.value);
  const screenshot = await bridge.gameViewScreenshot({ maxWidth: 640, maxHeight: 360 });
  assert.equal(screenshot.mimeType, "image/png");
  assert.ok(screenshot.byteCount > 0 && screenshot.byteCount <= 2_500_000);
  assert.ok(screenshot.width <= 640 && screenshot.height <= 360);
  assert.match(screenshot.relativePath, /^Library\/UnityAI\/screenshots\//u);
  const released = await bridge.releaseAllInputs();
  assert.ok(released.removedDevices >= 1);
  assert.equal((await bridge.inputCapabilities()).qaOwnedDevices.length, 0);
  await bridge.exitPlayMode();
  await bridge.waitForPlayModeState(false, { timeoutMs: 120_000, stableForMs: 1_000 });
  await writeFile(join(root, "direct-gameplay-evidence.json"), `${JSON.stringify({
    inputSystemVersion: "1.17.0",
    binding: "<Keyboard>/space",
    beforeDashCount: Number(before.value),
    afterFirstDashCount: Number(afterFirst.value),
    immediateSecondDashCount: Number(afterImmediate.value),
    afterCooldownDashCount: Number(afterCooldown.value),
    positionBefore: positionBefore.value,
    positionAfterFirst: positionAfterFirst.value,
    screenshot: {
      evidenceId: screenshot.evidenceId,
      width: screenshot.width,
      height: screenshot.height,
      byteCount: screenshot.byteCount,
      relativePath: screenshot.relativePath,
    },
    inputReleased: true,
    playModeExited: true,
  }, null, 2)}\n`, "utf8");

  const ai = await bootstrapAIService({
    agentsDirectory: join(workspaceRoot, "agents"),
    modelsPath: join(workspaceRoot, "config", "models.json"),
    providersPath: join(workspaceRoot, "config", "providers.json"),
    runtimeRoot,
  });
  const codexAvailability = (await ai.providerAvailability()).find((provider) => provider.providerId === "codex");
  assert.equal(codexAvailability?.status, "AVAILABLE");
  const analysis = new AnalysisArtifactStore(runtimeRoot);
  await analysis.initialize();
  const qaArtifacts = new QAArtifactStore(runtimeRoot);
  await qaArtifacts.initialize();
  const qa = new QAOrchestrator({
    tasks,
    git,
    ai,
    unity,
    analysis,
    orchestration,
    artifacts: qaArtifacts,
  }, {
    unityMcpEntrypoint: join(workspaceRoot, "apps", "unity-mcp", "dist", "main.js"),
    playModeTimeoutMs: 120_000,
    compilationTimeoutMs: 300_000,
  });

  await qa.startGameplay(task.id);
  const completed = await qa.waitForIdle(task.id);
  const artifacts = await qa.get(task.id);
  assert.equal(completed.state, "COMPLETED");
  assert.equal(artifacts.latestReport?.outcome, "PASS");
  assert.equal(artifacts.latestSession?.summary.gameplayPending, 0);
  assert.ok(artifacts.latestSession?.results.filter((result) => result.category === "GAMEPLAY").every((result) => result.status === "PASS"));
  assert.ok(artifacts.latestSession?.results.filter((result) => result.category === "GAMEPLAY").every((result) => result.evidence.length > 0));
  assert.ok(artifacts.latestSession?.qaAgentRunId);
  const runId = artifacts.latestSession?.qaAgentRunId ?? "";
  const runText = await recursivelyReadText(join(runtimeRoot, "ai", "runs", runId));
  assert.match(runText, /unity_(?:input_action|key_press)/u);
  assert.match(runText, /unity_runtime_probe/u);
  assert.match(runText, /unity_game_view_screenshot/u);
  assert.doesNotMatch(
    runText,
    /(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|Authorization\s*:\s*Bearer|\bsk-(?:ant-)?[A-Za-z0-9_-]{8,})/iu,
  );
  const finalized = await git.getEnvironment(task.id);
  assert.equal(finalized?.status, "FINALIZED");
  assert.ok(finalized?.finalCommit);
  assert.equal(
    (await runner.runChecked(["rev-list", "--count", `${originalCommit}..${finalized?.taskBranch}`], { cwd: projectRoot })).stdout.trim(),
    "1",
  );
  assert.equal((await runner.runChecked(["rev-parse", "main"], { cwd: projectRoot })).stdout.trim(), originalCommit);
  assert.equal((await runner.runChecked(["status", "--porcelain"], { cwd: projectRoot })).stdout, "");
  assert.equal((await runner.runChecked(["remote"], { cwd: projectRoot })).stdout.trim(), "");
  await assert.rejects(() => access(join(environment.taskWorktreePath, "Packages", "com.unityai.editor-bridge")));
  await assert.rejects(() => access(join(environment.taskWorktreePath, "Library", "UnityAI", "screenshots")));
  const finalTree = (await runner.runChecked(["ls-tree", "-r", "--name-only", finalized?.finalCommit ?? ""], { cwd: projectRoot })).stdout;
  assert.doesNotMatch(finalTree, /com\.unityai\.editor-bridge|Library\/UnityAI/u);
  assert.equal((await unity.status(task.id)).ownedEditor, false);

  console.log(JSON.stringify({
    unityVersion: artifacts.latestSession?.unityEnvironment?.unityVersion,
    bridgeVersion: artifacts.latestSession?.unityEnvironment?.bridgeVersion,
    inputSystemVersion: "1.17.0",
    directVirtualInputObserved: {
      beforeDashCount: Number(before.value),
      afterFirstDashCount: Number(afterFirst.value),
      immediateSecondDashCount: Number(afterImmediate.value),
      afterCooldownDashCount: Number(afterCooldown.value),
      positionBefore: positionBefore.value,
      positionAfter: positionAfterFirst.value,
    },
    screenshot: {
      evidenceId: screenshot.evidenceId,
      width: screenshot.width,
      height: screenshot.height,
      byteCount: screenshot.byteCount,
      cleanedBeforeFinalization: true,
    },
    qaOutcome: artifacts.latestReport?.outcome,
    qaAgentRunId: runId,
    inputReleased: true,
    playModeExited: true,
    bridgeRemoved: true,
    finalCommit: finalized?.finalCommit,
    finalCommitCountAboveBase: 1,
    originalCommitUnchanged: true,
    originalWorktreeClean: true,
    merged: false,
    pushed: false,
    secretsFound: false,
  }, null, 2));
  succeeded = true;
} finally {
  if (!succeeded) {
    console.error(`M8 live smoke retained for diagnosis: ${root}`);
  }
  if (taskId !== undefined && unity !== undefined) {
    const status = await unity.status(taskId).catch(() => undefined);
    if (status?.bridge === "CONNECTED") {
      const client = await unity.clientForTask(taskId).catch(() => undefined);
      if (client !== undefined) {
        await client.releaseAllInputs().catch(() => undefined);
        await client.exitPlayMode().catch(() => undefined);
      }
    }
    const refreshed = await unity.status(taskId).catch(() => undefined);
    if (refreshed?.ownedEditor === true) {
      await unity.stopEditor(taskId).catch(() => undefined);
    }
    const stopped = await unity.status(taskId).catch(() => undefined);
    if (stopped?.environment?.bridge.installed === true && stopped.editor !== "RUNNING") {
      await unity.removeBridge(taskId).catch(() => undefined);
    }
  }
  if (succeeded && taskId !== undefined && git !== undefined) {
    await git.cleanup(taskId, {}).catch(() => undefined);
    await removeSuccessfulFixture();
  }
}
