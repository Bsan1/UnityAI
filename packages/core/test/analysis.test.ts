import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskDomainError,
  approveTaskContract,
  beginTaskAnalysis,
  buildDeterministicTaskContract,
  buildExecutionRoutingSnapshot,
  classifyFinalStrength,
  classifyPreliminaryStrength,
  completeTaskAnalysis,
  createTask,
  editTaskContract,
  failTaskAnalysis,
  formatTaskId,
  parseAnalysisFeasibilityResult,
  parseModelConfiguration,
  parseTaskInterpretationResult,
  resolveConfiguredModelPlan,
  transitionTask,
} from "@unityai/core";
import type {
  AnalysisFeasibilityResult,
  ModelConfiguration,
  Task,
  TaskInterpretationResult,
  TaskSettings,
  TaskStrength,
} from "@unityai/core";

const settings: TaskSettings = {
  crossReviewEnabled: true,
  automaticFixesEnabled: true,
};

const modelConfiguration: ModelConfiguration = parseModelConfiguration({
  schemaVersion: 1,
  models: [
    {
      id: "terra",
      displayName: "Terra",
      providerId: "codex",
      providerModelName: "gpt-terra",
      supportedReasoningEfforts: ["medium", "high"],
      capabilities: { structuredOutput: true },
    },
    {
      id: "sol",
      displayName: "Sol",
      providerId: "codex",
      providerModelName: "gpt-sol",
      supportedReasoningEfforts: ["medium", "high"],
      capabilities: { structuredOutput: true },
    },
    {
      id: "reviewer",
      displayName: "Reviewer",
      providerId: "claude",
      providerModelName: "sonnet",
      supportedReasoningEfforts: ["medium"],
      capabilities: { structuredOutput: true },
    },
  ],
  routing: [
    { work: "INTERPRETER", taskStrength: "ALL", modelId: "terra", effort: "medium" },
    { work: "FEASIBILITY", taskStrength: "LIGHT", modelId: "terra", effort: "medium" },
    { work: "FEASIBILITY", taskStrength: "STANDARD", modelId: "terra", effort: "high" },
    { work: "FEASIBILITY", taskStrength: "STRONG", modelId: "sol", effort: "high" },
    { work: "IMPLEMENTATION", taskStrength: "LIGHT", modelId: "terra", effort: "high" },
    { work: "IMPLEMENTATION", taskStrength: "STANDARD", modelId: "sol", effort: "medium" },
    { work: "IMPLEMENTATION", taskStrength: "STRONG", modelId: "sol", effort: "high" },
    { work: "QA_REASONING", taskStrength: "LIGHT", modelId: "terra", effort: "medium" },
    { work: "QA_REASONING", taskStrength: "STANDARD", modelId: "sol", effort: "medium" },
    { work: "QA_REASONING", taskStrength: "STRONG", modelId: "sol", effort: "high" },
    { work: "CROSS_REVIEW", taskStrength: "ALL", modelId: "reviewer" },
  ],
  fixWork: "SAME_AS_IMPLEMENTATION",
  runtimeEscalation: false,
});

const interpretation = (
  overrides: Partial<TaskInterpretationResult> = {},
): TaskInterpretationResult =>
  parseTaskInterpretationResult({
    title: "Dash action",
    summary: "Add a dash action with a cooldown.",
    explicitRequirements: ["The player can dash."],
    inferredRequirements: ["Dash obeys a cooldown."],
    constraints: [],
    explicitNonGoals: ["Do not add stamina."],
    ambiguities: [],
    acceptanceCriteriaDraft: [
      {
        description: "The player can dash when the cooldown is ready.",
        evidenceExpectation: ["Record player position before and after input."],
      },
    ],
    testRequirementsDraft: [
      { category: "RUNTIME", description: "Exercise dash and cooldown timing." },
    ],
    riskSignals: {
      newReusableCoreSystem: false,
      multiSystemIntegration: false,
      networkingOrMultiplayer: false,
      persistenceOrSaveArchitecture: false,
      editorTooling: false,
      potentiallyDestructiveDataChange: false,
      likelyArchitectureImpact: false,
      majorFrameworkOrSystemReplacement: false,
      highRegressionRisk: false,
      estimatedSystemsAffected: 1,
    },
    ...overrides,
  });

const feasibility = (
  overrides: Partial<AnalysisFeasibilityResult> = {},
): AnalysisFeasibilityResult =>
  parseAnalysisFeasibilityResult({
    status: "READY",
    summary: "Existing player and input systems support the change.",
    evidence: [
      { location: "Assets/Player.cs", observation: "Player movement exists." },
    ],
    existingCapabilities: ["Player movement", "Input abstraction"],
    missingCapabilities: [],
    autoFixableDependencies: [],
    suggestedPrerequisite: null,
    systemsAffected: ["Player"],
    architectureImpact: "low",
    implementationComplexity: "low",
    regressionRisk: "low",
    ambiguity: "low",
    createsReusableCoreSystem: false,
    proposedImplementationScope: ["Add dash state and cooldown handling."],
    proposedNonGoals: ["Do not change ordinary movement."],
    acceptanceCriteriaAdditions: [
      {
        description: "The player can dash when the cooldown is ready!",
        evidenceExpectation: ["Duplicate evidence should merge."],
      },
      {
        description: "Dash is rejected during cooldown.",
        evidenceExpectation: [],
      },
    ],
    testRequirementAdditions: [
      { category: "RUNTIME", description: "Exercise dash and cooldown timing." },
      { category: "GAMEPLAY", description: "Verify repeated dash input is gated." },
    ],
    ...overrides,
  });

const task = (
  strength: TaskStrength = "STANDARD",
  crossReviewEnabled = true,
): Task =>
  createTask(
    formatTaskId(1),
    {
      originalRequest: "Add a simple dash action with a cooldown.",
      targetProjectPath: "D:/Games/Test",
      strength,
      crossReviewEnabled,
    },
    settings,
    "2026-08-02T10:00:00.000Z",
  );

test("preliminary strength classification is deterministic and conservative", () => {
  assert.equal(classifyPreliminaryStrength(interpretation()), "LIGHT");
  assert.equal(
    classifyPreliminaryStrength(
      interpretation({
        riskSignals: {
          ...interpretation().riskSignals,
          multiSystemIntegration: true,
          estimatedSystemsAffected: 2,
        },
      }),
    ),
    "STANDARD",
  );
  assert.equal(
    classifyPreliminaryStrength(
      interpretation({
        riskSignals: {
          ...interpretation().riskSignals,
          networkingOrMultiplayer: true,
        },
      }),
    ),
    "STRONG",
  );
});

test("final classification covers light, normal multi-system, high architecture, reusable core, and uncertain boundaries", () => {
  assert.equal(classifyFinalStrength(interpretation(), feasibility()), "LIGHT");
  assert.equal(
    classifyFinalStrength(
      interpretation(),
      feasibility({
        systemsAffected: ["Player", "Input"],
        implementationComplexity: "medium",
      }),
    ),
    "STANDARD",
  );
  assert.equal(
    classifyFinalStrength(
      interpretation(),
      feasibility({ architectureImpact: "high" }),
    ),
    "STRONG",
  );
  assert.equal(
    classifyFinalStrength(
      interpretation(),
      feasibility({ createsReusableCoreSystem: true }),
    ),
    "STRONG",
  );
  assert.equal(
    classifyFinalStrength(
      interpretation(),
      feasibility({ ambiguity: "medium" }),
    ),
    "STANDARD",
  );
});

test("configured feasibility and execution routes resolve without hardcoded model IDs", () => {
  assert.deepEqual(
    resolveConfiguredModelPlan(modelConfiguration, "FEASIBILITY", "LIGHT"),
    {
      providerId: "codex",
      modelId: "terra",
      providerModelName: "gpt-terra",
      effort: "medium",
    },
  );
  assert.equal(
    resolveConfiguredModelPlan(modelConfiguration, "FEASIBILITY", "STRONG").modelId,
    "sol",
  );
});

test("routing snapshots preserve binary review and exact implementation/fix identity", () => {
  const enabled = buildExecutionRoutingSnapshot(
    modelConfiguration,
    "STANDARD",
    true,
    true,
    "2026-08-02T10:01:00.000Z",
  );
  assert.equal(enabled.review.enabled, true);
  assert.deepEqual(enabled.fix.plan, enabled.implementation);
  assert.equal(enabled.fix.enabled, true);
  assert.equal(enabled.runtimeEscalation, false);

  const disabled = buildExecutionRoutingSnapshot(
    modelConfiguration,
    "STANDARD",
    false,
    false,
    "2026-08-02T10:01:00.000Z",
  );
  assert.deepEqual(disabled.review, { enabled: false });
  assert.equal(disabled.fix.enabled, false);
});

test("the deterministic contract merges, deduplicates, IDs, and plans evidence/tests", () => {
  const routing = buildExecutionRoutingSnapshot(
    modelConfiguration,
    "LIGHT",
    true,
    true,
    "2026-08-02T10:01:00.000Z",
  );
  const contract = buildDeterministicTaskContract(
    interpretation(),
    feasibility(),
    "LIGHT",
    routing,
  );
  assert.equal(contract.originalTaskSummary, interpretation().summary);
  assert.equal(contract.acceptanceCriteriaDetails?.length, 2);
  assert.deepEqual(
    contract.acceptanceCriteriaDetails?.map((criterion) => criterion.id),
    ["AC-001", "AC-002"],
  );
  assert.ok(
    (contract.acceptanceCriteriaDetails?.[1]?.evidenceExpectation.length ?? 0) > 0,
  );
  assert.deepEqual(
    contract.testRequirementDetails?.map((requirement) => requirement.id),
    ["TEST-001", "TEST-002"],
  );
  assert.deepEqual(
    contract.testRequirementDetails?.map((requirement) => requirement.category),
    ["RUNTIME", "GAMEPLAY"],
  );
});

test("READY analysis stores an unapproved contract and approval alone unlocks implementation", () => {
  const analyzing = beginTaskAnalysis(task(), "2026-08-02T10:01:00.000Z");
  const finalStrength = classifyFinalStrength(interpretation(), feasibility());
  const routing = buildExecutionRoutingSnapshot(
    modelConfiguration,
    finalStrength,
    true,
    true,
    "2026-08-02T10:02:00.000Z",
  );
  const contract = buildDeterministicTaskContract(
    interpretation(),
    feasibility(),
    finalStrength,
    routing,
  );
  const waiting = completeTaskAnalysis(
    analyzing,
    {
      title: "Dash action",
      feasibility: {
        status: "READY",
        summary: feasibility().summary,
        missingCapabilities: [],
      },
      taskContract: contract,
      analysis: {
        preliminaryStrength: "LIGHT",
        finalStrength,
        interpretationRunId: "RUN-I",
        feasibilityRunId: "RUN-F",
        routingSnapshot: routing,
        analyzedAt: "2026-08-02T10:02:00.000Z",
        recheckCount: 0,
      },
    },
    "2026-08-02T10:02:00.000Z",
  );
  assert.equal(waiting.state, "WAITING_FOR_APPROVAL");
  assert.equal(waiting.taskContract?.approved, false);
  assert.throws(
    () => transitionTask(waiting, "READY_FOR_IMPLEMENTATION"),
    (error: unknown) =>
      error instanceof TaskDomainError && error.code === "INVALID_TRANSITION",
  );
  const approved = approveTaskContract(
    waiting,
    "2026-08-02T10:03:00.000Z",
  );
  assert.equal(approved.state, "READY_FOR_IMPLEMENTATION");
  assert.equal(approved.taskContract?.approved, true);

  const changedConfiguration = parseModelConfiguration({
    ...modelConfiguration,
    routing: modelConfiguration.routing.map((route) =>
      route.work === "IMPLEMENTATION" && route.taskStrength === "LIGHT"
        ? { ...route, modelId: "sol", effort: "high" }
        : route,
    ),
  });
  assert.notDeepEqual(
    buildExecutionRoutingSnapshot(
      changedConfiguration,
      "LIGHT",
      true,
      true,
      "2026-08-02T10:04:00.000Z",
    ).implementation,
    approved.analysis?.routingSnapshot.implementation,
  );
  assert.deepEqual(
    approved.taskContract?.executionPlan,
    waiting.taskContract?.executionPlan,
  );
});

test("contracts edit only before approval and preserve internal planning fields", () => {
  const analyzing = beginTaskAnalysis(task());
  const routing = buildExecutionRoutingSnapshot(
    modelConfiguration,
    "LIGHT",
    true,
    true,
  );
  const waiting = completeTaskAnalysis(analyzing, {
    feasibility: {
      status: "READY",
      summary: feasibility().summary,
      missingCapabilities: [],
    },
    taskContract: buildDeterministicTaskContract(
      interpretation(),
      feasibility(),
      "LIGHT",
      routing,
    ),
    analysis: {
      preliminaryStrength: "LIGHT",
      finalStrength: "LIGHT",
      interpretationRunId: "RUN-I",
      feasibilityRunId: "RUN-F",
      routingSnapshot: routing,
      analyzedAt: new Date().toISOString(),
      recheckCount: 0,
    },
  });
  const edited = editTaskContract(waiting, {
    implementationScope: ["Add dash without touching jump."],
  });
  assert.deepEqual(edited.taskContract?.implementationScope, [
    "Add dash without touching jump.",
  ]);
  assert.deepEqual(
    edited.taskContract?.executionPlan,
    waiting.taskContract?.executionPlan,
  );
  assert.throws(
    () => editTaskContract(approveTaskContract(edited), { nonGoals: ["No stamina."] }),
    (error: unknown) =>
      error instanceof TaskDomainError && error.code === "INVALID_TRANSITION",
  );
});

test("AUTO_FIXABLE and both blocked statuses remain blocked without contracts", () => {
  for (const status of [
    "AUTO_FIXABLE",
    "BLOCKED_ARCHITECTURE",
    "BLOCKED_USER",
  ] as const) {
    const analyzing = beginTaskAnalysis(task());
    const result = feasibility({ status });
    const strength = classifyFinalStrength(interpretation(), result);
    const routing = buildExecutionRoutingSnapshot(
      modelConfiguration,
      strength,
      true,
      true,
    );
    const blocked = completeTaskAnalysis(analyzing, {
      feasibility: {
        status,
        summary: result.summary,
        missingCapabilities: result.missingCapabilities,
      },
      analysis: {
        preliminaryStrength: "LIGHT",
        finalStrength: strength,
        interpretationRunId: "RUN-I",
        feasibilityRunId: "RUN-F",
        routingSnapshot: routing,
        analyzedAt: new Date().toISOString(),
        recheckCount: 0,
      },
    });
    assert.equal(blocked.state, "BLOCKED");
    assert.equal(blocked.taskContract, undefined);
  }
});

test("technical analysis failures are explicit and can be retried without fake feasibility", () => {
  const analyzing = beginTaskAnalysis(task());
  const failed = failTaskAnalysis(analyzing, {
    phase: "FEASIBILITY",
    code: "EXECUTION_TIMEOUT",
    message: "Feasibility provider timed out.",
    occurredAt: "2026-08-02T10:02:00.000Z",
    runId: "RUN-F",
  });
  assert.equal(failed.state, "FAILED");
  assert.equal(failed.feasibility, undefined);
  assert.equal(failed.analysisFailure?.code, "EXECUTION_TIMEOUT");
  assert.equal(beginTaskAnalysis(failed).state, "ANALYZING");
});
