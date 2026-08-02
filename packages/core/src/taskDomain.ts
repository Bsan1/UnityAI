import { TaskDomainError } from "./errors.js";
import type {
  CreateTaskInput,
  DraftTaskPatch,
  FeasibilityResult,
  PrerequisiteDraftResult,
  Task,
  TaskContract,
  TaskContractInput,
  TaskEvent,
  TaskEventType,
  TaskId,
  TaskSettings,
  TaskState,
} from "./taskTypes.js";
import {
  parseCreateTaskInput,
  parseDraftTaskPatch,
  parseFeasibilityResult,
  parseTask,
  parseTaskContractInput,
  parseTaskId,
  parseTaskSettings,
} from "./taskValidation.js";

const transitions: Readonly<Record<TaskState, readonly TaskState[]>> = {
  DRAFT: ["CREATED"],
  CREATED: ["ANALYZING"],
  ANALYZING: ["WAITING_FOR_APPROVAL", "BLOCKED"],
  WAITING_FOR_APPROVAL: ["READY_FOR_IMPLEMENTATION"],
  BLOCKED: [],
  PAUSED: [],
  READY_FOR_IMPLEMENTATION: ["IMPLEMENTING"],
  IMPLEMENTING: ["REVIEWING", "TESTING", "FAILED"],
  REVIEWING: ["TESTING", "FAILED"],
  TESTING: ["COMPLETED", "FAILED"],
  FAILED: ["FIXING"],
  FIXING: ["TESTING", "FAILED"],
  COMPLETED: [],
  CANCELLED: [],
};

const pausableStates = new Set<TaskState>([
  "CREATED",
  "ANALYZING",
  "WAITING_FOR_APPROVAL",
  "BLOCKED",
  "READY_FOR_IMPLEMENTATION",
  "IMPLEMENTING",
  "REVIEWING",
  "TESTING",
  "FAILED",
  "FIXING",
]);

const cancellableStates = new Set<TaskState>([
  "DRAFT",
  ...pausableStates,
  "PAUSED",
]);

const implementationStates = new Set<TaskState>([
  "READY_FOR_IMPLEMENTATION",
  "IMPLEMENTING",
  "REVIEWING",
  "TESTING",
  "FAILED",
  "FIXING",
  "COMPLETED",
]);

const nowTimestamp = (): string => new Date().toISOString();

const event = (
  type: TaskEventType,
  timestamp: string,
  metadata?: Readonly<Record<string, string>>,
): TaskEvent => ({
  timestamp,
  type,
  ...(metadata === undefined ? {} : { metadata }),
});

const invalidTransition = (task: Task, targetState: TaskState): never => {
  throw new TaskDomainError(
    "INVALID_TRANSITION",
    `Task ${task.id} cannot transition from ${task.state} to ${targetState}.`,
  );
};

const requireState = (task: Task, expectedState: TaskState): void => {
  if (task.state !== expectedState) {
    invalidTransition(task, expectedState);
  }
};

const assertTransitionInvariants = (
  task: Task,
  targetState: TaskState,
): void => {
  if (task.state === "ANALYZING" && targetState === "WAITING_FOR_APPROVAL") {
    if (
      task.feasibility?.status !== "READY" &&
      task.feasibility?.status !== "AUTO_FIXABLE"
    ) {
      throw new TaskDomainError(
        "INVALID_TRANSITION",
        "A ready feasibility result is required before waiting for approval.",
      );
    }
  }

  if (task.state === "ANALYZING" && targetState === "BLOCKED") {
    if (
      task.feasibility?.status !== "BLOCKED_ARCHITECTURE" &&
      task.feasibility?.status !== "BLOCKED_USER"
    ) {
      throw new TaskDomainError(
        "INVALID_TRANSITION",
        "A blocking feasibility result is required before blocking a task.",
      );
    }
  }

  if (
    implementationStates.has(targetState) &&
    task.taskContract?.approved !== true
  ) {
    throw new TaskDomainError(
      "INVALID_TRANSITION",
      `Task ${task.id} requires an approved Task Contract before ${targetState}.`,
    );
  }
};

const applyTransition = (
  task: Task,
  targetState: TaskState,
  timestamp: string,
  precedingEvents: readonly TaskEvent[] = [],
): Task => {
  if (!transitions[task.state].includes(targetState)) {
    return invalidTransition(task, targetState);
  }

  assertTransitionInvariants(task, targetState);

  return parseTask({
    ...task,
    state: targetState,
    updatedAt: timestamp,
    events: [
      ...task.events,
      ...precedingEvents,
      event("STATE_CHANGED", timestamp, {
        from: task.state,
        to: targetState,
      }),
    ],
  });
};

export const formatTaskId = (sequence: number): TaskId => {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TaskDomainError(
      "VALIDATION_ERROR",
      "Task sequence must be a positive integer.",
    );
  }

  return parseTaskId(`TASK-${String(sequence).padStart(4, "0")}`);
};

export const createTask = (
  id: TaskId,
  input: CreateTaskInput,
  settings: TaskSettings,
  timestamp = nowTimestamp(),
): Task => {
  const validId = parseTaskId(id);
  const validInput = parseCreateTaskInput(input);
  const validSettings = parseTaskSettings(settings);

  return parseTask({
    id: validId,
    ...(validInput.title === undefined ? {} : { title: validInput.title }),
    originalRequest: validInput.originalRequest,
    ...(validInput.targetProjectPath === undefined
      ? {}
      : { targetProjectPath: validInput.targetProjectPath }),
    strength: validInput.strength,
    state: "CREATED",
    createdAt: timestamp,
    updatedAt: timestamp,
    crossReviewEnabled:
      validInput.crossReviewEnabled ?? validSettings.crossReviewEnabled,
    automaticFixesEnabled:
      validInput.automaticFixesEnabled ??
      validSettings.automaticFixesEnabled,
    prerequisiteDraftIds: [],
    events: [event("TASK_CREATED", timestamp)],
  });
};

export const transitionTask = (
  task: Task,
  targetState: TaskState,
  timestamp = nowTimestamp(),
): Task => applyTransition(parseTask(task), targetState, timestamp);

export const submitTaskDraft = (
  task: Task,
  timestamp = nowTimestamp(),
): Task => {
  const current = parseTask(task);
  requireState(current, "DRAFT");
  return applyTransition(current, "CREATED", timestamp, [
    event("TASK_CREATED", timestamp, { source: "draft_submission" }),
  ]);
};

export const beginTaskAnalysis = (
  task: Task,
  timestamp = nowTimestamp(),
): Task => applyTransition(parseTask(task), "ANALYZING", timestamp);

export const recordFeasibilityResult = (
  task: Task,
  result: FeasibilityResult,
  timestamp = nowTimestamp(),
): Task => {
  const current = parseTask(task);
  requireState(current, "ANALYZING");
  const feasibility = parseFeasibilityResult(result);
  const withFeasibility = parseTask({ ...current, feasibility });
  const nextState: TaskState =
    feasibility.status === "READY" || feasibility.status === "AUTO_FIXABLE"
      ? "WAITING_FOR_APPROVAL"
      : "BLOCKED";

  return applyTransition(withFeasibility, nextState, timestamp, [
    event("FEASIBILITY_RECORDED", timestamp, {
      status: feasibility.status,
      source: "supplied_m1_result",
    }),
  ]);
};

export const storeTaskContract = (
  task: Task,
  input: TaskContractInput,
  timestamp = nowTimestamp(),
): Task => {
  const current = parseTask(task);
  requireState(current, "WAITING_FOR_APPROVAL");
  const validInput = parseTaskContractInput(input);
  const taskContract: TaskContract = {
    ...validInput,
    nonGoals: validInput.nonGoals ?? [],
    approved: false,
  };

  return parseTask({
    ...current,
    taskContract,
    updatedAt: timestamp,
    events: [
      ...current.events,
      event("CONTRACT_STORED", timestamp, {
        source: "supplied_m1_contract",
      }),
    ],
  });
};

export const approveTaskContract = (
  task: Task,
  timestamp = nowTimestamp(),
): Task => {
  const current = parseTask(task);
  requireState(current, "WAITING_FOR_APPROVAL");
  if (current.taskContract === undefined) {
    throw new TaskDomainError(
      "INVALID_TRANSITION",
      `Task ${current.id} has no Task Contract to approve.`,
    );
  }

  const approvedTask = parseTask({
    ...current,
    taskContract: {
      ...current.taskContract,
      approved: true,
      approvedAt: timestamp,
    },
  });

  return applyTransition(approvedTask, "READY_FOR_IMPLEMENTATION", timestamp, [
    event("CONTRACT_APPROVED", timestamp),
  ]);
};

export const pauseTask = (
  task: Task,
  reason?: string,
  timestamp = nowTimestamp(),
): Task => {
  const current = parseTask(task);
  if (!pausableStates.has(current.state)) {
    return invalidTransition(current, "PAUSED");
  }

  return parseTask({
    ...current,
    state: "PAUSED",
    pause: {
      pausedAt: timestamp,
      previousState: current.state,
      ...(reason === undefined ? {} : { reason }),
    },
    updatedAt: timestamp,
    events: [
      ...current.events,
      event("TASK_PAUSED", timestamp, {
        previousState: current.state,
        ...(reason === undefined ? {} : { reason }),
      }),
      event("STATE_CHANGED", timestamp, {
        from: current.state,
        to: "PAUSED",
      }),
    ],
  });
};

export const resumeTask = (
  task: Task,
  timestamp = nowTimestamp(),
): Task => {
  const current = parseTask(task);
  requireState(current, "PAUSED");
  if (current.pause === undefined) {
    throw new TaskDomainError(
      "VALIDATION_ERROR",
      `Paused task ${current.id} has no resume information.`,
    );
  }

  const previousState = current.pause.previousState;
  const { pause: _pause, ...withoutPause } = current;

  return parseTask({
    ...withoutPause,
    state: previousState,
    updatedAt: timestamp,
    events: [
      ...current.events,
      event("TASK_RESUMED", timestamp, { resumedState: previousState }),
      event("STATE_CHANGED", timestamp, {
        from: "PAUSED",
        to: previousState,
      }),
    ],
  });
};

export const recheckTask = (
  task: Task,
  timestamp = nowTimestamp(),
): Task => {
  const current = parseTask(task);
  const isBlocked = current.state === "BLOCKED";
  const isPausedBlocked =
    current.state === "PAUSED" && current.pause?.previousState === "BLOCKED";

  if (!isBlocked && !isPausedBlocked) {
    return invalidTransition(current, "ANALYZING");
  }

  const previousFeasibilityStatus = current.feasibility?.status;
  const {
    feasibility: _feasibility,
    pause: _pause,
    taskContract: _taskContract,
    ...withoutPriorAnalysis
  } = current;

  return parseTask({
    ...withoutPriorAnalysis,
    state: "ANALYZING",
    updatedAt: timestamp,
    events: [
      ...current.events,
      event("RECHECK_REQUESTED", timestamp, {
        sourceState: current.state,
        ...(previousFeasibilityStatus === undefined
          ? {}
          : { previousFeasibilityStatus }),
      }),
      event("STATE_CHANGED", timestamp, {
        from: current.state,
        to: "ANALYZING",
      }),
    ],
  });
};

export const cancelTask = (
  task: Task,
  reason?: string,
  timestamp = nowTimestamp(),
): Task => {
  const current = parseTask(task);
  if (!cancellableStates.has(current.state)) {
    return invalidTransition(current, "CANCELLED");
  }

  const { pause: _pause, ...withoutPause } = current;

  return parseTask({
    ...withoutPause,
    state: "CANCELLED",
    cancellation: {
      cancelledAt: timestamp,
      ...(reason === undefined ? {} : { reason }),
    },
    updatedAt: timestamp,
    events: [
      ...current.events,
      event("TASK_CANCELLED", timestamp, {
        previousState: current.state,
        ...(reason === undefined ? {} : { reason }),
      }),
      event("STATE_CHANGED", timestamp, {
        from: current.state,
        to: "CANCELLED",
      }),
    ],
  });
};

export const createPrerequisiteDraft = (
  parentTask: Task,
  draftId: TaskId,
  suggestedRequest: string,
  timestamp = nowTimestamp(),
): PrerequisiteDraftResult => {
  const parent = parseTask(parentTask);
  const isBlocked = parent.state === "BLOCKED";
  const isPausedBlocked =
    parent.state === "PAUSED" && parent.pause?.previousState === "BLOCKED";
  if (!isBlocked && !isPausedBlocked) {
    throw new TaskDomainError(
      "INVALID_TRANSITION",
      `Task ${parent.id} must be blocked before creating a prerequisite draft.`,
    );
  }

  const validDraftId = parseTaskId(draftId);
  if (validDraftId === parent.id) {
    throw new TaskDomainError(
      "VALIDATION_ERROR",
      "A prerequisite draft must have a different task ID.",
    );
  }

  const draftInput = parseCreateTaskInput({
    originalRequest: suggestedRequest,
    ...(parent.targetProjectPath === undefined
      ? {}
      : { targetProjectPath: parent.targetProjectPath }),
    strength: parent.strength,
    crossReviewEnabled: parent.crossReviewEnabled,
    automaticFixesEnabled: parent.automaticFixesEnabled,
  });

  const prerequisiteDraft = parseTask({
    id: validDraftId,
    originalRequest: draftInput.originalRequest,
    ...(draftInput.targetProjectPath === undefined
      ? {}
      : { targetProjectPath: draftInput.targetProjectPath }),
    strength: draftInput.strength,
    state: "DRAFT",
    createdAt: timestamp,
    updatedAt: timestamp,
    crossReviewEnabled: parent.crossReviewEnabled,
    automaticFixesEnabled: parent.automaticFixesEnabled,
    originTaskId: parent.id,
    prerequisiteDraftIds: [],
    events: [
      event("TASK_DRAFT_CREATED", timestamp, { originTaskId: parent.id }),
    ],
  });

  const updatedParent = parseTask({
    ...parent,
    prerequisiteDraftIds: [...parent.prerequisiteDraftIds, validDraftId],
    updatedAt: timestamp,
    events: [
      ...parent.events,
      event("PREREQUISITE_DRAFT_CREATED", timestamp, {
        prerequisiteDraftId: validDraftId,
      }),
    ],
  });

  return { parentTask: updatedParent, prerequisiteDraft };
};

export const editTaskDraft = (
  task: Task,
  input: DraftTaskPatch,
  timestamp = nowTimestamp(),
): Task => {
  const current = parseTask(task);
  requireState(current, "DRAFT");
  const patch = parseDraftTaskPatch(input);
  let updated: Task = current;

  if (patch.title === null) {
    const { title: _title, ...withoutTitle } = updated;
    updated = withoutTitle;
  } else if (patch.title !== undefined) {
    updated = { ...updated, title: patch.title };
  }

  if (patch.originalRequest !== undefined) {
    updated = { ...updated, originalRequest: patch.originalRequest };
  }

  if (patch.targetProjectPath === null) {
    const { targetProjectPath: _path, ...withoutPath } = updated;
    updated = withoutPath;
  } else if (patch.targetProjectPath !== undefined) {
    updated = { ...updated, targetProjectPath: patch.targetProjectPath };
  }

  if (patch.strength !== undefined) {
    updated = { ...updated, strength: patch.strength };
  }
  if (patch.crossReviewEnabled !== undefined) {
    updated = { ...updated, crossReviewEnabled: patch.crossReviewEnabled };
  }
  if (patch.automaticFixesEnabled !== undefined) {
    updated = {
      ...updated,
      automaticFixesEnabled: patch.automaticFixesEnabled,
    };
  }

  return parseTask({
    ...updated,
    updatedAt: timestamp,
    events: [
      ...current.events,
      event("DRAFT_UPDATED", timestamp, {
        fields: Object.keys(patch).sort().join(","),
      }),
    ],
  });
};
