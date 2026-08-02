import { TaskDomainError } from "./errors.js";
import type {
  ReviewStatus,
  TaskExecutionFailure,
} from "./orchestrationTypes.js";
import { parseTaskExecutionFailure } from "./orchestrationValidation.js";
import type { Task, TaskEvent, TaskEventType } from "./taskTypes.js";
import { parseTask } from "./taskValidation.js";

const now = (): string => new Date().toISOString();

const event = (
  type: TaskEventType,
  timestamp: string,
  metadata?: Readonly<Record<string, string>>,
): TaskEvent => ({
  type,
  timestamp,
  ...(metadata === undefined ? {} : { metadata }),
});

const requireState = (task: Task, state: Task["state"]): void => {
  if (task.state !== state) {
    throw new TaskDomainError(
      "INVALID_TRANSITION",
      `Task ${task.id} cannot transition from ${task.state}; expected ${state}.`,
    );
  }
};

const changeState = (
  task: Task,
  state: Task["state"],
  timestamp: string,
  precedingEvents: readonly TaskEvent[],
): Task =>
  parseTask({
    ...task,
    state,
    updatedAt: timestamp,
    events: [
      ...task.events,
      ...precedingEvents,
      event("STATE_CHANGED", timestamp, { from: task.state, to: state }),
    ],
  });

export const beginTaskImplementation = (
  taskValue: Task,
  gitMetadata: Readonly<Record<string, string>>,
  timestamp = now(),
): Task => {
  const task = parseTask(taskValue);
  requireState(task, "READY_FOR_IMPLEMENTATION");
  if (task.taskContract?.approved !== true || task.taskContract.executionPlan === undefined) {
    throw new TaskDomainError(
      "INVALID_TRANSITION",
      `Task ${task.id} requires an approved routed Task Contract.`,
    );
  }
  const { executionFailure: _failure, ...withoutFailure } = task;
  return changeState(
    parseTask(withoutFailure),
    "IMPLEMENTING",
    timestamp,
    [
      event("GIT_ENVIRONMENT_PREPARED", timestamp, gitMetadata),
      event("IMPLEMENTATION_STARTED", timestamp, {
        modelId: task.taskContract.executionPlan.implementation.modelId,
        effort: task.taskContract.executionPlan.implementation.effort,
      }),
    ],
  );
};

export const completeTaskImplementation = (
  taskValue: Task,
  input: {
    readonly runId: string;
    readonly checkpointId: string;
    readonly checkpointCommit: string;
    readonly changedFileCount: number;
    readonly reviewEnabled: boolean;
  },
  timestamp = now(),
): Task => {
  const task = parseTask(taskValue);
  requireState(task, "IMPLEMENTING");
  const nextState = input.reviewEnabled ? "REVIEWING" : "READY_FOR_QA";
  return changeState(task, nextState, timestamp, [
    event("IMPLEMENTATION_COMPLETED", timestamp, {
      runId: input.runId,
      changedFileCount: String(input.changedFileCount),
    }),
    event("IMPLEMENTATION_CHECKPOINT_CREATED", timestamp, {
      checkpointId: input.checkpointId,
      commit: input.checkpointCommit,
    }),
    ...(input.reviewEnabled
      ? [event("REVIEW_STARTED", timestamp)]
      : [event("READY_FOR_QA", timestamp)]),
  ]);
};

export const completeTaskReview = (
  taskValue: Task,
  input: {
    readonly runId: string;
    readonly status: ReviewStatus;
    readonly findingCount: number;
  },
  timestamp = now(),
): Task => {
  const task = parseTask(taskValue);
  requireState(task, "REVIEWING");
  return changeState(task, "READY_FOR_QA", timestamp, [
    event("REVIEW_COMPLETED", timestamp, {
      runId: input.runId,
      status: input.status,
      findingCount: String(input.findingCount),
    }),
    event("READY_FOR_QA", timestamp, {
      reviewStatus: input.status,
    }),
  ]);
};

export const failTaskExecution = (
  taskValue: Task,
  failureValue: TaskExecutionFailure,
  timestamp = now(),
): Task => {
  const task = parseTask(taskValue);
  if (task.state !== "IMPLEMENTING" && task.state !== "REVIEWING") {
    throw new TaskDomainError(
      "INVALID_TRANSITION",
      `Task ${task.id} cannot record an execution failure from ${task.state}.`,
    );
  }
  const failure = parseTaskExecutionFailure(failureValue);
  const failureEvent = failure.phase === "REVIEW"
    ? "REVIEW_FAILED"
    : failure.phase === "INTERRUPTION"
      ? "ORCHESTRATION_INTERRUPTED"
      : "IMPLEMENTATION_FAILED";
  return parseTask({
    ...task,
    state: "FAILED",
    executionFailure: failure,
    updatedAt: timestamp,
    events: [
      ...task.events,
      event(failureEvent, timestamp, {
        phase: failure.phase,
        code: failure.code,
        ...(failure.runId === undefined ? {} : { runId: failure.runId }),
      }),
      event("STATE_CHANGED", timestamp, { from: task.state, to: "FAILED" }),
    ],
  });
};

export const recordTaskOrchestrationFailure = (
  taskValue: Task,
  failureValue: TaskExecutionFailure,
  timestamp = now(),
): Task => {
  const task = parseTask(taskValue);
  if (task.state !== "READY_FOR_IMPLEMENTATION") {
    throw new TaskDomainError(
      "INVALID_TRANSITION",
      `Task ${task.id} cannot record a pre-execution failure from ${task.state}.`,
    );
  }
  const failure = parseTaskExecutionFailure(failureValue);
  return parseTask({
    ...task,
    updatedAt: timestamp,
    events: [
      ...task.events,
      event("IMPLEMENTATION_FAILED", timestamp, {
        phase: failure.phase,
        code: failure.code,
      }),
    ],
  });
};

export const markPausedExecutionInterrupted = (
  taskValue: Task,
  failureValue: TaskExecutionFailure,
  timestamp = now(),
): Task => {
  const task = parseTask(taskValue);
  requireState(task, "PAUSED");
  if (
    task.pause?.previousState !== "IMPLEMENTING" &&
    task.pause?.previousState !== "REVIEWING"
  ) {
    throw new TaskDomainError(
      "INVALID_TRANSITION",
      `Paused task ${task.id} does not contain an active execution phase.`,
    );
  }
  const failure = parseTaskExecutionFailure(failureValue);
  return parseTask({
    ...task,
    pause: { ...task.pause, previousState: "FAILED" },
    executionFailure: failure,
    updatedAt: timestamp,
    events: [
      ...task.events,
      event("ORCHESTRATION_INTERRUPTED", timestamp, {
        phase: failure.phase,
        code: failure.code,
      }),
    ],
  });
};
