import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type {
  AnalysisFeasibilityResult,
  JsonValue,
  Task,
  TaskInterpretationResult,
  TaskSettings,
} from "@unityai/core";

import { AgentExecutor } from "../src/agentExecutor.js";
import { AgentRegistry } from "../src/agentRegistry.js";
import { AnalysisArtifactStore } from "../src/analysisArtifactStore.js";
import { AnalysisService } from "../src/analysisService.js";
import { loadModelConfiguration } from "../src/aiConfig.js";
import type {
  AIProvider,
  ProviderAvailability,
  ProviderExecutionRequest,
  ProviderExecutionResult,
} from "../src/aiProvider.js";
import { AIService } from "../src/aiService.js";
import { createUnityAiServer } from "../src/app.js";
import { ExecutionArtifactStore } from "../src/executionArtifactStore.js";
import { ModelRegistry } from "../src/modelRegistry.js";
import { ProviderRegistry } from "../src/providerRegistry.js";
import { ServerError } from "../src/errors.js";
import { TaskService } from "../src/taskService.js";
import { TaskStore } from "../src/taskStore.js";
import {
  createGitTestContext,
  removeTemporaryRoot,
} from "./gitTestHelpers.js";

const roots = new Set<string>();

afterEach(async () => {
  const current = [...roots];
  roots.clear();
  await Promise.all(current.map((root) => rm(root, { recursive: true, force: true })));
});

const settings: TaskSettings = {
  crossReviewEnabled: true,
  automaticFixesEnabled: true,
};

const interpretation = (
  overrides: Partial<TaskInterpretationResult> = {},
): TaskInterpretationResult => ({
  title: "Dash action",
  summary: "Add a simple dash action with a cooldown.",
  explicitRequirements: ["The player can dash."],
  inferredRequirements: ["Dash is unavailable until its cooldown expires."],
  constraints: [],
  explicitNonGoals: ["Do not add stamina."],
  ambiguities: [],
  acceptanceCriteriaDraft: [
    {
      description: "Dash moves the player when the cooldown is ready.",
      evidenceExpectation: ["Record player position before and after dash input."],
    },
  ],
  testRequirementsDraft: [
    { category: "RUNTIME", description: "Exercise dash and cooldown timing." },
  ],
  riskSignals: {
    newReusableCoreSystem: false,
    multiSystemIntegration: true,
    networkingOrMultiplayer: false,
    persistenceOrSaveArchitecture: false,
    editorTooling: false,
    potentiallyDestructiveDataChange: false,
    likelyArchitectureImpact: false,
    majorFrameworkOrSystemReplacement: false,
    highRegressionRisk: false,
    estimatedSystemsAffected: 2,
  },
  ...overrides,
});

const feasibility = (
  overrides: Partial<AnalysisFeasibilityResult> = {},
): AnalysisFeasibilityResult => ({
  status: "READY",
  summary: "The existing player and input abstractions support this task.",
  evidence: [
    { location: "Assets/Player.cs", observation: "Player movement exists." },
    { location: "Assets/Input.cs", observation: "Input is abstracted." },
  ],
  existingCapabilities: ["Player movement", "Input abstraction"],
  missingCapabilities: [],
  autoFixableDependencies: [],
  suggestedPrerequisite: null,
  systemsAffected: ["Player", "Input"],
  architectureImpact: "low",
  implementationComplexity: "medium",
  regressionRisk: "medium",
  ambiguity: "low",
  createsReusableCoreSystem: false,
  proposedImplementationScope: ["Add dash state and cooldown handling."],
  proposedNonGoals: ["Do not replace ordinary movement."],
  acceptanceCriteriaAdditions: [
    {
      description: "Dash input during cooldown does not move the player.",
      evidenceExpectation: ["Record position before and after rejected input."],
    },
  ],
  testRequirementAdditions: [
    { category: "GAMEPLAY", description: "Verify repeated dash input is gated." },
  ],
  ...overrides,
});

interface FailureResponse {
  readonly kind: "failure";
  readonly status: "FAILED" | "TIMED_OUT" | "CANCELLED";
  readonly code:
    | "EXECUTION_TIMEOUT"
    | "EXECUTION_CANCELLED"
    | "PROVIDER_EXIT_FAILURE";
  readonly message: string;
}

type FakeResponseValue =
  | JsonValue
  | TaskInterpretationResult
  | AnalysisFeasibilityResult
  | FailureResponse;

type FakeResponse =
  | FakeResponseValue
  | FailureResponse
  | ((request: ProviderExecutionRequest) => Promise<FakeResponseValue>);

const isFailure = (value: FakeResponseValue): value is FailureResponse =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "kind" in value &&
  value.kind === "failure";

class QueueProvider implements AIProvider {
  readonly id = "codex";
  readonly requests: ProviderExecutionRequest[] = [];
  private readonly responses: FakeResponse[];

  constructor(responses: readonly FakeResponse[]) {
    this.responses = [...responses];
  }

  async availability(): Promise<ProviderAvailability> {
    return {
      providerId: this.id,
      status: "AVAILABLE",
      cliAvailable: true,
      authentication: "AUTHENTICATED",
      message: "Fake provider is available.",
    };
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
    this.requests.push(request);
    const queued = this.responses.shift();
    if (queued === undefined) {
      throw new Error("Fake provider response queue is empty.");
    }
    const response = typeof queued === "function" ? await queued(request) : queued;
    const timestamp = new Date().toISOString();
    if (isFailure(response)) {
      return {
        providerId: this.id,
        status: response.status,
        stdout: "",
        stderr: response.message,
        stdoutTruncated: false,
        stderrTruncated: false,
        startedAt: timestamp,
        finishedAt: timestamp,
        durationMs: 0,
        failure: { code: response.code, message: response.message },
      };
    }
    const structuredOutput = response as JsonValue;
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

interface Harness {
  readonly root: string;
  readonly runtimeRoot: string;
  readonly targetPath: string;
  readonly provider: QueueProvider;
  readonly taskService: TaskService;
  readonly artifactStore: AnalysisArtifactStore;
  readonly analysisService: AnalysisService;
  readonly task: Task;
}

const createHarness = async (
  responses: readonly FakeResponse[],
  taskOverrides: Record<string, unknown> = {},
): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), "unityai-m4-test-"));
  roots.add(root);
  const targetPath = join(root, "target");
  const runtimeRoot = join(root, "runtime");
  await mkdir(join(targetPath, "Assets"), { recursive: true });
  await writeFile(
    join(targetPath, "Assets", "Player.cs"),
    "public class Player {}\n",
    "utf8",
  );
  await writeFile(
    join(targetPath, "Assets", "Input.cs"),
    "public class Input {}\n",
    "utf8",
  );
  const taskStore = new TaskStore(runtimeRoot);
  await taskStore.initialize();
  const taskService = new TaskService(taskStore, settings);
  const task = await taskService.create({
    originalRequest: "Add a simple dash action with a cooldown.",
    targetProjectPath: targetPath,
    strength: "STANDARD",
    ...taskOverrides,
  });
  const agents = await AgentRegistry.load(join(process.cwd(), "agents"));
  const models = new ModelRegistry(
    await loadModelConfiguration(join(process.cwd(), "config", "models.json")),
  );
  const provider = new QueueProvider(responses);
  const providers = new ProviderRegistry([provider]);
  const executionArtifacts = new ExecutionArtifactStore(runtimeRoot, 16_384);
  await executionArtifacts.initialize();
  const executor = new AgentExecutor(
    agents,
    models,
    providers,
    executionArtifacts,
    10_000,
  );
  const aiService = new AIService(agents, models, providers, executor);
  const artifactStore = new AnalysisArtifactStore(runtimeRoot);
  await artifactStore.initialize();
  const analysisService = new AnalysisService(
    taskService,
    artifactStore,
    aiService,
  );
  return {
    root,
    runtimeRoot,
    targetPath,
    provider,
    taskService,
    artifactStore,
    analysisService,
    task,
  };
};

test("synthetic READY flow uses exactly interpreter + configured feasibility and stops after approval", async () => {
  const harness = await createHarness([interpretation(), feasibility()]);
  const beforePlayer = await readFile(join(harness.targetPath, "Assets", "Player.cs"), "utf8");
  const result = await harness.analysisService.analyze(harness.task.id);

  assert.equal(result.task.state, "WAITING_FOR_APPROVAL");
  assert.equal(result.task.strength, "STANDARD");
  assert.equal(result.task.analysis?.preliminaryStrength, "STANDARD");
  assert.equal(result.task.analysis?.routingSnapshot.implementation.modelId, "codex-sol");
  assert.equal(result.task.analysis?.routingSnapshot.implementation.effort, "medium");
  assert.deepEqual(
    result.task.analysis?.routingSnapshot.fix.plan,
    result.task.analysis?.routingSnapshot.implementation,
  );
  assert.equal(result.task.analysis?.routingSnapshot.review.enabled, true);
  assert.equal(result.task.taskContract?.approved, false);
  assert.deepEqual(
    result.task.taskContract?.acceptanceCriteriaDetails?.map((criterion) => criterion.id),
    ["AC-001", "AC-002"],
  );
  assert.deepEqual(
    result.task.taskContract?.testRequirementDetails?.map((item) => item.category),
    ["RUNTIME", "GAMEPLAY"],
  );
  assert.equal(harness.provider.requests.length, 2);
  assert.deepEqual(
    harness.provider.requests.map((request) => request.agent.id),
    ["task-interpreter", "feasibility"],
  );
  assert.deepEqual(
    harness.provider.requests.map((request) => request.model.id),
    ["codex-terra", "codex-terra"],
  );
  assert.deepEqual(
    harness.provider.requests.map((request) => request.effort),
    ["medium", "high"],
  );
  assert.ok(
    harness.provider.requests.every(
      (request) =>
        request.agent.permission === "READ_ONLY" &&
        request.workingDirectory === harness.targetPath,
    ),
  );
  assert.equal(
    await readFile(join(harness.targetPath, "Assets", "Player.cs"), "utf8"),
    beforePlayer,
  );

  const approved = await harness.analysisService.approve(harness.task.id);
  assert.equal(approved.task.state, "READY_FOR_IMPLEMENTATION");
  assert.equal(approved.task.taskContract?.approved, true);
  assert.equal(harness.provider.requests.length, 2);
});

test("blocked architecture creates an editable suggested draft and recheck reuses interpretation", async () => {
  const blockedFeasibility = feasibility({
    status: "BLOCKED_ARCHITECTURE",
    summary: "Building placement architecture is missing.",
    existingCapabilities: ["Economy"],
    missingCapabilities: ["Building Placement System"],
    suggestedPrerequisite: {
      title: "Building Placement System",
      request: "Create a reusable Building Placement System.",
    },
    systemsAffected: ["Economy", "Placement", "UI"],
    architectureImpact: "high",
    implementationComplexity: "high",
    regressionRisk: "medium",
    createsReusableCoreSystem: true,
  });
  const readyAfterRecheck = feasibility({
    status: "READY",
    summary: "The current project now contains reusable building placement.",
    evidence: [
      {
        location: "Assets/BuildingPlacement.cs",
        observation: "Reusable placement validation now exists.",
      },
    ],
    existingCapabilities: ["Economy", "Building Placement System"],
    missingCapabilities: [],
    suggestedPrerequisite: null,
  });
  const towerInterpretation = interpretation({
    title: "Placeable Archer Tower",
    summary: "Add a placeable Archer Tower costing 100 gold.",
    explicitRequirements: [
      "The player can place an Archer Tower.",
      "Successful placement costs 100 gold.",
    ],
  });
  const harness = await createHarness([
    towerInterpretation,
    blockedFeasibility,
    readyAfterRecheck,
  ], {
    originalRequest: "Add a placeable Archer Tower costing 100 gold.",
  });
  await writeFile(
    join(harness.targetPath, "Assets", "Economy.cs"),
    "public class Economy {}\n",
    "utf8",
  );

  const blocked = await harness.analysisService.analyze(harness.task.id);
  assert.equal(blocked.task.state, "BLOCKED");
  assert.equal(blocked.task.taskContract, undefined);
  assert.equal(blocked.analysis.feasibility?.result.status, "BLOCKED_ARCHITECTURE");
  assert.equal(blocked.task.strength, "STRONG");

  const draft = await harness.taskService.createPrerequisiteDraft(
    harness.task.id,
    {},
  );
  assert.equal(draft.parentTask.state, "BLOCKED");
  assert.equal(draft.prerequisiteDraft.state, "DRAFT");
  assert.equal(
    draft.prerequisiteDraft.originalRequest,
    "Create a reusable Building Placement System.",
  );
  const editedDraft = await harness.taskService.editDraft(
    draft.prerequisiteDraft.id,
    { originalRequest: "Create a reusable grid-aware Building Placement System." },
  );
  assert.equal(editedDraft.state, "DRAFT");
  assert.equal((await harness.taskService.get(harness.task.id)).state, "BLOCKED");

  await writeFile(
    join(harness.targetPath, "Assets", "BuildingPlacement.cs"),
    "public class BuildingPlacement {}\n",
    "utf8",
  );
  const rechecked = await harness.analysisService.recheck(harness.task.id);
  assert.equal(rechecked.task.state, "WAITING_FOR_APPROVAL");
  assert.equal(rechecked.task.analysis?.recheckCount, 1);
  assert.equal(harness.provider.requests.length, 3);
  assert.deepEqual(
    harness.provider.requests.map((request) => request.agent.id),
    ["task-interpreter", "feasibility", "feasibility"],
  );
  assert.equal(
    rechecked.analysis.interpretation?.runId,
    blocked.analysis.interpretation?.runId,
  );
  assert.match(
    rechecked.analysis.feasibility?.result.evidence[0]?.location ?? "",
    /BuildingPlacement/u,
  );
});

test("AUTO_FIXABLE and BLOCKED_USER are blockers and install or execute nothing", async () => {
  for (const status of ["AUTO_FIXABLE", "BLOCKED_USER"] as const) {
    const resultValue = feasibility({
      status,
      summary:
        status === "AUTO_FIXABLE"
          ? "An approved official package is missing."
          : "A material authority decision is required.",
      autoFixableDependencies:
        status === "AUTO_FIXABLE" ? ["Official test package"] : [],
      missingCapabilities:
        status === "BLOCKED_USER" ? ["Networking authority decision"] : [],
    });
    const harness = await createHarness([interpretation(), resultValue]);
    const before = await readFile(join(harness.targetPath, "Assets", "Player.cs"), "utf8");
    const analyzed = await harness.analysisService.analyze(harness.task.id);
    assert.equal(analyzed.task.state, "BLOCKED");
    assert.equal(analyzed.task.taskContract, undefined);
    assert.equal(analyzed.analysis.feasibility?.result.status, status);
    assert.equal(harness.provider.requests.length, 2);
    assert.equal(
      await readFile(join(harness.targetPath, "Assets", "Player.cs"), "utf8"),
      before,
    );
  }
});

test("technical provider failure becomes FAILED analysis without fake feasibility or escalation", async () => {
  const harness = await createHarness([
    interpretation(),
    {
      kind: "failure",
      status: "TIMED_OUT",
      code: "EXECUTION_TIMEOUT",
      message: "Synthetic timeout.",
    },
  ]);
  await assert.rejects(
    () => harness.analysisService.analyze(harness.task.id),
    (error: unknown) =>
      error instanceof ServerError &&
      error.code === "ANALYSIS_EXECUTION_FAILED" &&
      (error.details as { causeCode?: string }).causeCode === "EXECUTION_TIMEOUT",
  );
  const failed = await harness.taskService.get(harness.task.id);
  assert.equal(failed.state, "FAILED");
  assert.equal(failed.feasibility, undefined);
  assert.equal(failed.analysisFailure?.phase, "FEASIBILITY");
  assert.equal(failed.analysisFailure?.code, "EXECUTION_TIMEOUT");
  assert.equal(harness.provider.requests.length, 2);
  assert.equal(harness.provider.requests[1]?.model.id, "codex-terra");
  const artifacts = await harness.artifactStore.get(failed.id);
  assert.equal(artifacts?.failure?.code, "EXECUTION_TIMEOUT");
  assert.equal(artifacts?.feasibility, undefined);
  assert.equal(artifacts?.routing, undefined);
});

test("invalid interpretation artifact is rerun on recheck while valid interpretation costs no extra call", async () => {
  const blocked = feasibility({
    status: "BLOCKED_ARCHITECTURE",
    missingCapabilities: ["Placement"],
    suggestedPrerequisite: {
      title: "Placement",
      request: "Create placement architecture.",
    },
  });
  const harness = await createHarness([
    interpretation(),
    blocked,
    interpretation({ title: "Reinterpreted task" }),
    feasibility(),
  ]);
  await harness.analysisService.analyze(harness.task.id);
  await writeFile(
    join(
      harness.runtimeRoot,
      "tasks",
      harness.task.id,
      "analysis",
      "interpretation.json",
    ),
    "{invalid-json",
    "utf8",
  );
  const result = await harness.analysisService.recheck(harness.task.id);
  assert.equal(result.task.state, "WAITING_FOR_APPROVAL");
  assert.equal(result.analysis.interpretation?.result.title, "Reinterpreted task");
  assert.deepEqual(
    harness.provider.requests.map((request) => request.agent.id),
    ["task-interpreter", "feasibility", "task-interpreter", "feasibility"],
  );
});

test("read-only verification catches a misbehaving provider without reverting user files", async () => {
  let targetPath = "";
  const mutatingFeasibility: FakeResponse = async () => {
    await writeFile(join(targetPath, "Assets", "Unexpected.cs"), "modified\n", "utf8");
    return feasibility();
  };
  const harness = await createHarness([interpretation(), mutatingFeasibility]);
  targetPath = harness.targetPath;
  await assert.rejects(
    () => harness.analysisService.analyze(harness.task.id),
    (error: unknown) =>
      error instanceof ServerError &&
      error.code === "TARGET_PROJECT_MODIFIED_DURING_ANALYSIS",
  );
  const failed = await harness.taskService.get(harness.task.id);
  assert.equal(failed.state, "FAILED");
  assert.equal(failed.analysisFailure?.phase, "READ_ONLY_VERIFICATION");
  assert.equal(
    await readFile(join(targetPath, "Assets", "Unexpected.cs"), "utf8"),
    "modified\n",
  );
});

test("same-task concurrent analysis is rejected by a small in-process guard", async () => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayedInterpretation: FakeResponse = async () => {
    started?.();
    await releasePromise;
    return interpretation();
  };
  const harness = await createHarness([delayedInterpretation, feasibility()]);
  const first = harness.analysisService.analyze(harness.task.id);
  await startedPromise;
  await assert.rejects(
    () => harness.analysisService.analyze(harness.task.id),
    (error: unknown) =>
      error instanceof ServerError && error.code === "TASK_ANALYSIS_IN_PROGRESS",
  );
  release?.();
  assert.equal((await first).task.state, "WAITING_FOR_APPROVAL");
});

test("analysis artifacts validate and reload after restart without raw provider credentials", async () => {
  const harness = await createHarness([interpretation(), feasibility()]);
  await harness.analysisService.analyze(harness.task.id);
  const restarted = new AnalysisArtifactStore(harness.runtimeRoot);
  await restarted.initialize();
  const reloaded = await restarted.get(harness.task.id);
  assert.equal(reloaded?.interpretation?.result.title, "Dash action");
  assert.equal(reloaded?.feasibility?.result.status, "READY");
  assert.equal(reloaded?.routing?.taskStrength, "STANDARD");
  assert.equal(reloaded?.contract?.approved, false);
  const analysisRoot = join(
    harness.runtimeRoot,
    "tasks",
    harness.task.id,
    "analysis",
  );
  const combined = (
    await Promise.all(
      ["interpretation.json", "feasibility.json", "routing.json", "contract.json"].map(
        (name) => readFile(join(analysisRoot, name), "utf8"),
      ),
    )
  ).join("\n");
  assert.doesNotMatch(combined, /api[_-]?key|authorization|password|secret/iu);

  await writeFile(join(analysisRoot, "routing.json"), "{}", "utf8");
  await assert.rejects(
    () => restarted.get(harness.task.id),
    (error: unknown) =>
      error instanceof ServerError && error.code === "ANALYSIS_ARTIFACT_INVALID",
  );
});

test("M4 HTTP exposes analysis, editable contract, and approval without implementation", async () => {
  const harness = await createHarness([interpretation(), feasibility()]);
  const gitContext = await createGitTestContext();
  roots.add(gitContext.root);
  const server = createUnityAiServer(
    harness.taskService,
    gitContext.gitService,
    undefined,
    harness.analysisService,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const analyzed = await fetch(`${baseUrl}/tasks/${harness.task.id}/analyze`, {
      method: "POST",
    });
    assert.equal(analyzed.status, 200);
    const analysis = await fetch(`${baseUrl}/tasks/${harness.task.id}/analysis`);
    assert.equal(analysis.status, 200);

    const edited = await fetch(`${baseUrl}/tasks/${harness.task.id}/contract`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        implementationScope: ["Add dash while preserving ordinary movement."],
      }),
    });
    assert.equal(edited.status, 200);
    const editedBody = (await edited.json()) as { task: Task };
    assert.deepEqual(editedBody.task.taskContract?.implementationScope, [
      "Add dash while preserving ordinary movement.",
    ]);

    const approved = await fetch(`${baseUrl}/tasks/${harness.task.id}/approve`, {
      method: "POST",
    });
    assert.equal(approved.status, 200);
    const approvedBody = (await approved.json()) as { task: Task };
    assert.equal(approvedBody.task.state, "READY_FOR_IMPLEMENTATION");

    const forbiddenEdit = await fetch(`${baseUrl}/tasks/${harness.task.id}/contract`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonGoals: ["No stamina."] }),
    });
    assert.equal(forbiddenEdit.status, 409);
    assert.equal(harness.provider.requests.length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    roots.delete(gitContext.root);
    await removeTemporaryRoot(gitContext.root);
  }
});
