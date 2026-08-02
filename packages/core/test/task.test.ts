import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskDomainError,
  approveTaskContract,
  beginTaskAnalysis,
  cancelTask,
  createPrerequisiteDraft,
  createTask,
  editTaskDraft,
  formatTaskId,
  pauseTask,
  recheckTask,
  recordFeasibilityResult,
  resumeTask,
  storeTaskContract,
  transitionTask,
} from "@unityai/core";
import type {
  Task,
  TaskContractInput,
  TaskSettings,
} from "@unityai/core";

const defaults: TaskSettings = {
  crossReviewEnabled: true,
  automaticFixesEnabled: true,
};

const taskContract: TaskContractInput = {
  understoodExplicitRequirements: ["Add a placeable Archer Tower."],
  inferredRequirements: ["Use the existing placement system."],
  prerequisites: [],
  implementationScope: ["Add the tower prefab and placement definition."],
  nonGoals: ["Do not change enemy behavior."],
  acceptanceCriteria: ["The player can place the Archer Tower."],
  testRequirements: ["Verify placement in Play Mode."],
};

const createExampleTask = (sequence = 1): Task =>
  createTask(
    formatTaskId(sequence),
    {
      title: "Placeable Archer Tower",
      originalRequest: "Add a placeable Archer Tower",
      targetProjectPath: "D:/Games/TowerDefense",
      strength: "STANDARD",
    },
    defaults,
    "2026-08-02T10:00:00.000Z",
  );

const createWaitingTask = (): Task => {
  const analyzing = beginTaskAnalysis(
    createExampleTask(),
    "2026-08-02T10:01:00.000Z",
  );
  return recordFeasibilityResult(
    analyzing,
    {
      status: "READY",
      summary: "The existing architecture supports this task.",
      missingCapabilities: [],
    },
    "2026-08-02T10:02:00.000Z",
  );
};

const createBlockedTask = (): Task => {
  const analyzing = beginTaskAnalysis(
    createExampleTask(),
    "2026-08-02T10:01:00.000Z",
  );
  return recordFeasibilityResult(
    analyzing,
    {
      status: "BLOCKED_ARCHITECTURE",
      summary: "Building Placement System is missing.",
      missingCapabilities: ["Building Placement System"],
      suggestedPrerequisite: "Create reusable Building Placement System.",
    },
    "2026-08-02T10:02:00.000Z",
  );
};

test("task IDs are stable and new tasks inherit binary defaults", () => {
  const first = createExampleTask(1);
  const second = createExampleTask(2);

  assert.equal(first.id, "TASK-0001");
  assert.equal(second.id, "TASK-0002");
  assert.notEqual(first.id, second.id);
  assert.equal(first.crossReviewEnabled, true);
  assert.equal(first.automaticFixesEnabled, true);
  assert.equal(first.state, "CREATED");
  assert.equal(first.events[0]?.type, "TASK_CREATED");
});

test("per-task binary settings can override defaults and remain booleans", () => {
  const task = createTask(
    formatTaskId(1),
    {
      originalRequest: "Small task",
      strength: "LIGHT",
      crossReviewEnabled: false,
      automaticFixesEnabled: false,
    },
    defaults,
  );

  assert.equal(task.crossReviewEnabled, false);
  assert.equal(task.automaticFixesEnabled, false);
});

test("invalid state transitions fail clearly", () => {
  assert.throws(
    () => transitionTask(createExampleTask(), "READY_FOR_IMPLEMENTATION"),
    (error: unknown) =>
      error instanceof TaskDomainError && error.code === "INVALID_TRANSITION",
  );
});

test("pause and resume preserve state, feasibility, contract, and history", () => {
  const waiting = storeTaskContract(
    createWaitingTask(),
    taskContract,
    "2026-08-02T10:03:00.000Z",
  );
  const paused = pauseTask(
    waiting,
    "Waiting for user input",
    "2026-08-02T10:04:00.000Z",
  );

  assert.equal(paused.state, "PAUSED");
  assert.equal(paused.pause?.previousState, "WAITING_FOR_APPROVAL");
  assert.deepEqual(paused.feasibility, waiting.feasibility);
  assert.deepEqual(paused.taskContract, waiting.taskContract);

  const resumed = resumeTask(paused, "2026-08-02T10:05:00.000Z");
  assert.equal(resumed.state, "WAITING_FOR_APPROVAL");
  assert.equal(resumed.pause, undefined);
  assert.equal(resumed.events.at(-2)?.type, "TASK_RESUMED");
  assert.equal(resumed.events.at(-1)?.type, "STATE_CHANGED");
});

test("cancellation is logical, terminal, and recorded", () => {
  const cancelled = cancelTask(
    createExampleTask(),
    "No longer needed",
    "2026-08-02T10:01:00.000Z",
  );

  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(cancelled.cancellation?.reason, "No longer needed");
  assert.ok(cancelled.events.some((entry) => entry.type === "TASK_CANCELLED"));
  assert.throws(
    () => beginTaskAnalysis(cancelled),
    (error: unknown) =>
      error instanceof TaskDomainError && error.code === "INVALID_TRANSITION",
  );
});

test("blocked tasks create editable prerequisite drafts without changing parent state", () => {
  const blocked = createBlockedTask();
  const { parentTask, prerequisiteDraft } = createPrerequisiteDraft(
    blocked,
    formatTaskId(2),
    "Create reusable Building Placement System.",
    "2026-08-02T10:03:00.000Z",
  );

  assert.equal(parentTask.state, "BLOCKED");
  assert.deepEqual(parentTask.prerequisiteDraftIds, ["TASK-0002"]);
  assert.equal(prerequisiteDraft.state, "DRAFT");
  assert.equal(prerequisiteDraft.originTaskId, parentTask.id);
  assert.equal(prerequisiteDraft.taskContract, undefined);

  const editedDraft = editTaskDraft(
    prerequisiteDraft,
    {
      title: "Reusable placement foundation",
      originalRequest:
        "Create a reusable grid-aware Building Placement System.",
    },
    "2026-08-02T10:04:00.000Z",
  );
  assert.equal(editedDraft.state, "DRAFT");
  assert.match(editedDraft.originalRequest, /grid-aware/);
  assert.equal(parentTask.state, "BLOCKED");
});

test("recheck requests new analysis without fabricating feasibility", () => {
  const blocked = createBlockedTask();
  const analyzing = recheckTask(blocked, "2026-08-02T10:03:00.000Z");

  assert.equal(analyzing.state, "ANALYZING");
  assert.equal(analyzing.feasibility, undefined);
  assert.equal(analyzing.taskContract, undefined);
  assert.equal(analyzing.events.at(-2)?.type, "RECHECK_REQUESTED");
  assert.equal(
    analyzing.events.at(-2)?.metadata?.previousFeasibilityStatus,
    "BLOCKED_ARCHITECTURE",
  );
});

test("a paused blocked task can request recheck directly", () => {
  const paused = pauseTask(
    createBlockedTask(),
    undefined,
    "2026-08-02T10:03:00.000Z",
  );
  const analyzing = recheckTask(paused, "2026-08-02T10:04:00.000Z");

  assert.equal(analyzing.state, "ANALYZING");
  assert.equal(analyzing.pause, undefined);
  assert.equal(analyzing.feasibility, undefined);
});

test("Task Contract storage is unapproved until explicit approval", () => {
  const waiting = createWaitingTask();
  const withContract = storeTaskContract(
    waiting,
    taskContract,
    "2026-08-02T10:03:00.000Z",
  );

  assert.equal(withContract.state, "WAITING_FOR_APPROVAL");
  assert.equal(withContract.taskContract?.approved, false);
  assert.equal(withContract.taskContract?.approvedAt, undefined);
  assert.equal(withContract.events.at(-1)?.type, "CONTRACT_STORED");

  const approved = approveTaskContract(
    withContract,
    "2026-08-02T10:04:00.000Z",
  );
  assert.equal(approved.state, "READY_FOR_IMPLEMENTATION");
  assert.equal(approved.taskContract?.approved, true);
  assert.equal(
    approved.taskContract?.approvedAt,
    "2026-08-02T10:04:00.000Z",
  );
  assert.ok(
    approved.events.some((entry) => entry.type === "CONTRACT_APPROVED"),
  );
});

test("implementation readiness and implementation require an approved contract", () => {
  const withContract = storeTaskContract(
    createWaitingTask(),
    taskContract,
    "2026-08-02T10:03:00.000Z",
  );

  assert.throws(
    () =>
      transitionTask(
        withContract,
        "READY_FOR_IMPLEMENTATION",
        "2026-08-02T10:04:00.000Z",
      ),
    (error: unknown) =>
      error instanceof TaskDomainError && error.code === "INVALID_TRANSITION",
  );

  const approved = approveTaskContract(
    withContract,
    "2026-08-02T10:04:00.000Z",
  );
  const implementing = transitionTask(
    approved,
    "IMPLEMENTING",
    "2026-08-02T10:05:00.000Z",
  );
  assert.equal(implementing.state, "IMPLEMENTING");
  assert.equal(implementing.taskContract?.approved, true);
});
