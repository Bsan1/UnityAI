import assert from "node:assert/strict";
import { test } from "node:test";

import {
  beginTaskImplementation,
  buildExecutionRoutingSnapshot,
  completeTaskImplementation,
  completeTaskReview,
  createTask,
  failTaskExecution,
  markPausedExecutionInterrupted,
  pauseTask,
  recordFeasibilityResult,
  resumeTask,
  storeTaskContract,
  transitionTask,
} from "../src/index.js";
import type { ModelConfiguration, Task } from "../src/index.js";

const configuration: ModelConfiguration = {
  schemaVersion: 1,
  models: [
    {
      id: "writer",
      displayName: "Writer",
      providerId: "codex",
      providerModelName: "writer-model",
      supportedReasoningEfforts: ["high"],
      capabilities: { structuredOutput: true },
    },
    {
      id: "reviewer",
      displayName: "Reviewer",
      providerId: "claude",
      providerModelName: "review-model",
      supportedReasoningEfforts: ["medium"],
      capabilities: { structuredOutput: true },
    },
  ],
  routing: [
    { work: "INTERPRETER", taskStrength: "ALL", modelId: "writer", effort: "high" },
    { work: "FEASIBILITY", taskStrength: "STANDARD", modelId: "writer", effort: "high" },
    { work: "IMPLEMENTATION", taskStrength: "STANDARD", modelId: "writer", effort: "high" },
    { work: "QA_REASONING", taskStrength: "STANDARD", modelId: "writer", effort: "high" },
    { work: "CROSS_REVIEW", taskStrength: "ALL", modelId: "reviewer", effort: "medium" },
  ],
  fixWork: "SAME_AS_IMPLEMENTATION",
  runtimeEscalation: false,
};

const approvedTask = (reviewEnabled: boolean): Task => {
  const created = createTask(
    "TASK-9001",
    {
      originalRequest: "Add a dash component.",
      targetProjectPath: "C:/project",
      strength: "STANDARD",
      crossReviewEnabled: reviewEnabled,
    },
    { crossReviewEnabled: true, automaticFixesEnabled: true },
  );
  const analyzing = transitionTask(created, "ANALYZING");
  const waiting = recordFeasibilityResult(analyzing, {
    status: "READY",
    summary: "Ready",
    missingCapabilities: [],
  });
  const routing = buildExecutionRoutingSnapshot(
    configuration,
    "STANDARD",
    reviewEnabled,
    true,
  );
  const withContract = storeTaskContract(waiting, {
    understoodExplicitRequirements: ["Add dash."],
    inferredRequirements: [],
    prerequisites: [],
    implementationScope: ["Add Dash.cs."],
    acceptanceCriteria: ["Dash exists."],
    testRequirements: ["STATIC: Compile."],
    taskStrength: "STANDARD",
    executionPlan: routing,
  });
  return transitionTask(
    {
      ...withContract,
      taskContract: {
        ...withContract.taskContract!,
        approved: true,
        approvedAt: new Date().toISOString(),
      },
    },
    "READY_FOR_IMPLEMENTATION",
  );
};

test("M5 implementation and optional review end at READY_FOR_QA, never COMPLETED", () => {
  const implementing = beginTaskImplementation(approvedTask(true), {
    worktreePath: "C:/managed/TASK-9001",
    taskBranch: "ai/TASK-9001",
  });
  assert.equal(implementing.state, "IMPLEMENTING");
  const reviewing = completeTaskImplementation(implementing, {
    runId: "RUN-1",
    checkpointId: "CHECKPOINT-0001",
    checkpointCommit: "abc",
    changedFileCount: 1,
    reviewEnabled: true,
  });
  assert.equal(reviewing.state, "REVIEWING");
  const ready = completeTaskReview(reviewing, {
    runId: "RUN-2",
    status: "FINDINGS",
    findingCount: 2,
  });
  assert.equal(ready.state, "READY_FOR_QA");
  assert.notEqual(ready.state, "COMPLETED");
  assert.ok(ready.events.some((event) => event.type === "READY_FOR_QA"));
  assert.equal(transitionTask(ready, "TESTING").state, "TESTING");
});

test("Cross Review OFF skips REVIEWING and pause interruption resumes to FAILED", () => {
  const implementing = beginTaskImplementation(approvedTask(false), {
    worktreePath: "C:/managed/TASK-9001",
  });
  const ready = completeTaskImplementation(implementing, {
    runId: "RUN-1",
    checkpointId: "CHECKPOINT-0001",
    checkpointCommit: "abc",
    changedFileCount: 1,
    reviewEnabled: false,
  });
  assert.equal(ready.state, "READY_FOR_QA");

  const paused = pauseTask(implementing);
  const interrupted = markPausedExecutionInterrupted(paused, {
    phase: "INTERRUPTION",
    code: "EXECUTION_CANCELLED",
    message: "Paused safely.",
    occurredAt: new Date().toISOString(),
  });
  assert.equal(interrupted.pause?.previousState, "FAILED");
  assert.equal(resumeTask(interrupted).state, "FAILED");
});

test("technical implementation and review failures are explicit and preserve approved routing", () => {
  const implementing = beginTaskImplementation(approvedTask(true), {
    worktreePath: "C:/managed/TASK-9001",
  });
  const failed = failTaskExecution(implementing, {
    phase: "IMPLEMENTATION",
    code: "PROVIDER_EXIT_FAILURE",
    message: "Provider failed.",
    occurredAt: new Date().toISOString(),
    runId: "RUN-1",
  });
  assert.equal(failed.state, "FAILED");
  assert.equal(failed.executionFailure?.phase, "IMPLEMENTATION");
  assert.equal(
    failed.taskContract?.executionPlan?.implementation.modelId,
    "writer",
  );
});
