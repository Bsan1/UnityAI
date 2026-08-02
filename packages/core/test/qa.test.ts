import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approveTaskContract,
  beginTaskFix,
  beginTaskGameplayQA,
  beginTaskImplementation,
  beginTaskQA,
  completeTaskFixAndRestartQA,
  completeTaskImplementation,
  completeTaskQAAndFinalize,
  completeTaskQAForGameplay,
  createTask,
  parseQAAgentOutput,
  parseQASession,
  recordFeasibilityResult,
  recordTaskQAFailure,
  storeTaskContract,
  transitionTask,
} from "../src/index.js";
import type { ExecutionRoutingSnapshot, Task } from "../src/index.js";

const route: ExecutionRoutingSnapshot = {
  schemaVersion: 1,
  taskStrength: "STANDARD",
  implementation: {
    providerId: "codex",
    modelId: "codex-sol",
    providerModelName: "gpt-5.6-sol",
    effort: "medium",
  },
  qa: {
    providerId: "codex",
    modelId: "codex-sol",
    providerModelName: "gpt-5.6-sol",
    effort: "medium",
  },
  fix: {
    enabled: true,
    plan: {
      providerId: "codex",
      modelId: "codex-sol",
      providerModelName: "gpt-5.6-sol",
      effort: "medium",
    },
  },
  review: { enabled: false },
  runtimeEscalation: false,
  createdAt: "2026-08-02T10:00:00.000Z",
};

const readyForQA = (): Task => {
  let task = createTask(
    "TASK-0001",
    { originalRequest: "Add a component.", targetProjectPath: "C:/fixture" },
    { crossReviewEnabled: false, automaticFixesEnabled: true },
    "2026-08-02T10:00:00.000Z",
  );
  task = transitionTask(task, "ANALYZING", "2026-08-02T10:00:01.000Z");
  task = recordFeasibilityResult(task, {
    status: "READY",
    summary: "Ready.",
    missingCapabilities: [],
  }, "2026-08-02T10:00:02.000Z");
  task = storeTaskContract(task, {
    originalTaskSummary: "Add a component.",
    understoodExplicitRequirements: ["Add component."],
    inferredRequirements: [],
    prerequisites: [],
    implementationScope: ["Add component."],
    acceptanceCriteria: ["Component exists."],
    testRequirements: ["STRUCTURAL: Component exists."],
    taskStrength: "STANDARD",
    executionPlan: route,
  }, "2026-08-02T10:00:03.000Z");
  task = approveTaskContract(task, "2026-08-02T10:00:04.000Z");
  task = beginTaskImplementation(task, {}, "2026-08-02T10:00:05.000Z");
  return completeTaskImplementation(task, {
    runId: "RUN-IMPLEMENT",
    checkpointId: "CHECKPOINT-0001",
    checkpointCommit: "a".repeat(40),
    changedFileCount: 1,
    reviewEnabled: false,
  }, "2026-08-02T10:00:06.000Z");
};

test("M7 state flow supports testing, batched failure, fixing, full restart, gameplay pending, and finalization", () => {
  const ready = readyForQA();
  const testing = beginTaskQA(ready, { sessionId: "QA-ONE", cycleNumber: 1 });
  assert.equal(testing.state, "TESTING");
  const failed = recordTaskQAFailure(testing, {
    sessionId: "QA-ONE",
    findingCount: 3,
    technical: false,
  });
  assert.equal(failed.state, "FAILED");
  const fixing = beginTaskFix(failed, {
    sourceSessionId: "QA-ONE",
    fixNumber: 1,
    automatic: true,
  });
  assert.equal(fixing.state, "FIXING");
  const retesting = completeTaskFixAndRestartQA(fixing, {
    fixId: "FIX-001",
    runId: "RUN-FIX",
    checkpointId: "CHECKPOINT-0002",
    checkpointCommit: "b".repeat(40),
    nextSessionId: "QA-TWO",
    nextCycleNumber: 2,
  });
  assert.equal(retesting.state, "TESTING");
  assert.ok(retesting.events.some((event) => event.type === "QA_RESTARTED"));

  const gameplay = completeTaskQAForGameplay(retesting, {
    sessionId: "QA-TWO",
    gameplayTests: 2,
  });
  assert.equal(gameplay.state, "READY_FOR_GAMEPLAY_QA");
  assert.notEqual(gameplay.state, "COMPLETED");
  assert.throws(
    () => transitionTask(gameplay, "COMPLETED"),
    /cannot transition/u,
  );
  const gameplayTesting = beginTaskGameplayQA(gameplay, {
    sessionId: "QA-GAMEPLAY",
    cycleNumber: 3,
  });
  assert.equal(gameplayTesting.state, "TESTING");
  assert.ok(gameplayTesting.events.some((event) => event.type === "GAMEPLAY_QA_STARTED"));

  const separatelyTesting = beginTaskQA(readyForQA(), {
    sessionId: "QA-PASS",
    cycleNumber: 1,
  });
  const completed = completeTaskQAAndFinalize(separatelyTesting, {
    sessionId: "QA-PASS",
    finalCommit: "c".repeat(40),
    taskBranch: "ai/TASK-0001",
  });
  assert.equal(completed.state, "COMPLETED");
  assert.deepEqual(
    completed.events.slice(-5).map((event) => event.type),
    ["QA_CYCLE_COMPLETED", "QA_PASSED", "UNITY_TOOLING_REMOVED", "TASK_FINALIZED", "STATE_CHANGED"],
  );
});

test("QA structured output requires evidence-backed pass/fail across QA0-QA3", () => {
  const parsed = parseQAAgentOutput({
    summary: "All executable tests attempted.",
    results: [{
      testId: "TEST-001",
      category: "STRUCTURAL",
      status: "PASS",
      summary: "Component found.",
      expected: "Component exists.",
      observed: "Component was present.",
      evidence: [{ kind: "OBJECT", summary: "Object snapshot contains Component." }],
      likelyArea: [],
    }],
    findings: [],
  });
  assert.equal(parsed.results[0]?.status, "PASS");
  assert.throws(() => parseQAAgentOutput({
    summary: "Unsupported pass.",
    results: [{
      testId: "TEST-001",
      category: "STRUCTURAL",
      status: "PASS",
      summary: "Claimed pass.",
      expected: "Evidence.",
      observed: "None.",
      evidence: [],
      likelyArea: [],
    }],
    findings: [],
  }), /requires evidence/u);
  const gameplay = parseQAAgentOutput({
    summary: "Gameplay observed through real input evidence.",
    results: [{
      testId: "TEST-GAME",
      category: "GAMEPLAY",
      status: "PASS",
      summary: "Dash passed.",
      expected: "Space performs a dash.",
      observed: "Virtual Space input changed the player transform.",
      evidence: [{ kind: "INPUT", summary: "Virtual keyboard Space traversed the real binding." }],
      likelyArea: [],
    }],
    findings: [],
  });
  assert.equal(gameplay.results[0]?.category, "GAMEPLAY");
});

test("QA session validation preserves gameplay as NOT_RUN with the M8 reason", () => {
  const session = parseQASession({
    schemaVersion: 1,
    sessionId: "QA-SESSION",
    taskId: "TASK-0001",
    cycleNumber: 1,
    startedAt: "2026-08-02T10:00:00.000Z",
    completedAt: "2026-08-02T10:01:00.000Z",
    status: "INCOMPLETE_GAMEPLAY",
    plannedTests: [{
      id: "TEST-001",
      category: "GAMEPLAY",
      description: "Press Space to dash.",
      required: true,
      source: "CONTRACT",
    }],
    results: [{
      testId: "TEST-001",
      category: "GAMEPLAY",
      status: "NOT_RUN",
      summary: "M8 required.",
      expected: "Press Space to dash.",
      observed: "No player input was injected.",
      evidence: [],
      likelyArea: [],
      blockingReason: "REQUIRES_M8_GAMEPLAY_QA",
    }],
    findings: [],
    blockedTests: [],
    evidence: [],
    summary: {
      text: "Gameplay remains.",
      passed: 0,
      failed: 0,
      blocked: 0,
      notRun: 1,
      gameplayPending: 1,
    },
  });
  assert.equal(session.results[0]?.blockingReason, "REQUIRES_M8_GAMEPLAY_QA");
  assert.equal(session.status, "INCOMPLETE_GAMEPLAY");
});
