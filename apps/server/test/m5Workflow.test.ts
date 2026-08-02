import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  beginTaskImplementation,
  buildExecutionRoutingSnapshot,
} from "@unityai/core";
import type {
  JsonValue,
  ModelConfiguration,
  Task,
  TaskSettings,
} from "@unityai/core";

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
import { ExecutionArtifactStore } from "../src/executionArtifactStore.js";
import { GitEnvironmentStore } from "../src/gitEnvironmentStore.js";
import { GitSafetyService } from "../src/gitSafetyService.js";
import { ImplementationOrchestrator } from "../src/implementationOrchestrator.js";
import { ModelRegistry } from "../src/modelRegistry.js";
import { OrchestrationArtifactStore } from "../src/orchestrationArtifactStore.js";
import { ProjectRegistry } from "../src/projectRegistry.js";
import { ProviderRegistry } from "../src/providerRegistry.js";
import { ServerError } from "../src/errors.js";
import { SettingsStore } from "../src/settingsStore.js";
import { TaskService } from "../src/taskService.js";
import { TaskStore } from "../src/taskStore.js";
import { WorkflowService } from "../src/workflowService.js";
import {
  createTemporaryRoot,
  initializeRepository,
  removeTemporaryRoot,
} from "./gitTestHelpers.js";

const roots = new Set<string>();

afterEach(async () => {
  const current = [...roots];
  roots.clear();
  await Promise.all(current.map(removeTemporaryRoot));
});

const defaults: TaskSettings = {
  crossReviewEnabled: true,
  automaticFixesEnabled: true,
};

interface FailureOutput {
  readonly failure: true;
  readonly status: "FAILED" | "CANCELLED" | "TIMED_OUT";
  readonly code: "PROVIDER_EXIT_FAILURE" | "EXECUTION_CANCELLED" | "EXECUTION_TIMEOUT";
  readonly message: string;
}

type Handler = (
  request: ProviderExecutionRequest,
) => Promise<JsonValue | FailureOutput>;

const isFailureOutput = (value: JsonValue | FailureOutput): value is FailureOutput =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "failure" in value &&
  value.failure === true &&
  "status" in value &&
  typeof value.status === "string" &&
  "code" in value &&
  typeof value.code === "string" &&
  "message" in value &&
  typeof value.message === "string";

class ScenarioProvider implements AIProvider {
  readonly id: string;
  readonly requests: ProviderExecutionRequest[] = [];
  private readonly handler: Handler;

  constructor(id: string, handler: Handler) {
    this.id = id;
    this.handler = handler;
  }

  async availability(): Promise<ProviderAvailability> {
    return {
      providerId: this.id,
      status: "AVAILABLE",
      cliAvailable: true,
      authentication: "AUTHENTICATED",
      message: "Fake provider available.",
    };
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
    this.requests.push(request);
    const output = await this.handler(request);
    const timestamp = new Date().toISOString();
    if (isFailureOutput(output)) {
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
    return {
      providerId: this.id,
      status: "SUCCEEDED",
      finalOutput: JSON.stringify(output),
      structuredOutput: output,
      stdout: JSON.stringify(output),
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

const implementationOutput = {
  summary: "Added the requested feature.",
  changedFiles: ["feature.txt"],
  implementationNotes: ["Integrated with the fixture."],
  sanityChecks: ["Inspected the created file."],
  warnings: [],
} as const;

const reviewPass = {
  status: "PASS",
  summary: "The implementation matches the approved contract.",
  findings: [],
  qaFocus: ["Verify the behavior when QA becomes available."],
} as const;

interface Harness {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly baseCommit: string;
  readonly runtimeRoot: string;
  readonly taskService: TaskService;
  readonly gitService: GitSafetyService;
  readonly aiService: AIService;
  readonly analysisArtifacts: AnalysisArtifactStore;
  readonly orchestrationArtifacts: OrchestrationArtifactStore;
  readonly orchestrator: ImplementationOrchestrator;
  readonly codex: ScenarioProvider;
  readonly claude: ScenarioProvider;
  readonly modelConfiguration: ModelConfiguration;
}

const createHarness = async (
  implementation: Handler = async (request) => {
    await writeFile(join(request.workingDirectory, "feature.txt"), "ready\n", "utf8");
    return implementationOutput;
  },
  review: Handler = async () => reviewPass,
  modelConfigurationOverride?: ModelConfiguration,
): Promise<Harness> => {
  const root = await createTemporaryRoot();
  roots.add(root);
  const repository = await initializeRepository(root);
  if (repository.baseCommit === undefined) {
    throw new Error("Fixture repository requires a base commit.");
  }
  const runtimeRoot = join(root, "runtime");
  const taskStore = new TaskStore(runtimeRoot);
  await taskStore.initialize();
  const taskService = new TaskService(taskStore, defaults);
  const gitStore = new GitEnvironmentStore(runtimeRoot);
  await gitStore.initialize();
  const gitService = new GitSafetyService(
    taskService,
    gitStore,
    join(runtimeRoot, "worktrees"),
    repository.runner,
  );
  const agents = await AgentRegistry.load(join(process.cwd(), "agents"));
  const modelConfiguration =
    modelConfigurationOverride ??
    (await loadModelConfiguration(join(process.cwd(), "config", "models.json")));
  const models = new ModelRegistry(modelConfiguration);
  const codex = new ScenarioProvider("codex", implementation);
  const claude = new ScenarioProvider("claude", review);
  const providers = new ProviderRegistry([codex, claude]);
  const executionArtifacts = new ExecutionArtifactStore(runtimeRoot, 16_384);
  await executionArtifacts.initialize();
  const executor = new AgentExecutor(
    agents,
    models,
    providers,
    executionArtifacts,
    20_000,
  );
  const aiService = new AIService(agents, models, providers, executor);
  const analysisArtifacts = new AnalysisArtifactStore(runtimeRoot);
  await analysisArtifacts.initialize();
  const orchestrationArtifacts = new OrchestrationArtifactStore(runtimeRoot);
  await orchestrationArtifacts.initialize();
  const orchestrator = new ImplementationOrchestrator(
    taskService,
    gitService,
    aiService,
    analysisArtifacts,
    orchestrationArtifacts,
  );
  return {
    root,
    repositoryRoot: repository.repositoryRoot,
    baseCommit: repository.baseCommit,
    runtimeRoot,
    taskService,
    gitService,
    aiService,
    analysisArtifacts,
    orchestrationArtifacts,
    orchestrator,
    codex,
    claude,
    modelConfiguration,
  };
};

const approveTask = async (
  harness: Harness,
  reviewEnabled: boolean,
  routingOverride?: ReturnType<typeof buildExecutionRoutingSnapshot>,
): Promise<Task> => {
  const created = await harness.taskService.create({
    title: "Synthetic M5 task",
    originalRequest: "Add feature.txt containing ready.",
    targetProjectPath: harness.repositoryRoot,
    strength: "STANDARD",
    crossReviewEnabled: reviewEnabled,
  });
  await harness.taskService.analyze(created.id);
  await harness.taskService.storeFeasibility(created.id, {
    status: "READY",
    summary: "The fixture supports a text-file change.",
    missingCapabilities: [],
  });
  const routing = routingOverride ?? buildExecutionRoutingSnapshot(
    harness.modelConfiguration,
    "STANDARD",
    reviewEnabled,
    true,
  );
  await harness.taskService.storeContract(created.id, {
    originalTaskSummary: "Add a feature status file.",
    understoodExplicitRequirements: ["Create feature.txt containing ready."],
    inferredRequirements: [],
    prerequisites: [],
    implementationScope: ["Create feature.txt."],
    nonGoals: ["Do not change README.md."],
    acceptanceCriteria: ["feature.txt contains ready."],
    testRequirements: ["STATIC: Inspect feature.txt."],
    taskStrength: "STANDARD",
    executionPlan: routing,
  });
  return harness.taskService.approve(created.id);
};

test("project registry and settings persist without touching registered files or old task settings", async () => {
  const root = await createTemporaryRoot();
  roots.add(root);
  const repository = await initializeRepository(root);
  const runtimeRoot = join(root, "runtime");
  const registry = new ProjectRegistry(runtimeRoot, repository.runner);
  await registry.initialize();
  const project = await registry.create({
    displayName: "Fixture",
    path: repository.repositoryRoot,
  });
  assert.equal(project.path, repository.repositoryRoot);
  const reloaded = new ProjectRegistry(runtimeRoot, repository.runner);
  await reloaded.initialize();
  assert.equal(reloaded.get(project.id).displayName, "Fixture");
  await reloaded.remove(project.id);
  assert.equal(await readFile(join(repository.repositoryRoot, "README.md"), "utf8"), "initial\n");

  const settings = new SettingsStore(runtimeRoot);
  await settings.initialize(defaults);
  const taskStore = new TaskStore(runtimeRoot);
  await taskStore.initialize();
  const tasks = new TaskService(taskStore, settings.get());
  const oldTask = await tasks.create({ originalRequest: "Old task" });
  const updated = await settings.update({ crossReviewEnabled: false });
  tasks.setSettings(updated);
  const newTask = await tasks.create({ originalRequest: "New task" });
  assert.equal(oldTask.crossReviewEnabled, true);
  assert.equal((await tasks.get(oldTask.id)).crossReviewEnabled, true);
  assert.equal(newTask.crossReviewEnabled, false);
  assert.equal(newTask.automaticFixesEnabled, true);

  const nonGit = join(root, "not-git");
  await mkdir(nonGit);
  await assert.rejects(
    () => reloaded.create({ displayName: "Not Git", path: nonGit }),
    (error: unknown) => error instanceof ServerError && error.code === "NOT_A_GIT_REPOSITORY",
  );
});

test("Cross Review ON implements only in the managed worktree, checkpoints, reviews read-only, and stops READY_FOR_QA", async () => {
  const harness = await createHarness();
  const task = await approveTask(harness, true);
  const originalReadme = await readFile(join(harness.repositoryRoot, "README.md"), "utf8");
  await harness.orchestrator.start(task.id);
  const finished = await harness.orchestrator.waitForIdle(task.id);
  assert.equal(finished.state, "READY_FOR_QA");
  assert.notEqual(finished.state, "COMPLETED");
  assert.equal(harness.codex.requests.length, 1);
  assert.equal(harness.claude.requests.length, 1);
  const implementationRequest = harness.codex.requests[0]!;
  const reviewRequest = harness.claude.requests[0]!;
  assert.equal(implementationRequest.agent.permission, "WORKTREE_WRITE");
  assert.equal(reviewRequest.agent.permission, "READ_ONLY");
  assert.equal(implementationRequest.workingDirectory, reviewRequest.workingDirectory);
  await access(join(implementationRequest.workingDirectory, "feature.txt"));
  await assert.rejects(() => access(join(harness.repositoryRoot, "feature.txt")));
  assert.equal(await readFile(join(harness.repositoryRoot, "README.md"), "utf8"), originalReadme);
  const environment = await harness.gitService.getEnvironment(task.id);
  assert.equal(environment?.checkpoints.length, 1);
  assert.equal(environment?.status, "ACTIVE");
  assert.equal(environment?.finalCommit, undefined);
  const originalHead = (
    await harness.gitService.inspect(task.id)
  ).headCommit;
  assert.equal(originalHead, harness.baseCommit);
  const artifacts = await harness.orchestrationArtifacts.get(task.id);
  assert.equal(artifacts.implementation?.checkpointId, "CHECKPOINT-0001");
  assert.equal(artifacts.review?.status, "PASS");
  assert.equal(artifacts.gitSnapshot?.isClean, true);
});

test("Cross Review OFF skips the reviewer while findings persist without any fix loop", async (t) => {
  await t.test("review off", async () => {
    const harness = await createHarness();
    const task = await approveTask(harness, false);
    await harness.orchestrator.start(task.id);
    const finished = await harness.orchestrator.waitForIdle(task.id);
    assert.equal(finished.state, "READY_FOR_QA");
    assert.equal(harness.claude.requests.length, 0);
    assert.equal((await harness.orchestrationArtifacts.get(task.id)).review, undefined);
  });

  await t.test("findings", async () => {
    const harness = await createHarness(undefined, async () => ({
      status: "FINDINGS",
      summary: "Two issues need future QA attention.",
      findings: [
        {
          id: "REVIEW-001",
          severity: "warning",
          title: "Check encoding",
          description: "Confirm the text encoding is suitable.",
          evidence: "feature.txt was added.",
          relatedFiles: ["feature.txt"],
        },
        {
          id: "REVIEW-002",
          severity: "blocking",
          title: "Runtime evidence absent",
          description: "Runtime behavior was not exercised.",
          evidence: "Review is static only.",
          relatedFiles: ["feature.txt"],
        },
      ],
      qaFocus: ["Validate runtime consumption."],
    }));
    const task = await approveTask(harness, true);
    await harness.orchestrator.start(task.id);
    const finished = await harness.orchestrator.waitForIdle(task.id);
    assert.equal(finished.state, "READY_FOR_QA");
    const artifacts = await harness.orchestrationArtifacts.get(task.id);
    assert.equal(artifacts.review?.findings.length, 2);
    assert.deepEqual(artifacts.review?.qaFocus, ["Validate runtime consumption."]);
    assert.equal(harness.codex.requests.length, 1, "review findings must not launch fixes");
  });
});

test("dirty original worktree blocks before implementation and leaves user changes untouched", async () => {
  const harness = await createHarness();
  const task = await approveTask(harness, true);
  const userFile = join(harness.repositoryRoot, "user-work.txt");
  await writeFile(userFile, "do not touch\n", "utf8");
  await harness.orchestrator.start(task.id);
  const finished = await harness.orchestrator.waitForIdle(task.id);
  assert.equal(finished.state, "READY_FOR_IMPLEMENTATION");
  assert.equal(harness.codex.requests.length, 0);
  assert.equal(await readFile(userFile, "utf8"), "do not touch\n");
  assert.equal((await harness.orchestrationArtifacts.get(task.id)).failure?.code, "TARGET_WORKTREE_DIRTY");
  assert.equal(await harness.gitService.getEnvironment(task.id), undefined);
});

test("approved routing snapshot stays authoritative after global model details change", async () => {
  const current = await loadModelConfiguration(join(process.cwd(), "config", "models.json"));
  const changed: ModelConfiguration = {
    ...current,
    models: current.models.map((model) =>
      model.id === "codex-sol"
        ? { ...model, providerModelName: "global-model-b" }
        : model,
    ),
  };
  let invokedProviderModelName = "";
  const harness = await createHarness(async (request) => {
    invokedProviderModelName = request.model.providerModelName;
    await writeFile(join(request.workingDirectory, "feature.txt"), "ready\n", "utf8");
    return implementationOutput;
  }, undefined, changed);
  const proposed = buildExecutionRoutingSnapshot(changed, "STANDARD", false, true);
  const approved = {
    ...proposed,
    implementation: { ...proposed.implementation, providerModelName: "approved-model-a" },
    fix: {
      ...proposed.fix,
      plan: { ...proposed.fix.plan, providerModelName: "approved-model-a" },
    },
  };
  const task = await approveTask(harness, false, approved);
  await harness.orchestrator.start(task.id);
  assert.equal((await harness.orchestrator.waitForIdle(task.id)).state, "READY_FOR_QA");
  assert.equal(invokedProviderModelName, "approved-model-a");
});

test("no-change and technical provider failures preserve worktrees, do not escalate, finalize, merge, or push", async (t) => {
  await t.test("success without changes is rejected", async () => {
    const harness = await createHarness(async () => implementationOutput);
    const task = await approveTask(harness, false);
    await harness.orchestrator.start(task.id);
    const failed = await harness.orchestrator.waitForIdle(task.id);
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.executionFailure?.code, "IMPLEMENTATION_NO_CHANGES");
    assert.notEqual((await harness.gitService.getEnvironment(task.id))?.status, "FINALIZED");
  });

  await t.test("technical failure is one call with preserved worktree", async () => {
    const harness = await createHarness(async () => ({
      failure: true,
      status: "FAILED",
      code: "PROVIDER_EXIT_FAILURE",
      message: "Synthetic failure.",
    }));
    const task = await approveTask(harness, false);
    await harness.orchestrator.start(task.id);
    const failed = await harness.orchestrator.waitForIdle(task.id);
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.executionFailure?.phase, "IMPLEMENTATION");
    assert.equal(harness.codex.requests.length, 1);
    const environment = await harness.gitService.getEnvironment(task.id);
    assert.equal(environment?.status, "ACTIVE");
    assert.equal(environment?.finalCommit, undefined);
    assert.equal((await harness.gitService.inspect(task.id)).headCommit, harness.baseCommit);
  });
});

test("double starts are rejected and cancellation terminates the provider without destroying its worktree", async () => {
  let executionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    executionStarted = resolve;
  });
  const harness = await createHarness(async (request) => {
    executionStarted();
    await new Promise<void>((resolve) => {
      request.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return {
      failure: true,
      status: "CANCELLED",
      code: "EXECUTION_CANCELLED",
      message: "Cancelled.",
    };
  });
  const task = await approveTask(harness, false);
  await harness.orchestrator.start(task.id);
  await started;
  await assert.rejects(
    () => harness.orchestrator.start(task.id),
    (error: unknown) =>
      error instanceof ServerError && error.code === "TASK_IMPLEMENTATION_IN_PROGRESS",
  );
  assert.equal(harness.orchestrator.abort(task.id), true);
  await harness.taskService.cancel(task.id, {});
  const cancelled = await harness.orchestrator.waitForIdle(task.id);
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal((await harness.gitService.getEnvironment(task.id))?.status, "ACTIVE");
});

test("restart recovery records interruption instead of fake success and preserves the managed worktree", async () => {
  const harness = await createHarness();
  const task = await approveTask(harness, false);
  const environment = await harness.gitService.prepare(task.id);
  const implementing = beginTaskImplementation(task, {
    taskBranch: environment.taskBranch,
    worktreePath: environment.taskWorktreePath,
  });
  await harness.taskService.saveTask(implementing);
  const recovered = await harness.orchestrator.recoverInterruptedRuns();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.state, "FAILED");
  assert.equal(recovered[0]?.executionFailure?.code, "SERVER_RESTART_INTERRUPTED");
  assert.equal((await harness.gitService.getEnvironment(task.id))?.status, "ACTIVE");
});

test("M5 HTTP exposes project/settings/task workflow and registry deletion remains metadata-only", async () => {
  const harness = await createHarness();
  const projects = new ProjectRegistry(harness.runtimeRoot);
  await projects.initialize();
  const settings = new SettingsStore(harness.runtimeRoot);
  await settings.initialize(defaults);
  const workflow = new WorkflowService({
    tasks: harness.taskService,
    projects,
    settings,
    analysis: harness.analysisArtifacts,
    git: harness.gitService,
    orchestration: harness.orchestrator,
    orchestrationArtifacts: harness.orchestrationArtifacts,
  });
  const server = createUnityAiServer(
    harness.taskService,
    harness.gitService,
    harness.aiService,
    undefined,
    {
      projects,
      settings,
      workflow,
      orchestrator: harness.orchestrator,
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected an HTTP address.");
  }
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const projectResponse = await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "HTTP Fixture",
        path: harness.repositoryRoot,
      }),
    });
    assert.equal(projectResponse.status, 201);
    const projectPayload = (await projectResponse.json()) as {
      project: { id: string };
    };
    const settingsResponse = await fetch(`${base}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crossReviewEnabled: false }),
    });
    assert.equal(settingsResponse.status, 200);
    const taskResponse = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: projectPayload.project.id,
        originalRequest: "Add a status file.",
      }),
    });
    assert.equal(taskResponse.status, 201);
    const taskPayload = (await taskResponse.json()) as { task: Task };
    assert.equal(taskPayload.task.targetProjectPath, harness.repositoryRoot);
    assert.equal(taskPayload.task.crossReviewEnabled, false);
    const post = (path: string, body: unknown = {}) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await post(`/tasks/${taskPayload.task.id}/analyze`)).status,
      200,
    );
    assert.equal(
      (
        await post(`/tasks/${taskPayload.task.id}/feasibility`, {
          status: "READY",
          summary: "Ready.",
          missingCapabilities: [],
        })
      ).status,
      200,
    );
    const routing = buildExecutionRoutingSnapshot(
      harness.modelConfiguration,
      "STANDARD",
      false,
      true,
    );
    assert.equal(
      (
        await post(`/tasks/${taskPayload.task.id}/contract`, {
          understoodExplicitRequirements: ["Add a status file."],
          inferredRequirements: [],
          prerequisites: [],
          implementationScope: ["Create feature.txt."],
          acceptanceCriteria: ["feature.txt exists."],
          testRequirements: ["STATIC: Inspect the file."],
          taskStrength: "STANDARD",
          executionPlan: routing,
        })
      ).status,
      200,
    );
    assert.equal(
      (await post(`/tasks/${taskPayload.task.id}/approve`)).status,
      200,
    );
    assert.equal(
      (await post(`/tasks/${taskPayload.task.id}/start-implementation`)).status,
      202,
    );
    assert.equal(
      (await harness.orchestrator.waitForIdle(taskPayload.task.id)).state,
      "READY_FOR_QA",
    );
    assert.equal(
      (await fetch(`${base}/tasks/${taskPayload.task.id}/details`)).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/tasks/${taskPayload.task.id}/progress`)).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/tasks/${taskPayload.task.id}/events`)).status,
      200,
    );
    const deleteResponse = await fetch(
      `${base}/projects/${projectPayload.project.id}`,
      { method: "DELETE" },
    );
    assert.equal(deleteResponse.status, 200);
    assert.equal(await readFile(join(harness.repositoryRoot, "README.md"), "utf8"), "initial\n");
  } finally {
    server.close();
    await once(server, "close");
  }
});
