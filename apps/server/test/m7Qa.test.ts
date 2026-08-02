import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  beginTaskImplementation,
  beginTaskQA,
  buildExecutionRoutingSnapshot,
  completeTaskImplementation,
} from "@unityai/core";
import type {
  JsonValue,
  ModelConfiguration,
  QAAgentFinding,
  QAAgentOutput,
  QAAgentTestResult,
  QASession,
  Task,
  TaskSettings,
} from "@unityai/core";
import { UnityIntegrationError } from "@unityai/unity";
import type {
  UnityBridgeClient,
  UnityConsoleEntry,
  UnityEditorStatus,
} from "@unityai/unity";

import { AgentExecutor } from "../src/agentExecutor.js";
import { AgentRegistry } from "../src/agentRegistry.js";
import { loadModelConfiguration } from "../src/aiConfig.js";
import type {
  AIProvider,
  ProviderAvailability,
  ProviderExecutionRequest,
  ProviderExecutionResult,
} from "../src/aiProvider.js";
import { AIService } from "../src/aiService.js";
import { AnalysisArtifactStore } from "../src/analysisArtifactStore.js";
import { createUnityAiServer } from "../src/app.js";
import type { M5ServerServices } from "../src/app.js";
import { ExecutionArtifactStore } from "../src/executionArtifactStore.js";
import { GitEnvironmentStore } from "../src/gitEnvironmentStore.js";
import { GitSafetyService } from "../src/gitSafetyService.js";
import { ModelRegistry } from "../src/modelRegistry.js";
import { OrchestrationArtifactStore } from "../src/orchestrationArtifactStore.js";
import { ProviderRegistry } from "../src/providerRegistry.js";
import { QAArtifactStore } from "../src/qaArtifactStore.js";
import { AUTOMATIC_FIX_CYCLE_LIMIT, QAOrchestrator } from "../src/qaOrchestrator.js";
import { TaskService } from "../src/taskService.js";
import { TaskStore } from "../src/taskStore.js";
import type { UnityEnvironmentService } from "../src/unityEnvironmentService.js";
import type { UnityTaskEnvironment } from "../src/unityEnvironmentStore.js";
import {
  createTemporaryRoot,
  initializeRepository,
  removeTemporaryRoot,
} from "./gitTestHelpers.js";

const roots = new Set<string>();

afterEach(async () => {
  const values = [...roots];
  roots.clear();
  await Promise.all(values.map(removeTemporaryRoot));
});

const settings: TaskSettings = {
  crossReviewEnabled: false,
  automaticFixesEnabled: true,
};

interface ProviderFailureOutput {
  readonly failure: true;
  readonly status: "FAILED" | "CANCELLED" | "TIMED_OUT";
  readonly code: "PROVIDER_EXIT_FAILURE" | "EXECUTION_CANCELLED" | "EXECUTION_TIMEOUT";
  readonly message: string;
}

type ProviderOutput = JsonValue | QAAgentOutput | ProviderFailureOutput;
type ProviderHandler = (request: ProviderExecutionRequest) => Promise<ProviderOutput>;

const isProviderFailure = (value: ProviderOutput): value is ProviderFailureOutput =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  "failure" in value && value.failure === true;

class ScenarioProvider implements AIProvider {
  readonly id = "codex";
  readonly requests: ProviderExecutionRequest[] = [];
  private readonly handler: ProviderHandler;

  constructor(handler: ProviderHandler) {
    this.handler = handler;
  }

  async availability(): Promise<ProviderAvailability> {
    return {
      providerId: this.id,
      status: "AVAILABLE",
      cliAvailable: true,
      authentication: "AUTHENTICATED",
      message: "Fake Codex is available.",
    };
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
    this.requests.push(request);
    const output = await this.handler(request);
    const timestamp = new Date().toISOString();
    if (isProviderFailure(output)) {
      return {
        providerId: this.id,
        status: output.status,
        stdout: "",
        stderr: output.message,
        stdoutTruncated: false,
        stderrTruncated: false,
        startedAt: timestamp,
        finishedAt: timestamp,
        durationMs: 0,
        failure: { code: output.code, message: output.message },
      };
    }
    const structuredOutput = JSON.parse(JSON.stringify(output)) as JsonValue;
    return {
      providerId: this.id,
      status: "SUCCEEDED",
      finalOutput: JSON.stringify(structuredOutput),
      structuredOutput,
      stdout: JSON.stringify(structuredOutput),
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
      startedAt: timestamp,
      finishedAt: timestamp,
      durationMs: 0,
    };
  }
}

interface FakeUnityOptions {
  readonly compileErrors?: boolean | (() => boolean);
  readonly disconnect?: boolean;
  readonly gameplayDisconnect?: boolean;
  readonly removalFails?: boolean;
}

class FakeUnityEnvironment {
  readonly client: UnityBridgeClient;
  installed = false;
  running = false;
  playing = false;
  compilationRequests = 0;
  enterCalls = 0;
  exitCalls = 0;
  stopCalls = 0;
  removeCalls = 0;
  releaseInputCalls = 0;
  inputCapabilityCalls = 0;
  bindingCalls = 0;
  frameCount = 0;
  private readonly taskId: string;
  private readonly worktree: string;
  private readonly options: FakeUnityOptions;

  constructor(taskId: string, worktree: string, options: FakeUnityOptions = {}) {
    this.taskId = taskId;
    this.worktree = worktree;
    this.options = options;
    const status = (): UnityEditorStatus => ({
      isPlaying: this.playing,
      isPaused: false,
      isCompiling: false,
      isUpdating: false,
      activeScene: "SampleScene",
      activePlatform: "StandaloneWindows64",
      frameCount: this.playing ? ++this.frameCount : this.frameCount,
      ...(this.compilationRequests === 0
        ? {}
        : {
            lastCompilation: {
              requestId: `compile-${this.compilationRequests}`,
              requestedAt: new Date().toISOString(),
              completed: true,
              completedAt: new Date().toISOString(),
              errorCount: this.hasCompileErrors() ? 1 : 0,
              warningCount: 0,
              messagesTruncated: false,
              messages: this.hasCompileErrors()
                ? [{
                    severity: "error" as const,
                    message: "fixture compile failure",
                    file: "Assets/Feature.cs",
                    line: 1,
                    column: 1,
                  }]
                : [],
            },
          }),
    });
    this.client = {
      editorStatus: async () => {
        this.assertConnected();
        return status();
      },
      console: async () => {
        this.assertConnected();
        const entries: UnityConsoleEntry[] = this.hasCompileErrors()
          ? Array.from({ length: this.compilationRequests }, (_, index) => ({
              severity: "Error",
              message: `Assets/Feature.cs(1,1): error CS100${index}: fixture compile failure`,
              stackTrace: "",
              timestamp: new Date().toISOString(),
              sequence: index + 1,
            }))
          : [];
        return {
          complete: true,
          offset: 0,
          count: entries.length,
          totalAvailable: entries.length,
          entries,
        };
      },
      requestCompilation: async () => {
        this.assertConnected();
        this.compilationRequests += 1;
        return { requested: true, requestId: `compile-${this.compilationRequests}` };
      },
      sceneSummary: async () => {
        this.assertConnected();
        return {
          activeScene: "SampleScene",
          scenes: [{
            name: "SampleScene",
            path: "Assets/SampleScene.unity",
            isLoaded: true,
            isDirty: false,
            rootCount: 1,
          }],
        };
      },
      sceneHierarchy: async () => {
        this.assertConnected();
        return {
          offset: 0,
          count: 1,
          maxDepth: 6,
          hasMore: false,
          objects: [{
            instanceId: 1,
            hierarchyPath: "FeatureObject",
            name: "FeatureObject",
            activeSelf: true,
            activeInHierarchy: true,
            tag: "Untagged",
            layer: 0,
            transform: {
              position: [0, 0, 0],
              localPosition: [0, 0, 0],
              rotationEuler: [0, 0, 0],
              localScale: [1, 1, 1],
            },
            componentTypeNames: ["Transform", "Feature"],
          }],
        };
      },
      enterPlayMode: async () => {
        this.assertConnected();
        this.enterCalls += 1;
        this.playing = true;
        return { requested: true };
      },
      exitPlayMode: async () => {
        this.assertConnected();
        this.exitCalls += 1;
        this.playing = false;
        return { requested: true };
      },
      inputCapabilities: async () => {
        this.assertConnected();
        this.inputCapabilityCalls += 1;
        if (this.options.gameplayDisconnect) {
          throw new UnityIntegrationError("UNITY_BRIDGE_NOT_CONNECTED", "Gameplay input bridge disconnected.");
        }
        return {
          inputSystemAvailable: true,
          legacyInputAvailable: false,
          activeInputHandling: "NEW",
          virtualDevicesSupported: ["KEYBOARD", "MOUSE", "GAMEPAD"],
          qaOwnedDevices: [],
          osFallback: "ORCHESTRATOR_ONLY",
        };
      },
      inputBindings: async () => {
        this.assertConnected();
        this.bindingCalls += 1;
        return {
          complete: true,
          count: 1,
          hasMore: false,
          bindings: [{
            actionMap: "Player",
            action: "Dash",
            enabled: true,
            bindingName: "",
            path: "<Keyboard>/space",
            effectivePath: "<Keyboard>/space",
            groups: "Keyboard",
            isComposite: false,
            isPartOfComposite: false,
          }],
        };
      },
      releaseAllInputs: async () => {
        this.releaseInputCalls += 1;
        return { releasedControls: 1, removedDevices: 1, frameCount: this.frameCount };
      },
    } as unknown as UnityBridgeClient;
  }

  async prepare(): Promise<UnityTaskEnvironment> {
    const packagePath = join(this.worktree, "Packages", "com.unityai.editor-bridge");
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, ".unityai-managed.json"), JSON.stringify({ taskId: this.taskId }), "utf8");
    this.installed = true;
    const timestamp = new Date().toISOString();
    return {
      schemaVersion: 1,
      taskId: this.taskId as `TASK-${string}`,
      projectWorktreePath: this.worktree,
      unityVersion: "6000.3.11f1",
      editorExecutablePath: "C:/Fake/Unity.exe",
      editorResolutionMethod: "EXPLICIT_OVERRIDE",
      bridge: {
        installed: true,
        packagePath,
        packageVersion: "0.2.0",
        sourceFingerprint: "fixture",
        installedAt: timestamp,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  async status() {
    return {
      environment: this.installed ? await this.prepareWithoutWriting() : undefined,
      bridge: this.installed ? this.running && !this.options.disconnect ? "CONNECTED" : "INSTALLED" : "NOT_INSTALLED",
      editor: this.running ? "RUNNING" : "DISCONNECTED",
      ownedEditor: this.running,
      ...(this.running && !this.options.disconnect
        ? { editorStatus: await this.client.editorStatus() }
        : {}),
      ...(this.options.disconnect
        ? { diagnostic: { code: "UNITY_BRIDGE_NOT_CONNECTED", message: "Fake bridge disconnected." } }
        : {}),
    } as const;
  }

  async startEditor() {
    this.running = true;
    return this.status();
  }

  async waitForIdle() {
    this.assertConnected();
    return this.client.editorStatus();
  }

  async clientForTask(): Promise<UnityBridgeClient> {
    this.assertConnected();
    return this.client;
  }

  async stopEditor() {
    this.stopCalls += 1;
    this.running = false;
    this.playing = false;
    return this.status();
  }

  async removeBridge() {
    this.removeCalls += 1;
    if (this.options.removalFails) {
      throw new UnityIntegrationError("UNITY_BRIDGE_OWNERSHIP_MISMATCH", "Fixture ownership mismatch.");
    }
    await rm(join(this.worktree, "Packages", "com.unityai.editor-bridge"), {
      recursive: true,
      force: true,
    });
    this.installed = false;
    return this.status();
  }

  private async prepareWithoutWriting(): Promise<UnityTaskEnvironment> {
    const timestamp = new Date().toISOString();
    return {
      schemaVersion: 1,
      taskId: this.taskId as `TASK-${string}`,
      projectWorktreePath: this.worktree,
      unityVersion: "6000.3.11f1",
      editorExecutablePath: "C:/Fake/Unity.exe",
      editorResolutionMethod: "EXPLICIT_OVERRIDE",
      bridge: {
        installed: true,
        packagePath: join(this.worktree, "Packages", "com.unityai.editor-bridge"),
        packageVersion: "0.2.0",
        sourceFingerprint: "fixture",
        installedAt: timestamp,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private assertConnected(): void {
    if (!this.running || this.options.disconnect) {
      throw new UnityIntegrationError("UNITY_BRIDGE_NOT_CONNECTED", "Fake bridge disconnected.");
    }
  }

  private hasCompileErrors(): boolean {
    return typeof this.options.compileErrors === "function"
      ? this.options.compileErrors()
      : this.options.compileErrors === true;
  }
}

interface Harness {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly baseCommit: string;
  readonly runtimeRoot: string;
  readonly task: Task;
  readonly tasks: TaskService;
  readonly git: GitSafetyService;
  readonly provider: ScenarioProvider;
  readonly unity: FakeUnityEnvironment;
  readonly qa: QAOrchestrator;
  readonly qaArtifacts: QAArtifactStore;
  readonly runner: Awaited<ReturnType<typeof initializeRepository>>["runner"];
}

const passResult = (
  id: string,
  category: "STATIC" | "STRUCTURAL" | "RUNTIME" | "GAMEPLAY",
): QAAgentTestResult => ({
  testId: id,
  category,
  status: "PASS" as const,
  summary: `${id} passed.`,
  expected: `${id} behaves as contracted.`,
  observed: `${id} was observed with the expected state.`,
  evidence: [{ kind: category === "STATIC" ? "FILE" : category === "STRUCTURAL" ? "OBJECT" : category === "GAMEPLAY" ? "INPUT" : "PLAY_MODE", summary: `${id} evidence.` }],
  likelyArea: [],
  blockingReason: "NONE",
});

const failResult = (
  id: string,
  category: "STATIC" | "STRUCTURAL" | "RUNTIME" | "GAMEPLAY",
): QAAgentTestResult => ({
  testId: id,
  category,
  status: "FAIL" as const,
  summary: `${id} failed.`,
  expected: `${id} expected behavior.`,
  observed: `${id} observed failure.`,
  evidence: [{ kind: category === "STATIC" ? "FILE" : category === "STRUCTURAL" ? "OBJECT" : category === "GAMEPLAY" ? "INPUT" : "PLAY_MODE", summary: `${id} failure evidence.` }],
  likelyArea: ["Assets/Feature.cs"],
  blockingReason: "NONE",
});

const finding = (
  id: string,
  testId: string,
  source: "STATIC" | "STRUCTURAL" | "RUNTIME" | "GAMEPLAY",
): QAAgentFinding => ({
  id,
  severity: "blocking" as const,
  title: `${testId} defect`,
  description: `${testId} violates the approved contract.`,
  relatedAcceptanceCriteria: ["AC-001"],
  relatedTests: [testId],
  reproduction: [`Run ${testId}.`],
  expected: "Expected state.",
  observed: "Observed defect.",
  evidence: [{ kind: source === "STATIC" ? "FILE" : source === "STRUCTURAL" ? "OBJECT" : source === "GAMEPLAY" ? "INPUT" : "PLAY_MODE", summary: `${testId} finding evidence.` }],
  suspectedArea: ["Assets/Feature.cs"],
  source,
});

const passOutput = (tests: readonly { readonly id: string; readonly category: "STATIC" | "STRUCTURAL" | "RUNTIME" | "GAMEPLAY" }[]): QAAgentOutput => ({
  summary: "Every supplied M7 test passed with evidence.",
  results: tests.map((test) => passResult(test.id, test.category)),
  findings: [],
});

const addUnityFixture = async (
  repositoryRoot: string,
  runner: Harness["runner"],
): Promise<string> => {
  await Promise.all([
    mkdir(join(repositoryRoot, "Assets")),
    mkdir(join(repositoryRoot, "Packages")),
    mkdir(join(repositoryRoot, "ProjectSettings")),
  ]);
  await Promise.all([
    writeFile(join(repositoryRoot, "Assets", "SampleScene.unity"), "fixture scene\n", "utf8"),
    writeFile(join(repositoryRoot, "Packages", "manifest.json"), JSON.stringify({ dependencies: {} }), "utf8"),
    writeFile(join(repositoryRoot, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.11f1\n", "utf8"),
  ]);
  await runner.runChecked(["add", "--all"], { cwd: repositoryRoot });
  await runner.runChecked(["commit", "-m", "Add Unity fixture"], { cwd: repositoryRoot });
  return (await runner.runChecked(["rev-parse", "HEAD"], { cwd: repositoryRoot })).stdout.trim();
};

const createHarness = async (input: {
  readonly outputs: readonly ProviderOutput[];
  readonly automaticFixesEnabled?: boolean;
  readonly tests?: readonly { readonly id: string; readonly category: "STATIC" | "STRUCTURAL" | "RUNTIME" | "GAMEPLAY"; readonly description: string }[];
  readonly unity?: FakeUnityOptions;
  readonly onFix?: (request: ProviderExecutionRequest, fixNumber: number) => Promise<void>;
  readonly automaticFixLimit?: number;
  readonly onQA?: (request: ProviderExecutionRequest, outputIndex: number) => Promise<ProviderOutput>;
}): Promise<Harness> => {
  const root = await createTemporaryRoot();
  roots.add(root);
  const repository = await initializeRepository(root);
  const baseCommit = await addUnityFixture(repository.repositoryRoot, repository.runner);
  const runtimeRoot = join(root, "runtime");
  const store = new TaskStore(runtimeRoot);
  await store.initialize();
  const tasks = new TaskService(store, settings);
  const gitStore = new GitEnvironmentStore(runtimeRoot);
  await gitStore.initialize();
  const git = new GitSafetyService(tasks, gitStore, join(runtimeRoot, "worktrees"), repository.runner);
  const modelsConfiguration: ModelConfiguration = await loadModelConfiguration(join(process.cwd(), "config", "models.json"));
  const route = buildExecutionRoutingSnapshot(modelsConfiguration, "STANDARD", false, true);
  let task = await tasks.create({
    title: "Synthetic QA feature",
    originalRequest: "Add a small Unity component.",
    targetProjectPath: repository.repositoryRoot,
    strength: "STANDARD",
    crossReviewEnabled: false,
    automaticFixesEnabled: input.automaticFixesEnabled ?? true,
  });
  task = await tasks.analyze(task.id);
  task = await tasks.storeFeasibility(task.id, {
    status: "READY",
    summary: "Fixture is ready.",
    missingCapabilities: [],
  });
  const tests = input.tests ?? [
    { id: "TEST-001", category: "STATIC" as const, description: "Feature source is scoped." },
    { id: "TEST-002", category: "STRUCTURAL" as const, description: "Feature component exists." },
    { id: "TEST-003", category: "RUNTIME" as const, description: "Feature initializes in Play Mode." },
  ];
  task = await tasks.storeContract(task.id, {
    originalTaskSummary: "Add a small Unity component.",
    understoodExplicitRequirements: ["Add Feature component."],
    inferredRequirements: [],
    prerequisites: [],
    implementationScope: ["Assets/Feature.cs"],
    nonGoals: ["Do not add player input."],
    acceptanceCriteria: ["Feature component initializes."],
    acceptanceCriteriaDetails: [{
      id: "AC-001",
      description: "Feature component initializes.",
      evidenceExpectation: ["Observe the component in the runtime hierarchy."],
    }],
    testRequirements: tests.map((test) => `${test.category}: ${test.description}`),
    testRequirementDetails: tests,
    taskStrength: "STANDARD",
    executionPlan: route,
  });
  task = await tasks.approve(task.id);
  const environment = await git.prepare(task.id);
  task = beginTaskImplementation(task, {
    taskBranch: environment.taskBranch,
    worktreePath: environment.taskWorktreePath,
    baseCommit: environment.baseCommit,
  });
  await tasks.saveTask(task);
  await writeFile(
    join(environment.taskWorktreePath, "Assets", "Feature.cs"),
    "public sealed class Feature { }\n",
    "utf8",
  );
  const checkpoint = await git.checkpoint(task.id, { label: "implementation-1" });
  task = completeTaskImplementation(task, {
    runId: "RUN-IMPLEMENTATION",
    checkpointId: checkpoint.checkpoint.id,
    checkpointCommit: checkpoint.checkpoint.commit,
    changedFileCount: 1,
    reviewEnabled: false,
  });
  await tasks.saveTask(task);

  let outputIndex = 0;
  let fixNumber = 0;
  const provider = new ScenarioProvider(async (request) => {
    if (request.agent.id === "fix") {
      fixNumber += 1;
      await (input.onFix ?? (async (fixRequest) => {
        const path = join(fixRequest.workingDirectory, "Assets", "Feature.cs");
        const current = await readFile(path, "utf8");
        await writeFile(path, `${current}// fixed ${fixNumber}\n`, "utf8");
      }))(request, fixNumber);
      return {
        summary: `Applied fix ${fixNumber}.`,
        fixedFindingIds: ["FAIL-001", "FAIL-002", "FAIL-003"],
        changedFiles: ["Assets/Feature.cs"],
        fixNotes: ["Corrected the fixture."],
        sanityChecks: ["Inspected the changed file."],
        warnings: [],
      };
    }
    if (input.onQA !== undefined) {
      const currentIndex = outputIndex;
      outputIndex += 1;
      return input.onQA(request, currentIndex);
    }
    const output = input.outputs[outputIndex];
    outputIndex += 1;
    if (output === undefined) {
      throw new Error("No fake QA output remains.");
    }
    return output;
  });
  const agents = await AgentRegistry.load(join(process.cwd(), "agents"));
  const modelRegistry = new ModelRegistry(modelsConfiguration);
  const providerRegistry = new ProviderRegistry([provider]);
  const executionArtifacts = new ExecutionArtifactStore(runtimeRoot, 16_384);
  await executionArtifacts.initialize();
  const executor = new AgentExecutor(agents, modelRegistry, providerRegistry, executionArtifacts, 20_000);
  const ai = new AIService(agents, modelRegistry, providerRegistry, executor);
  const analysis = new AnalysisArtifactStore(runtimeRoot);
  await analysis.initialize();
  const orchestration = new OrchestrationArtifactStore(runtimeRoot);
  await orchestration.initialize();
  await orchestration.saveImplementation(task.id, {
    schemaVersion: 1,
    summary: "Added Feature component.",
    changedFiles: ["Assets/Feature.cs"],
    implementationNotes: ["Fixture implementation."],
    sanityChecks: ["Inspected source."],
    warnings: [],
    runId: "RUN-IMPLEMENTATION",
    providerId: route.implementation.providerId,
    modelId: route.implementation.modelId,
    effort: route.implementation.effort,
    status: "SUCCEEDED",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    checkpointId: checkpoint.checkpoint.id,
    checkpointCommit: checkpoint.checkpoint.commit,
  });
  await orchestration.saveReview(task.id, {
    schemaVersion: 1,
    status: "FINDINGS",
    summary: "Review focus recorded.",
    findings: [{
      id: "REVIEW-001",
      severity: "warning",
      title: "Inspect initialization",
      description: "Verify initialization in Play Mode.",
      evidence: "Static review only.",
      relatedFiles: ["Assets/Feature.cs"],
    }],
    qaFocus: ["Inspect Feature in Play Mode."],
    runId: "RUN-REVIEW",
    providerId: "codex",
    modelId: "codex-sol",
    effort: "medium",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  const qaArtifacts = new QAArtifactStore(runtimeRoot);
  await qaArtifacts.initialize();
  const unity = new FakeUnityEnvironment(task.id, environment.taskWorktreePath, input.unity);
  const qa = new QAOrchestrator({
    tasks,
    git,
    ai,
    unity: unity as unknown as UnityEnvironmentService,
    analysis,
    orchestration,
    artifacts: qaArtifacts,
  }, {
    unityMcpEntrypoint: join(process.cwd(), "apps", "unity-mcp", "dist", "main.js"),
    ...(input.automaticFixLimit === undefined
      ? {}
      : { automaticFixLimit: input.automaticFixLimit }),
    playModeTimeoutMs: 2_000,
  });
  return {
    root,
    repositoryRoot: repository.repositoryRoot,
    baseCommit,
    runtimeRoot,
    task,
    tasks,
    git,
    provider,
    unity,
    qa,
    qaArtifacts,
    runner: repository.runner,
  };
};

const defaultTests = [
  { id: "TEST-001", category: "STATIC" as const },
  { id: "TEST-002", category: "STRUCTURAL" as const },
  { id: "TEST-003", category: "RUNTIME" as const },
];

test("full M7 pass batches evidence, uses read-only Unity MCP, removes tooling, squashes, and completes", async () => {
  const harness = await createHarness({ outputs: [passOutput(defaultTests)] });
  const originalReadme = await readFile(join(harness.repositoryRoot, "README.md"), "utf8");
  await harness.qa.start(harness.task.id);
  const completed = await harness.qa.waitForIdle(harness.task.id);
  assert.equal(completed.state, "COMPLETED");
  const artifacts = await harness.qa.get(harness.task.id);
  assert.equal(artifacts.latestReport?.outcome, "PASS");
  assert.equal(artifacts.latestSession?.summary.failed, 0);
  assert.ok((artifacts.latestSession?.evidence.length ?? 0) >= 5);
  const qaRequest = harness.provider.requests.find((request) => request.agent.id === "qa");
  assert.equal(qaRequest?.agent.permission, "READ_ONLY");
  assert.deepEqual(qaRequest?.mcpServers?.[0]?.allowedTools, [
    "unity_ping",
    "unity_editor_status",
    "unity_request_compilation",
    "unity_enter_play_mode",
    "unity_exit_play_mode",
    "unity_set_play_mode_paused",
    "unity_console",
    "unity_scene_summary",
    "unity_scene_hierarchy",
    "unity_object_snapshot",
  ]);
  assert.match(qaRequest?.prompt ?? "", /Review focus recorded/u);
  assert.equal(harness.unity.playing, false);
  assert.equal(harness.unity.removeCalls, 1);
  await assert.rejects(() => access(join(
    (artifacts.latestSession?.unityEnvironment?.projectWorktreePath) ?? "",
    "Packages",
    "com.unityai.editor-bridge",
  )));
  const environment = await harness.git.getEnvironment(harness.task.id);
  assert.equal(environment?.status, "FINALIZED");
  assert.ok(environment?.finalCommit);
  assert.equal(
    (await harness.runner.runChecked(["rev-list", "--count", `${harness.baseCommit}..${environment?.taskBranch}`], { cwd: harness.repositoryRoot })).stdout.trim(),
    "1",
  );
  assert.equal((await harness.runner.runChecked(["rev-parse", "main"], { cwd: harness.repositoryRoot })).stdout.trim(), harness.baseCommit);
  assert.equal(await readFile(join(harness.repositoryRoot, "README.md"), "utf8"), originalReadme);
  assert.equal((await harness.runner.runChecked(["status", "--porcelain"], { cwd: harness.repositoryRoot })).stdout, "");
});

test("Automatic Fixes OFF completes all ordinary failures as one batch and exposes manual Fix & Retest", async () => {
  const output: QAAgentOutput = {
    summary: "All three tests were attempted.",
    results: defaultTests.map((entry) => failResult(entry.id, entry.category)),
    findings: defaultTests.map((entry, index) => finding(`FAIL-00${index + 1}`, entry.id, entry.category)),
  };
  const harness = await createHarness({ outputs: [output], automaticFixesEnabled: false });
  await harness.qa.start(harness.task.id);
  const failed = await harness.qa.waitForIdle(harness.task.id);
  assert.equal(failed.state, "FAILED");
  const qa = await harness.qa.get(harness.task.id);
  assert.equal(qa.latestReport?.summary.failed, 3);
  assert.equal(qa.latestReport?.findings.length, 3);
  assert.equal(qa.latestReport?.manualFixAvailable, true);
  assert.equal(harness.provider.requests.filter((request) => request.agent.id === "fix").length, 0);
  assert.equal((await harness.git.getEnvironment(harness.task.id))?.status, "ACTIVE");
});

test("Automatic Fixes ON sends the complete batch to the exact implementation route, checkpoints, and fully retests", async () => {
  const failedOutput: QAAgentOutput = {
    summary: "Three independent failures.",
    results: defaultTests.map((entry) => failResult(entry.id, entry.category)),
    findings: defaultTests.map((entry, index) => finding(`FAIL-00${index + 1}`, entry.id, entry.category)),
  };
  const harness = await createHarness({ outputs: [failedOutput, passOutput(defaultTests)] });
  await harness.qa.start(harness.task.id);
  const completed = await harness.qa.waitForIdle(harness.task.id);
  assert.equal(completed.state, "COMPLETED");
  const qa = await harness.qa.get(harness.task.id);
  assert.equal(qa.sessions.length, 2);
  assert.equal(qa.fixes.length, 1);
  const fix = qa.fixes[0];
  assert.equal(fix?.providerId, completed.taskContract?.executionPlan?.implementation.providerId);
  assert.equal(fix?.modelId, completed.taskContract?.executionPlan?.implementation.modelId);
  assert.equal(fix?.effort, completed.taskContract?.executionPlan?.implementation.effort);
  assert.equal(fix?.checkpointId, "CHECKPOINT-0002");
  const checkpointTree = (await harness.runner.runChecked(
    ["ls-tree", "-r", "--name-only", fix?.checkpointCommit ?? ""],
    { cwd: harness.repositoryRoot },
  )).stdout;
  assert.doesNotMatch(checkpointTree, /com\.unityai\.editor-bridge/u);
  const fixRequest = harness.provider.requests.find((request) => request.agent.id === "fix");
  assert.equal(fixRequest?.agent.permission, "WORKTREE_WRITE");
  assert.match(fixRequest?.prompt ?? "", /FAIL-001/u);
  assert.match(fixRequest?.prompt ?? "", /FAIL-002/u);
  assert.match(fixRequest?.prompt ?? "", /FAIL-003/u);
  assert.equal(harness.provider.requests.filter((request) => request.agent.id === "qa").length, 2);
  assert.equal(harness.unity.compilationRequests, 2);
});

test("a fix triggers a full fresh cycle that catches regression in a previously passing test", async () => {
  const cycleOne: QAAgentOutput = {
    summary: "One failure.",
    results: [
      passResult("TEST-001", "STATIC"),
      failResult("TEST-002", "STRUCTURAL"),
      passResult("TEST-003", "RUNTIME"),
    ],
    findings: [finding("FAIL-001", "TEST-002", "STRUCTURAL")],
  };
  const cycleTwo: QAAgentOutput = {
    summary: "Regression found.",
    results: [
      failResult("TEST-001", "STATIC"),
      passResult("TEST-002", "STRUCTURAL"),
      passResult("TEST-003", "RUNTIME"),
    ],
    findings: [finding("FAIL-002", "TEST-001", "STATIC")],
  };
  const harness = await createHarness({
    outputs: [cycleOne, cycleTwo],
    automaticFixLimit: 1,
  });
  await harness.qa.start(harness.task.id);
  const failed = await harness.qa.waitForIdle(harness.task.id);
  assert.equal(failed.state, "FAILED");
  const qa = await harness.qa.get(harness.task.id);
  assert.equal(qa.sessions.length, 2);
  assert.equal(qa.sessions[1]?.results.find((result) => result.testId === "TEST-001")?.status, "FAIL");
  assert.equal(qa.sessions[1]?.results.find((result) => result.testId === "TEST-002")?.status, "PASS");
});

test("gameplay requirements remain NOT_RUN for M8, block completion, and never finalize", async () => {
  const tests = [
    { id: "TEST-001", category: "STRUCTURAL" as const, description: "Component exists." },
    { id: "TEST-002", category: "RUNTIME" as const, description: "Component initializes." },
    { id: "TEST-003", category: "GAMEPLAY" as const, description: "Press Space and verify behavior." },
  ];
  const harness = await createHarness({
    outputs: [passOutput(tests.filter((test) => test.category !== "GAMEPLAY") as readonly { id: string; category: "STRUCTURAL" | "RUNTIME" }[])],
    tests,
  });
  await harness.qa.start(harness.task.id);
  const pending = await harness.qa.waitForIdle(harness.task.id);
  assert.equal(pending.state, "READY_FOR_GAMEPLAY_QA");
  const qa = await harness.qa.get(harness.task.id);
  const gameplay = qa.latestSession?.results.find((result) => result.testId === "TEST-003");
  assert.equal(gameplay?.status, "NOT_RUN");
  assert.equal(gameplay?.blockingReason, "REQUIRES_M8_GAMEPLAY_QA");
  assert.equal((await harness.git.getEnvironment(harness.task.id))?.status, "ACTIVE");
  assert.equal(harness.unity.removeCalls, 0);
});

test("compile failure is evidence-backed, structural QA continues, and runtime is blocked", async () => {
  const tests = [
    { id: "TEST-001", category: "STRUCTURAL" as const, description: "Component exists." },
    { id: "TEST-002", category: "RUNTIME" as const, description: "Component initializes." },
  ];
  const harness = await createHarness({
    outputs: [passOutput([{ id: "TEST-001", category: "STRUCTURAL" }])],
    automaticFixesEnabled: false,
    tests,
    unity: { compileErrors: true },
  });
  await harness.qa.start(harness.task.id);
  const failed = await harness.qa.waitForIdle(harness.task.id);
  assert.equal(failed.state, "FAILED");
  const session = (await harness.qa.get(harness.task.id)).latestSession;
  assert.equal(session?.results.find((result) => result.testId === "QA0-COMPILATION")?.status, "FAIL");
  assert.equal(session?.results.find((result) => result.testId === "TEST-001")?.status, "PASS");
  assert.equal(session?.results.find((result) => result.testId === "TEST-002")?.status, "BLOCKED");
  assert.equal(session?.results.find((result) => result.testId === "TEST-002")?.blockingReason, "COMPILATION_FAILED");
  assert.equal(harness.unity.enterCalls, 0);
});

test("technical QA provider failure never invokes Fix, escalates, finalizes, or destroys the worktree", async () => {
  const harness = await createHarness({
    outputs: [{
      failure: true,
      status: "TIMED_OUT",
      code: "EXECUTION_TIMEOUT",
      message: "Fake QA timeout.",
    }],
  });
  await harness.qa.start(harness.task.id);
  const failed = await harness.qa.waitForIdle(harness.task.id);
  assert.equal(failed.state, "FAILED");
  const qa = await harness.qa.get(harness.task.id);
  assert.equal(qa.latestReport?.outcome, "TECHNICAL_FAILURE");
  assert.equal(qa.latestFailure?.code, "EXECUTION_TIMEOUT");
  assert.equal(harness.provider.requests.filter((request) => request.agent.id === "fix").length, 0);
  assert.equal((await harness.git.getEnvironment(harness.task.id))?.status, "ACTIVE");
});

test("automatic correction stops after exactly three fix cycles with no model escalation", async () => {
  const failureOutput: QAAgentOutput = {
    summary: "Persistent failure.",
    results: defaultTests.map((entry) => entry.id === "TEST-002"
      ? failResult(entry.id, entry.category)
      : passResult(entry.id, entry.category)),
    findings: [finding("FAIL-001", "TEST-002", "STRUCTURAL")],
  };
  const harness = await createHarness({
    outputs: [failureOutput, failureOutput, failureOutput, failureOutput],
  });
  await harness.qa.start(harness.task.id);
  const failed = await harness.qa.waitForIdle(harness.task.id);
  assert.equal(failed.state, "FAILED");
  const qa = await harness.qa.get(harness.task.id);
  assert.equal(qa.fixes.filter((fix) => fix.automatic).length, AUTOMATIC_FIX_CYCLE_LIMIT);
  assert.equal(qa.sessions.length, AUTOMATIC_FIX_CYCLE_LIMIT + 1);
  const fixRequests = harness.provider.requests.filter((request) => request.agent.id === "fix");
  assert.equal(fixRequests.length, AUTOMATIC_FIX_CYCLE_LIMIT);
  assert.equal(new Set(fixRequests.map((request) => request.model.id)).size, 1);
});

test("safe finalization refusal preserves a passed task when bridge ownership cleanup fails", async () => {
  const harness = await createHarness({
    outputs: [passOutput(defaultTests)],
    unity: { removalFails: true },
  });
  await harness.qa.start(harness.task.id);
  const failed = await harness.qa.waitForIdle(harness.task.id);
  assert.equal(failed.state, "FAILED");
  const qa = await harness.qa.get(harness.task.id);
  assert.equal(qa.latestReport?.outcome, "TECHNICAL_FAILURE");
  assert.equal(qa.latestFailure?.code, "UNITY_BRIDGE_OWNERSHIP_MISMATCH");
  assert.equal((await harness.git.getEnvironment(harness.task.id))?.status, "ACTIVE");
});

test("wrong-state and duplicate QA starts are rejected without launching a second run", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const harness = await createHarness({
    outputs: [],
    onQA: async () => {
      await gate;
      return passOutput(defaultTests);
    },
  });
  await harness.qa.start(harness.task.id);
  await assert.rejects(
    () => harness.qa.start(harness.task.id),
    (error: unknown) => error instanceof Error && error.message.includes("already running"),
  );
  release?.();
  await harness.qa.waitForIdle(harness.task.id);
  await assert.rejects(
    () => harness.qa.start(harness.task.id),
    (error: unknown) => error instanceof Error && error.message.includes("READY_FOR_QA"),
  );
  assert.equal(harness.provider.requests.filter((request) => request.agent.id === "qa").length, 1);
});

test("manual Fix & Retest uses the same fix path and reruns the full QA session", async () => {
  const failureOutput: QAAgentOutput = {
    summary: "One complete-cycle failure.",
    results: defaultTests.map((entry) => entry.id === "TEST-002"
      ? failResult(entry.id, entry.category)
      : passResult(entry.id, entry.category)),
    findings: [finding("FAIL-001", "TEST-002", "STRUCTURAL")],
  };
  const harness = await createHarness({
    outputs: [failureOutput, passOutput(defaultTests)],
    automaticFixesEnabled: false,
  });
  await harness.qa.start(harness.task.id);
  assert.equal((await harness.qa.waitForIdle(harness.task.id)).state, "FAILED");
  await harness.qa.fixAndRetest(harness.task.id);
  assert.equal((await harness.qa.waitForIdle(harness.task.id)).state, "COMPLETED");
  const artifacts = await harness.qa.get(harness.task.id);
  assert.equal(artifacts.sessions.length, 2);
  assert.equal(artifacts.fixes.length, 1);
  assert.equal(artifacts.fixes[0]?.automatic, false);
  assert.equal(harness.provider.requests.filter((request) => request.agent.id === "qa").length, 2);
});

test("a no-change Fix stops immediately as a technical failure and does not consume more cycles", async () => {
  const failureOutput: QAAgentOutput = {
    summary: "One fixable failure.",
    results: defaultTests.map((entry) => entry.id === "TEST-002"
      ? failResult(entry.id, entry.category)
      : passResult(entry.id, entry.category)),
    findings: [finding("FAIL-001", "TEST-002", "STRUCTURAL")],
  };
  const harness = await createHarness({
    outputs: [failureOutput],
    onFix: async () => undefined,
  });
  await harness.qa.start(harness.task.id);
  assert.equal((await harness.qa.waitForIdle(harness.task.id)).state, "FAILED");
  const artifacts = await harness.qa.get(harness.task.id);
  assert.equal(artifacts.latestFailure?.code, "FIX_NO_CHANGES");
  assert.equal(artifacts.sessions.length, 1);
  assert.equal(artifacts.fixes.length, 0);
  assert.equal((await harness.git.getEnvironment(harness.task.id))?.status, "ACTIVE");
});

test("QA cancellation reaches the provider, exits Play Mode, and preserves the managed worktree", async () => {
  const harness = await createHarness({
    outputs: [],
    onQA: async (request) => new Promise<ProviderOutput>((resolvePromise) => {
      if (request.signal?.aborted === true) {
        resolvePromise({ failure: true, status: "CANCELLED", code: "EXECUTION_CANCELLED", message: "Cancelled." });
        return;
      }
      request.signal?.addEventListener("abort", () => {
        resolvePromise({ failure: true, status: "CANCELLED", code: "EXECUTION_CANCELLED", message: "Cancelled." });
      }, { once: true });
    }),
  });
  await harness.qa.start(harness.task.id);
  const deadline = Date.now() + 5_000;
  while (
    harness.provider.requests.every((request) => request.agent.id !== "qa") &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.equal(harness.qa.cancel(harness.task.id), true);
  assert.equal((await harness.qa.waitForIdle(harness.task.id)).state, "FAILED");
  const artifacts = await harness.qa.get(harness.task.id);
  assert.equal(artifacts.latestFailure?.code, "EXECUTION_CANCELLED");
  assert.equal(harness.unity.playing, false);
  assert.equal((await harness.git.getEnvironment(harness.task.id))?.status, "ACTIVE");
});

test("restart recovery converts a persisted running QA session into an interrupted technical failure", async () => {
  const harness = await createHarness({ outputs: [passOutput(defaultTests)] });
  const allocation = await harness.qaArtifacts.nextCycle(harness.task.id);
  await harness.tasks.saveTask(beginTaskQA(await harness.tasks.get(harness.task.id), allocation));
  const running: QASession = {
    schemaVersion: 1,
    sessionId: allocation.sessionId,
    taskId: harness.task.id,
    cycleNumber: allocation.cycleNumber,
    startedAt: new Date().toISOString(),
    status: "RUNNING",
    plannedTests: [],
    results: [],
    findings: [],
    blockedTests: [],
    evidence: [],
    summary: {
      text: "QA was running.",
      passed: 0,
      failed: 0,
      blocked: 0,
      notRun: 0,
      gameplayPending: 0,
    },
  };
  await harness.qaArtifacts.saveSession(harness.task.id, running);
  const recovered = await harness.qa.recoverInterruptedRuns();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.state, "FAILED");
  const artifacts = await harness.qa.get(harness.task.id);
  assert.equal(artifacts.latestSession?.status, "TECHNICAL_FAILURE");
  assert.equal(artifacts.latestFailure?.code, "SERVER_RESTART_INTERRUPTED");
});

test("M7 HTTP API starts, lists, reads, and cancels only the explicit QA workflow", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const harness = await createHarness({
    outputs: [],
    onQA: async () => {
      await gate;
      return passOutput(defaultTests);
    },
  });
  const m5 = {
    qa: harness.qa,
    projects: {},
    settings: {},
    workflow: {},
    orchestrator: {},
  } as unknown as M5ServerServices;
  const server = createUnityAiServer(harness.tasks, harness.git, undefined, undefined, m5);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/tasks/${harness.task.id}/qa`;
  try {
    const started = await fetch(`${base}/start`, { method: "POST" });
    assert.equal(started.status, 202);
    const duplicate = await fetch(`${base}/start`, { method: "POST" });
    assert.equal(duplicate.status, 409);
    release?.();
    await harness.qa.waitForIdle(harness.task.id);
    const [all, latest, cycles, cycle] = await Promise.all([
      fetch(base),
      fetch(`${base}/latest`),
      fetch(`${base}/cycles`),
      fetch(`${base}/cycles/cycle-001`),
    ]);
    assert.deepEqual([all.status, latest.status, cycles.status, cycle.status], [200, 200, 200, 200]);
    assert.equal(((await latest.json()) as { report?: { outcome?: string } }).report?.outcome, "PASS");
    const cancel = await fetch(`${base}/cancel`, { method: "POST" });
    assert.equal(cancel.status, 202);
    assert.equal(((await cancel.json()) as { cancelRequested: boolean }).cancelRequested, false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

const m8ContractTests = [
  { id: "TEST-001", category: "STATIC" as const, description: "Gameplay source remains scoped." },
  { id: "TEST-002", category: "STRUCTURAL" as const, description: "Player input component exists." },
  { id: "TEST-003", category: "RUNTIME" as const, description: "Player initializes in Play Mode." },
  { id: "TEST-004", category: "GAMEPLAY" as const, description: "Space performs a dash." },
  { id: "TEST-005", category: "GAMEPLAY" as const, description: "Cooldown rejects an immediate second dash." },
  { id: "TEST-006", category: "GAMEPLAY" as const, description: "Dash works after the cooldown." },
];

const m8ExecutionTests = m8ContractTests.map(({ id, category }) => ({ id, category }));
const m7PartOfM8 = m8ExecutionTests.filter((entry) => entry.category !== "GAMEPLAY");

test("M8 full gameplay pass reruns QA0-QA3, uses gameplay MCP, releases input, finalizes once, and leaves original untouched", async () => {
  const visualPass: QAAgentOutput = {
    ...passOutput(m8ExecutionTests),
    results: m8ExecutionTests.map((entry) => entry.id === "TEST-004"
      ? {
          ...passResult(entry.id, entry.category),
          evidence: [
            { kind: "INPUT", summary: "Space was sent through the bound virtual keyboard." },
            { kind: "PROBE", summary: "Player transform advanced after the dash." },
            { kind: "SCREENSHOT", summary: "Bounded Game View evidence shows the moved player." },
          ],
        }
      : passResult(entry.id, entry.category)),
  };
  const harness = await createHarness({
    outputs: [passOutput(m7PartOfM8), visualPass],
    tests: m8ContractTests,
  });
  const originalReadme = await readFile(join(harness.repositoryRoot, "README.md"), "utf8");

  await harness.qa.start(harness.task.id);
  assert.equal((await harness.qa.waitForIdle(harness.task.id)).state, "READY_FOR_GAMEPLAY_QA");
  await harness.qa.startGameplay(harness.task.id);
  const completed = await harness.qa.waitForIdle(harness.task.id);
  assert.equal(completed.state, "COMPLETED");

  const artifacts = await harness.qa.get(harness.task.id);
  assert.equal(artifacts.sessions.length, 2);
  assert.equal(artifacts.latestReport?.outcome, "PASS");
  assert.equal(artifacts.latestSession?.results.filter((result) => result.category === "GAMEPLAY").every((result) => result.status === "PASS"), true);
  assert.equal(artifacts.latestSession?.evidence.some((entry) => entry.kind === "SCREENSHOT"), true);
  const gameplayRequest = harness.provider.requests.filter((request) => request.agent.id === "qa").at(-1);
  assert.equal(gameplayRequest?.agent.permission, "READ_ONLY");
  assert.equal(gameplayRequest?.mcpServers?.[0]?.allowedTools.includes("unity_input_action"), true);
  assert.equal(gameplayRequest?.mcpServers?.[0]?.allowedTools.includes("unity_game_view_screenshot"), true);
  assert.equal(gameplayRequest?.mcpServers?.[0]?.allowedTools.some((name) => /csharp|shell|filesystem|arbitrary|desktop/u.test(name)), false);
  assert.ok(harness.unity.releaseInputCalls >= 1);
  assert.equal(harness.unity.playing, false);
  const environment = await harness.git.getEnvironment(harness.task.id);
  assert.equal(environment?.status, "FINALIZED");
  assert.equal(
    (await harness.runner.runChecked(["rev-list", "--count", `${harness.baseCommit}..${environment?.taskBranch}`], { cwd: harness.repositoryRoot })).stdout.trim(),
    "1",
  );
  assert.equal((await harness.runner.runChecked(["rev-parse", "main"], { cwd: harness.repositoryRoot })).stdout.trim(), harness.baseCommit);
  assert.equal(await readFile(join(harness.repositoryRoot, "README.md"), "utf8"), originalReadme);
  assert.equal((await harness.runner.runChecked(["status", "--porcelain"], { cwd: harness.repositoryRoot })).stdout, "");
});

test("M8 HTTP API exposes only explicit gameplay QA read, start, and cancel operations", async () => {
  let releaseGameplay: (() => void) | undefined;
  const gameplayGate = new Promise<void>((resolvePromise) => {
    releaseGameplay = resolvePromise;
  });
  const harness = await createHarness({
    outputs: [],
    tests: m8ContractTests,
    onQA: async (_request, index) => {
      if (index === 0) {
        return passOutput(m7PartOfM8);
      }
      await gameplayGate;
      return passOutput(m8ExecutionTests);
    },
  });
  await harness.qa.start(harness.task.id);
  assert.equal((await harness.qa.waitForIdle(harness.task.id)).state, "READY_FOR_GAMEPLAY_QA");
  const m5 = {
    qa: harness.qa,
    projects: {},
    settings: {},
    workflow: {},
    orchestrator: {},
  } as unknown as M5ServerServices;
  const server = createUnityAiServer(harness.tasks, harness.git, undefined, undefined, m5);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/tasks/${harness.task.id}/gameplay-qa`;
  try {
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(`${base}/start`, { method: "POST" })).status, 202);
    assert.equal((await fetch(`${base}/start`, { method: "POST" })).status, 409);
    releaseGameplay?.();
    await harness.qa.waitForIdle(harness.task.id);
    const cancel = await fetch(`${base}/cancel`, { method: "POST" });
    assert.equal(cancel.status, 202);
    assert.equal(((await cancel.json()) as { cancelRequested: boolean }).cancelRequested, false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("M8 gameplay completes all ordinary tests and batches multiple failures before Automatic Fixes OFF stops", async () => {
  const gameplayFailure: QAAgentOutput = {
    summary: "All gameplay scenarios were attempted; two failed.",
    results: m8ExecutionTests.map((entry) => entry.id === "TEST-005" || entry.id === "TEST-006"
      ? failResult(entry.id, entry.category)
      : passResult(entry.id, entry.category)),
    findings: [
      finding("FAIL-GP-001", "TEST-005", "GAMEPLAY"),
      finding("FAIL-GP-002", "TEST-006", "GAMEPLAY"),
    ],
  };
  const harness = await createHarness({
    outputs: [passOutput(m7PartOfM8), gameplayFailure],
    tests: m8ContractTests,
    automaticFixesEnabled: false,
  });
  await harness.qa.start(harness.task.id);
  await harness.qa.waitForIdle(harness.task.id);
  await harness.qa.startGameplay(harness.task.id);
  assert.equal((await harness.qa.waitForIdle(harness.task.id)).state, "FAILED");
  const artifacts = await harness.qa.get(harness.task.id);
  assert.equal(artifacts.latestReport?.summary.failed, 2);
  assert.deepEqual(artifacts.latestReport?.findings.map((entry) => entry.id), ["FAIL-GP-001", "FAIL-GP-002"]);
  assert.equal(artifacts.latestReport?.results.find((entry) => entry.testId === "TEST-006")?.status, "FAIL");
  assert.equal(harness.provider.requests.filter((request) => request.agent.id === "fix").length, 0);
  assert.equal((await harness.git.getEnvironment(harness.task.id))?.status, "ACTIVE");
});

test("M8 automatic gameplay fix receives the complete batch and full retest restarts at STATIC before finalization", async () => {
  const gameplayFailure: QAAgentOutput = {
    summary: "Two gameplay defects after a complete session.",
    results: m8ExecutionTests.map((entry) => entry.id === "TEST-004" || entry.id === "TEST-005"
      ? failResult(entry.id, entry.category)
      : passResult(entry.id, entry.category)),
    findings: [
      finding("FAIL-GP-001", "TEST-004", "GAMEPLAY"),
      finding("FAIL-GP-002", "TEST-005", "GAMEPLAY"),
    ],
  };
  const harness = await createHarness({
    outputs: [passOutput(m7PartOfM8), gameplayFailure, passOutput(m8ExecutionTests)],
    tests: m8ContractTests,
  });
  await harness.qa.start(harness.task.id);
  await harness.qa.waitForIdle(harness.task.id);
  await harness.qa.startGameplay(harness.task.id);
  const completed = await harness.qa.waitForIdle(harness.task.id);
  assert.equal(completed.state, "COMPLETED");
  const artifacts = await harness.qa.get(harness.task.id);
  assert.equal(artifacts.fixes.length, 1);
  assert.equal(artifacts.sessions.length, 3);
  assert.equal(artifacts.sessions.at(-1)?.results.find((entry) => entry.testId === "QA0-COMPILATION")?.status, "PASS");
  assert.equal(artifacts.sessions.at(-1)?.results.find((entry) => entry.testId === "TEST-006")?.status, "PASS");
  const fixRequest = harness.provider.requests.find((request) => request.agent.id === "fix");
  assert.match(fixRequest?.prompt ?? "", /FAIL-GP-001/u);
  assert.match(fixRequest?.prompt ?? "", /FAIL-GP-002/u);
  assert.equal(artifacts.fixes[0]?.modelId, completed.taskContract?.executionPlan?.implementation.modelId);
  assert.equal(artifacts.fixes[0]?.effort, completed.taskContract?.executionPlan?.implementation.effort);
  assert.equal(harness.unity.compilationRequests, 3);
});

test("M8 gameplay fix regression is caught by fresh compilation and blocks gameplay instead of reusing PASS", async () => {
  let compileBroken = false;
  const gameplayFailure: QAAgentOutput = {
    summary: "Gameplay defect found.",
    results: m8ExecutionTests.map((entry) => entry.id === "TEST-004"
      ? failResult(entry.id, entry.category)
      : passResult(entry.id, entry.category)),
    findings: [finding("FAIL-GP-001", "TEST-004", "GAMEPLAY")],
  };
  const harness = await createHarness({
    outputs: [],
    tests: m8ContractTests,
    unity: { compileErrors: () => compileBroken },
    automaticFixLimit: 1,
    onFix: async (request) => {
      compileBroken = true;
      const path = join(request.workingDirectory, "Assets", "Feature.cs");
      await writeFile(path, `${await readFile(path, "utf8")}// broken gameplay fix\n`, "utf8");
    },
    onQA: async (_request, index) => {
      if (index === 0) return passOutput(m7PartOfM8);
      if (index === 1) return gameplayFailure;
      return passOutput(m8ExecutionTests.filter((entry) => entry.category === "STATIC" || entry.category === "STRUCTURAL"));
    },
  });
  await harness.qa.start(harness.task.id);
  await harness.qa.waitForIdle(harness.task.id);
  await harness.qa.startGameplay(harness.task.id);
  const failed = await harness.qa.waitForIdle(harness.task.id);
  assert.equal(failed.state, "FAILED");
  const session = (await harness.qa.get(harness.task.id)).latestSession;
  assert.equal(session?.results.find((entry) => entry.testId === "QA0-COMPILATION")?.status, "FAIL");
  assert.equal(session?.results.find((entry) => entry.testId === "TEST-004")?.status, "BLOCKED");
  assert.equal(session?.results.find((entry) => entry.testId === "TEST-004")?.blockingReason, "COMPILATION_FAILED");
  assert.equal((await harness.git.getEnvironment(harness.task.id))?.status, "ACTIVE");
});

test("M8 unsupported input remains BLOCKED and a gameplay bridge failure stays technical with no Fix", async () => {
  const blocked: QAAgentOutput = {
    summary: "One required binding cannot be driven safely.",
    results: m8ExecutionTests.map((entry) => entry.id === "TEST-005"
      ? {
          testId: entry.id,
          category: entry.category,
          status: "BLOCKED",
          summary: "Binding is unsupported.",
          expected: "Drive the approved gameplay action.",
          observed: "No supported virtual binding and guarded OS focus was unavailable.",
          evidence: [],
          likelyArea: ["Input bindings"],
          blockingReason: "INPUT_BINDING_UNSUPPORTED",
        }
      : passResult(entry.id, entry.category)),
    findings: [],
  };
  const blockedHarness = await createHarness({
    outputs: [passOutput(m7PartOfM8), blocked],
    tests: m8ContractTests,
    automaticFixesEnabled: false,
  });
  await blockedHarness.qa.start(blockedHarness.task.id);
  await blockedHarness.qa.waitForIdle(blockedHarness.task.id);
  await blockedHarness.qa.startGameplay(blockedHarness.task.id);
  assert.equal((await blockedHarness.qa.waitForIdle(blockedHarness.task.id)).state, "FAILED");
  assert.equal((await blockedHarness.qa.get(blockedHarness.task.id)).latestReport?.blockedTests.includes("TEST-005"), true);
  assert.equal((await blockedHarness.git.getEnvironment(blockedHarness.task.id))?.status, "ACTIVE");

  const technicalHarness = await createHarness({
    outputs: [passOutput(m7PartOfM8)],
    tests: m8ContractTests,
    unity: { gameplayDisconnect: true },
  });
  await technicalHarness.qa.start(technicalHarness.task.id);
  await technicalHarness.qa.waitForIdle(technicalHarness.task.id);
  await technicalHarness.qa.startGameplay(technicalHarness.task.id);
  assert.equal((await technicalHarness.qa.waitForIdle(technicalHarness.task.id)).state, "FAILED");
  const technical = await technicalHarness.qa.get(technicalHarness.task.id);
  assert.equal(technical.latestReport?.outcome, "TECHNICAL_FAILURE");
  assert.equal(technicalHarness.provider.requests.filter((request) => request.agent.id === "fix").length, 0);
  assert.ok(technicalHarness.unity.releaseInputCalls >= 1);
  assert.equal((await technicalHarness.git.getEnvironment(technicalHarness.task.id))?.status, "ACTIVE");
});
