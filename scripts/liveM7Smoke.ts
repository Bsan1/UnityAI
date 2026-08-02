import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  beginTaskImplementation,
  buildExecutionRoutingSnapshot,
  completeTaskImplementation,
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
const root = await mkdtemp(join(tmpdir(), "unityai-m7-live-"));
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
    !basename(resolvedRoot).startsWith("unityai-m7-live-")
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
  const createProject = await new SafeProcessRunner().run({
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
  await writeFile(join(projectRoot, "Assets", ".gitkeep"), "", "utf8");
  await writeFile(
    join(projectRoot, ".gitignore"),
    "/[Ll]ibrary/\n/[Tt]emp/\n/[Oo]bj/\n/[Ll]ogs/\n/[Uu]ser[Ss]ettings/\n",
    "utf8",
  );

  const runner = new GitCommandRunner();
  await runner.runChecked(["init"], { cwd: projectRoot });
  await runner.runChecked(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: projectRoot });
  await runner.runChecked(["config", "user.name", "UnityAI Live Smoke"], { cwd: projectRoot });
  await runner.runChecked(["config", "user.email", "unityai-smoke@local"], { cwd: projectRoot });
  await runner.runChecked(["add", "--all"], { cwd: projectRoot });
  await runner.runChecked(["commit", "-m", "Initial disposable Unity project"], { cwd: projectRoot });
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
    title: "Add disposable feature status component",
    originalRequest: "Add a FeatureStatus MonoBehaviour that compiles and can be observed in a Unity Play Mode QA session.",
    targetProjectPath: projectRoot,
    strength: "LIGHT",
    crossReviewEnabled: false,
    automaticFixesEnabled: false,
  });
  taskId = task.id;
  task = await tasks.analyze(task.id);
  task = await tasks.storeFeasibility(task.id, {
    status: "READY",
    summary: "The disposable Unity project supports the requested component.",
    missingCapabilities: [],
  });
  task = await tasks.storeContract(task.id, {
    originalTaskSummary: "Add a disposable FeatureStatus MonoBehaviour.",
    understoodExplicitRequirements: ["Add FeatureStatus as a Unity MonoBehaviour."],
    inferredRequirements: ["The script must compile and the project must enter Play Mode without new errors."],
    prerequisites: [],
    implementationScope: ["Assets/FeatureStatus.cs"],
    nonGoals: ["Do not add player input or gameplay behavior."],
    acceptanceCriteria: [
      "FeatureStatus is a compilable MonoBehaviour.",
      "The project remains stable in Play Mode.",
    ],
    acceptanceCriteriaDetails: [
      {
        id: "AC-001",
        description: "FeatureStatus is a compilable MonoBehaviour.",
        evidenceExpectation: ["Identified Unity compilation records zero errors."],
      },
      {
        id: "AC-002",
        description: "The project remains stable in Play Mode.",
        evidenceExpectation: ["Unity MCP reports Play Mode and no relevant new runtime error."],
      },
    ],
    testRequirements: [
      "STATIC: FeatureStatus.cs defines a scoped Unity MonoBehaviour.",
      "STRUCTURAL: Unity MCP returns a bounded loaded-scene summary.",
      "RUNTIME: Unity MCP confirms Play Mode and no relevant new runtime error.",
    ],
    testRequirementDetails: [
      { id: "TEST-001", category: "STATIC", description: "FeatureStatus.cs defines a scoped Unity MonoBehaviour." },
      { id: "TEST-002", category: "STRUCTURAL", description: "Unity MCP returns a bounded loaded-scene summary." },
      { id: "TEST-003", category: "RUNTIME", description: "Unity MCP confirms Play Mode and no relevant new runtime error." },
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
  await writeFile(
    join(environment.taskWorktreePath, "Assets", "FeatureStatus.cs"),
    "using UnityEngine;\n\npublic sealed class FeatureStatus : MonoBehaviour\n{\n    public string Status => \"ready\";\n}\n",
    "utf8",
  );
  const checkpoint = await git.checkpoint(task.id, { label: "implementation-1" });
  task = completeTaskImplementation(task, {
    runId: "RUN-LIVE-SYNTHETIC-IMPLEMENTATION",
    checkpointId: checkpoint.checkpoint.id,
    checkpointCommit: checkpoint.checkpoint.commit,
    changedFileCount: 1,
    reviewEnabled: false,
  });
  await tasks.saveTask(task);

  const orchestration = new OrchestrationArtifactStore(runtimeRoot);
  await orchestration.initialize();
  await orchestration.saveImplementation(task.id, {
    schemaVersion: 1,
    summary: "Added FeatureStatus MonoBehaviour.",
    changedFiles: ["Assets/FeatureStatus.cs"],
    implementationNotes: ["Disposable live-smoke implementation."],
    sanityChecks: ["Inspected the generated source."],
    warnings: [],
    runId: "RUN-LIVE-SYNTHETIC-IMPLEMENTATION",
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
    displayName: "M7 disposable live smoke",
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
  }, { editorStartTimeoutMs: 300_000 });

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

  await qa.start(task.id);
  const completed = await qa.waitForIdle(task.id);
  const artifacts = await qa.get(task.id);
  assert.equal(completed.state, "COMPLETED");
  assert.equal(artifacts.latestReport?.outcome, "PASS");
  assert.equal(artifacts.latestSession?.summary.gameplayPending, 0);
  assert.ok(artifacts.latestSession?.qaAgentRunId);
  const runId = artifacts.latestSession?.qaAgentRunId ?? "";
  const runDirectory = join(runtimeRoot, "ai", "runs", runId);
  const runText = await recursivelyReadText(runDirectory);
  assert.match(runText, /unity_(?:ping|editor_status|scene_summary|console)/u);
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
  const finalTree = (await runner.runChecked(["ls-tree", "-r", "--name-only", finalized?.finalCommit ?? ""], { cwd: projectRoot })).stdout;
  assert.doesNotMatch(finalTree, /com\.unityai\.editor-bridge/u);
  assert.equal((await unity.status(task.id)).ownedEditor, false);

  console.log(JSON.stringify({
    unityVersion: artifacts.latestSession?.unityEnvironment?.unityVersion,
    bridgeVersion: artifacts.latestSession?.unityEnvironment?.bridgeVersion,
    qaOutcome: artifacts.latestReport?.outcome,
    qaAgentRunId: runId,
    mcpToolEvidenceObserved: true,
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
    console.error(`M7 live smoke retained for diagnosis: ${root}`);
  }
  if (taskId !== undefined && unity !== undefined) {
    const status = await unity.status(taskId).catch(() => undefined);
    if (status?.ownedEditor === true) {
      await unity.stopEditor(taskId).catch(() => undefined);
    }
    if (status?.environment?.bridge.installed === true && status.editor !== "RUNNING") {
      await unity.removeBridge(taskId).catch(() => undefined);
    }
  }
  if (succeeded && taskId !== undefined && git !== undefined) {
    await git.cleanup(taskId, {}).catch(() => undefined);
    await removeSuccessfulFixture();
  }
}
