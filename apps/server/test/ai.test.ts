import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  parseAgentDefinition,
  parseModelConfiguration,
} from "@unityai/core";
import type {
  AgentDefinition,
  ModelConfiguration,
  ModelDefinition,
  ProviderConfiguration,
} from "@unityai/core";

import { AgentExecutor } from "../src/agentExecutor.js";
import { AgentRegistry } from "../src/agentRegistry.js";
import {
  loadAIProviderConfiguration,
  loadModelConfiguration,
} from "../src/aiConfig.js";
import { AIExecutionError } from "../src/aiErrors.js";
import type {
  AIProvider,
  ProviderAvailability,
  ProviderExecutionRequest,
  ProviderExecutionResult,
} from "../src/aiProvider.js";
import { AIService } from "../src/aiService.js";
import { ClaudeProvider, buildClaudeCommand } from "../src/claudeProvider.js";
import { CodexProvider, buildCodexCommand } from "../src/codexProvider.js";
import { ExecutionArtifactStore } from "../src/executionArtifactStore.js";
import { createUnityAiServer } from "../src/app.js";
import { ModelRegistry } from "../src/modelRegistry.js";
import type {
  ProcessExecutionRequest,
  ProcessExecutionResult,
  ProcessRunner,
} from "../src/processRunner.js";
import { SafeProcessRunner } from "../src/processRunner.js";
import { ProviderRegistry } from "../src/providerRegistry.js";
import {
  createGitTestContext,
  removeTemporaryRoot,
} from "./gitTestHelpers.js";

const temporaryRoots = new Set<string>();

const trackRoot = (root: string): string => {
  temporaryRoots.add(root);
  return root;
};

afterEach(async () => {
  const roots = [...temporaryRoots];
  temporaryRoots.clear();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const readOnlyAgent = parseAgentDefinition({
  schemaVersion: 1,
  id: "test-reader",
  displayName: "Test Reader",
  role: "Test the provider boundary",
  instructions: "Return the requested structured result without editing files.",
  permission: "READ_ONLY",
  toolPolicy: "READ_ONLY_TOOLS",
  contextPolicy: {
    includeRepositoryInstructions: true,
    maximumInputCharacters: 10_000,
  },
  expectedOutputSchema: {
    type: "object",
    properties: { status: { type: "string", enum: ["ok"] } },
    required: ["status"],
    additionalProperties: false,
  },
});
const expectedOutputSchema = readOnlyAgent.expectedOutputSchema;
if (expectedOutputSchema === undefined) {
  throw new Error("Test read-only agent must define structured output.");
}

const writableAgent = parseAgentDefinition({
  ...readOnlyAgent,
  id: "test-writer",
  permission: "WORKTREE_WRITE",
  toolPolicy: "WORKTREE_TOOLS",
  expectedOutputSchema: undefined,
});

const createModel = (
  id: string,
  providerId: string,
  efforts: readonly ("low" | "medium" | "high")[] = ["medium"],
): ModelDefinition => ({
  id,
  displayName: id,
  providerId,
  providerModelName: `${providerId}-native-model`,
  supportedReasoningEfforts: efforts,
  capabilities: { structuredOutput: true },
});

const configurationFor = (
  models: readonly ModelDefinition[],
): ModelConfiguration =>
  parseModelConfiguration({
    schemaVersion: 1,
    models,
    routing: [],
    fixWork: "SAME_AS_IMPLEMENTATION",
    runtimeEscalation: false,
  });

const available = (providerId: string): ProviderAvailability => ({
  providerId,
  status: "AVAILABLE",
  cliAvailable: true,
  authentication: "AUTHENTICATED",
  version: "test-version",
  message: "Available for tests.",
});

const executionResult = (
  providerId: string,
  overrides: Partial<ProviderExecutionResult> = {},
): ProviderExecutionResult => {
  const timestamp = new Date().toISOString();
  return {
    providerId,
    status: "SUCCEEDED",
    finalOutput: '{"status":"ok"}',
    structuredOutput: { status: "ok" },
    stdout: "provider stdout",
    stderr: "provider stderr",
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: 0,
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 0,
    ...overrides,
  };
};

class FakeProvider implements AIProvider {
  readonly id: string;
  readonly requests: ProviderExecutionRequest[] = [];
  private readonly availabilityResult: ProviderAvailability;
  private readonly resultFactory: (
    request: ProviderExecutionRequest,
  ) => ProviderExecutionResult;

  constructor(
    id: string,
    resultFactory: (
      request: ProviderExecutionRequest,
    ) => ProviderExecutionResult = () => executionResult(id),
    availabilityResult: ProviderAvailability = available(id),
  ) {
    this.id = id;
    this.resultFactory = resultFactory;
    this.availabilityResult = availabilityResult;
  }

  async availability(): Promise<ProviderAvailability> {
    return this.availabilityResult;
  }

  async execute(
    request: ProviderExecutionRequest,
  ): Promise<ProviderExecutionResult> {
    this.requests.push(request);
    return this.resultFactory(request);
  }
}

interface ExecutorHarness {
  readonly root: string;
  readonly workingDirectory: string;
  readonly agents: AgentRegistry;
  readonly models: ModelRegistry;
  readonly providers: ProviderRegistry;
  readonly artifacts: ExecutionArtifactStore;
  readonly executor: AgentExecutor;
  readonly aiService: AIService;
}

const createHarness = async (
  providers: readonly AIProvider[],
  models: readonly ModelDefinition[],
  agents: readonly AgentDefinition[] = [readOnlyAgent, writableAgent],
  maximumLogBytes = 1_024,
): Promise<ExecutorHarness> => {
  const root = trackRoot(await mkdtemp(join(tmpdir(), "unityai-m3-test-")));
  const workingDirectory = join(root, "working");
  await mkdir(workingDirectory);
  const agentRegistry = new AgentRegistry(agents);
  const modelRegistry = new ModelRegistry(configurationFor(models));
  const providerRegistry = new ProviderRegistry(providers);
  const artifacts = new ExecutionArtifactStore(root, maximumLogBytes);
  await artifacts.initialize();
  const executor = new AgentExecutor(
    agentRegistry,
    modelRegistry,
    providerRegistry,
    artifacts,
    10_000,
  );
  return {
    root,
    workingDirectory,
    agents: agentRegistry,
    models: modelRegistry,
    providers: providerRegistry,
    artifacts,
    executor,
    aiService: new AIService(
      agentRegistry,
      modelRegistry,
      providerRegistry,
      executor,
    ),
  };
};

const executeBody = (workingDirectory: string, modelId: string) => ({
  agentId: readOnlyAgent.id,
  modelId,
  effort: "medium",
  workingDirectory,
  input: "Return the configured JSON probe result.",
});

test("repository agent, provider, model, and routing configuration load independently", async () => {
  const workspaceRoot = process.cwd();
  const agents = await AgentRegistry.load(join(workspaceRoot, "agents"));
  assert.equal(agents.list().length, 2);
  assert.equal(agents.get("m3-readonly-json").permission, "READ_ONLY");
  assert.equal(
    agents.get("m3-worktree-writer").permission,
    "WORKTREE_WRITE",
  );

  const models = await loadModelConfiguration(
    join(workspaceRoot, "config", "models.json"),
  );
  const providers = await loadAIProviderConfiguration(
    join(workspaceRoot, "config", "providers.json"),
  );
  assert.equal(models.models.length, 3);
  assert.equal(models.routing.length, 11);
  assert.equal(models.runtimeEscalation, false);
  assert.equal(models.fixWork, "SAME_AS_IMPLEMENTATION");
  assert.deepEqual(
    new Set(models.models.map((model) => model.providerId)),
    new Set(["codex", "claude"]),
  );
  assert.deepEqual(
    providers.providers.map((provider) => provider.id),
    ["codex", "claude"],
  );
});

test("one unchanged agent executes through two explicit models and providers", async () => {
  const codex = new FakeProvider("codex");
  const claude = new FakeProvider("claude");
  const harness = await createHarness(
    [codex, claude],
    [createModel("model-a", "codex"), createModel("model-b", "claude")],
    [readOnlyAgent],
  );

  const first = await harness.executor.execute(
    executeBody(harness.workingDirectory, "model-a"),
  );
  const second = await harness.executor.execute(
    executeBody(harness.workingDirectory, "model-b"),
  );
  assert.equal(first.providerId, "codex");
  assert.equal(second.providerId, "claude");
  assert.equal(codex.requests[0]?.agent, readOnlyAgent);
  assert.equal(claude.requests[0]?.agent, readOnlyAgent);
  assert.equal(
    codex.requests[0]?.workingDirectory,
    harness.workingDirectory,
  );
  assert.equal("arguments" in (codex.requests[0] ?? {}), false);
  assert.equal("executable" in (codex.requests[0] ?? {}), false);
});

test("registry, model, effort, and availability failures are typed", async (t) => {
  await t.test("unknown provider", async () => {
    const harness = await createHarness(
      [],
      [createModel("orphan-model", "missing-provider")],
      [readOnlyAgent],
    );
    await assert.rejects(
      () =>
        harness.executor.execute(
          executeBody(harness.workingDirectory, "orphan-model"),
        ),
      (error: unknown) =>
        error instanceof AIExecutionError &&
        error.code === "PROVIDER_NOT_FOUND",
    );
  });

  await t.test("missing model", async () => {
    const harness = await createHarness(
      [new FakeProvider("codex")],
      [createModel("known-model", "codex")],
      [readOnlyAgent],
    );
    await assert.rejects(
      () =>
        harness.executor.execute(
          executeBody(harness.workingDirectory, "missing-model"),
        ),
      (error: unknown) =>
        error instanceof AIExecutionError &&
        error.code === "MODEL_NOT_CONFIGURED",
    );
  });

  await t.test("unsupported effort", async () => {
    const harness = await createHarness(
      [new FakeProvider("codex")],
      [createModel("medium-only", "codex")],
      [readOnlyAgent],
    );
    await assert.rejects(
      () =>
        harness.executor.execute({
          ...executeBody(harness.workingDirectory, "medium-only"),
          effort: "high",
        }),
      (error: unknown) =>
        error instanceof AIExecutionError &&
        error.code === "UNSUPPORTED_REASONING_EFFORT",
    );
  });

  await t.test("unavailable provider", async () => {
    const provider = new FakeProvider(
      "codex",
      () => executionResult("codex"),
      {
        providerId: "codex",
        status: "AUTHENTICATION_REQUIRED",
        cliAvailable: true,
        authentication: "UNAUTHENTICATED",
        message: "Authentication is required.",
      },
    );
    const harness = await createHarness(
      [provider],
      [createModel("unavailable-model", "codex")],
      [readOnlyAgent],
    );
    await assert.rejects(
      () =>
        harness.executor.execute(
          executeBody(harness.workingDirectory, "unavailable-model"),
        ),
      (error: unknown) =>
        error instanceof AIExecutionError &&
        error.code === "PROVIDER_UNAVAILABLE",
    );
    assert.equal(provider.requests.length, 0);
  });
});

test("structured output is validated without a repair or retry loop", async () => {
  const validProvider = new FakeProvider("valid");
  const validHarness = await createHarness(
    [validProvider],
    [createModel("valid-model", "valid")],
    [readOnlyAgent],
  );
  const valid = await validHarness.executor.execute(
    executeBody(validHarness.workingDirectory, "valid-model"),
  );
  assert.equal(valid.status, "SUCCEEDED");
  assert.deepEqual(valid.structuredOutput, { status: "ok" });

  const invalidProvider = new FakeProvider("invalid", () =>
    executionResult("invalid", {
      finalOutput: '{"status":"wrong"}',
      structuredOutput: { status: "wrong" },
    }),
  );
  const invalidHarness = await createHarness(
    [invalidProvider],
    [createModel("invalid-model", "invalid")],
    [readOnlyAgent],
  );
  const invalid = await invalidHarness.executor.execute(
    executeBody(invalidHarness.workingDirectory, "invalid-model"),
  );
  assert.equal(invalid.status, "FAILED");
  assert.equal(
    invalid.failure?.code,
    "STRUCTURED_OUTPUT_VALIDATION_FAILED",
  );
  assert.equal(invalidProvider.requests.length, 1);
});

test("provider non-zero exits become normalized failures", async () => {
  const processRunner: ProcessRunner = {
    async run(): Promise<ProcessExecutionResult> {
      const timestamp = new Date().toISOString();
      return {
        status: "EXITED",
        exitCode: 7,
        stdout: "partial stdout",
        stderr: "provider failed",
        stdoutTruncated: false,
        stderrTruncated: false,
        startedAt: timestamp,
        finishedAt: timestamp,
        durationMs: 0,
      };
    },
  };
  const configuration: ProviderConfiguration = {
    id: "codex",
    displayName: "Codex",
    executable: "codex",
    enabled: true,
  };
  const provider = new CodexProvider(
    configuration,
    { executable: "codex", argumentPrefix: [] },
    processRunner,
  );
  const model = createModel("codex-model", "codex");
  const result = await provider.execute({
    agent: readOnlyAgent,
    model,
    effort: "medium",
    workingDirectory: process.cwd(),
    prompt: "probe",
    expectedOutputSchema,
    timeoutMs: 10_000,
  });
  assert.equal(result.status, "FAILED");
  assert.equal(result.failure?.code, "PROVIDER_EXIT_FAILURE");
  assert.equal(result.exitCode, 7);
});

test("safe process execution captures output, spawn errors, timeouts, and cancellation", async (t) => {
  const runner = new SafeProcessRunner();
  const processDirectory = async (): Promise<string> =>
    trackRoot(await mkdtemp(join(tmpdir(), "unityai-m3-process-")));

  await t.test("stdout, stderr, and non-zero exit", async () => {
    const workingDirectory = await processDirectory();
    const result = await runner.run({
      executable: process.execPath,
      arguments: [
        "-e",
        "process.stdout.write('stdout-ok'); process.stderr.write('stderr-ok'); process.exit(9)",
      ],
      workingDirectory,
      timeoutMs: 5_000,
    });
    assert.equal(result.status, "EXITED");
    assert.equal(result.exitCode, 9);
    assert.equal(result.stdout, "stdout-ok");
    assert.equal(result.stderr, "stderr-ok");
  });

  await t.test("spawn failure", async () => {
    const workingDirectory = await processDirectory();
    const result = await runner.run({
      executable: "unityai-executable-that-does-not-exist",
      arguments: [],
      workingDirectory,
      timeoutMs: 5_000,
    });
    assert.equal(result.status, "SPAWN_FAILED");
    assert.ok(result.spawnError);
  });

  await t.test("timeout terminates the subprocess", async () => {
    const workingDirectory = await processDirectory();
    const result = await runner.run({
      executable: process.execPath,
      arguments: ["-e", "setInterval(() => {}, 1000)"],
      workingDirectory,
      timeoutMs: 100,
    });
    assert.equal(result.status, "TIMED_OUT");
  });

  await t.test("cancellation terminates the subprocess", async () => {
    const workingDirectory = await processDirectory();
    const controller = new AbortController();
    const pending = runner.run({
      executable: process.execPath,
      arguments: ["-e", "setInterval(() => {}, 1000)"],
      workingDirectory,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    assert.equal(result.status, "CANCELLED");
  });
});

test("execution artifacts are unique, bounded, and exclude secrets and raw input", async () => {
  const secretInput = "do-not-persist-this-plain-input";
  const secretToken = "sk-test-secret-value";
  const provider = new FakeProvider("codex", () =>
    executionResult("codex", {
      stdout: `${"x".repeat(4_000)} OPENAI_API_KEY=secret-value ${secretToken}`,
      stderr: `Authorization: Bearer secret-bearer ${secretToken}`,
    }),
  );
  const harness = await createHarness(
    [provider],
    [createModel("artifact-model", "codex")],
    [readOnlyAgent],
    1_024,
  );
  const body = {
    ...executeBody(harness.workingDirectory, "artifact-model"),
    input: secretInput,
  };
  const first = await harness.executor.execute(body);
  const second = await harness.executor.execute(body);
  assert.notEqual(first.runId, second.runId);

  const request = await readFile(
    join(first.artifactDirectory, "request.json"),
    "utf8",
  );
  const result = await readFile(
    join(first.artifactDirectory, "result.json"),
    "utf8",
  );
  const stdout = await readFile(
    join(first.artifactDirectory, "stdout.log"),
    "utf8",
  );
  const stderr = await readFile(
    join(first.artifactDirectory, "stderr.log"),
    "utf8",
  );
  const persisted = `${request}\n${result}\n${stdout}\n${stderr}`;
  assert.equal(persisted.includes(secretInput), false);
  assert.equal(persisted.includes(secretToken), false);
  assert.equal(persisted.includes("secret-value"), false);
  assert.equal(persisted.includes("secret-bearer"), false);
  assert.ok(Buffer.byteLength(stdout) <= 1_024);
  assert.ok(Buffer.byteLength(stderr) <= 1_024);
  assert.match(request, /"inputDigest"/u);
});

test("Codex and Claude command builders isolate provider flags and prompt stdin", () => {
  const codexModel = createModel("codex-model", "codex", ["medium"]);
  const claudeModel = createModel("claude-model", "claude", ["medium"]);
  const baseRequest = {
    agent: readOnlyAgent,
    effort: "medium" as const,
    workingDirectory: "C:\\safe-worktree",
    prompt: "prompt stays on stdin",
    expectedOutputSchema,
    timeoutMs: 10_000,
  };
  const codex = buildCodexCommand(
    { executable: "codex-native", argumentPrefix: [] },
    { ...baseRequest, model: codexModel },
    { finalOutputPath: "final.json", schemaPath: "schema.json" },
  );
  assert.equal(codex.executable, "codex-native");
  assert.equal(codex.input, "prompt stays on stdin");
  assert.equal(codex.arguments.includes(codex.input), false);
  assert.deepEqual(
    codex.arguments.slice(
      codex.arguments.indexOf("--sandbox"),
      codex.arguments.indexOf("--sandbox") + 2,
    ),
    ["--sandbox", "read-only"],
  );
  assert.ok(
    codex.arguments.includes('model_reasoning_effort="medium"'),
  );

  const claude = buildClaudeCommand(
    { executable: "claude-native", argumentPrefix: [] },
    { ...baseRequest, model: claudeModel },
  );
  assert.equal(claude.executable, "claude-native");
  assert.equal(claude.input, "prompt stays on stdin");
  assert.equal(claude.arguments.includes(claude.input), false);
  assert.ok(claude.arguments.includes("--json-schema"));
  assert.ok(claude.arguments.includes("dontAsk"));
  assert.equal(claude.arguments.includes("--dangerously-skip-permissions"), false);
});

test("M3 HTTP endpoints expose discovery and explicit fake-provider execution", async () => {
  const provider = new FakeProvider("codex");
  const harness = await createHarness(
    [provider],
    [createModel("http-model", "codex")],
    [readOnlyAgent],
  );
  const gitContext = await createGitTestContext();
  temporaryRoots.delete(gitContext.root);
  const server = createUnityAiServer(
    gitContext.taskService,
    gitContext.gitService,
    harness.aiService,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const providers = await fetch(`${baseUrl}/ai/providers`);
    assert.equal(providers.status, 200);
    const providerBody = (await providers.json()) as {
      providers: readonly ProviderAvailability[];
    };
    assert.equal(providerBody.providers[0]?.status, "AVAILABLE");

    const models = await fetch(`${baseUrl}/ai/models`);
    assert.equal(models.status, 200);
    const modelBody = (await models.json()) as ModelConfiguration;
    assert.equal(modelBody.models[0]?.id, "http-model");

    const agents = await fetch(`${baseUrl}/ai/agents`);
    assert.equal(agents.status, 200);

    const execute = await fetch(`${baseUrl}/ai/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        executeBody(harness.workingDirectory, "http-model"),
      ),
    });
    assert.equal(execute.status, 200);
    const executionBody = (await execute.json()) as {
      execution: { status: string; providerId: string };
    };
    assert.equal(executionBody.execution.status, "SUCCEEDED");
    assert.equal(executionBody.execution.providerId, "codex");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    await removeTemporaryRoot(gitContext.root);
  }
});
