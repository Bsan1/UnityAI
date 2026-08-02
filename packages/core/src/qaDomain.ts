import { TaskDomainError } from "./errors.js";
import { parseQATechnicalFailure } from "./qaValidation.js";
import type { QATechnicalFailure } from "./qaTypes.js";
import type { Task, TaskEvent, TaskEventType } from "./taskTypes.js";
import { parseTask } from "./taskValidation.js";

const timestamp = (): string => new Date().toISOString();

const event = (
  type: TaskEventType,
  at: string,
  metadata?: Readonly<Record<string, string>>,
): TaskEvent => ({ type, timestamp: at, ...(metadata === undefined ? {} : { metadata }) });

const requireState = (task: Task, ...states: readonly Task["state"][]): void => {
  if (!states.includes(task.state)) {
    throw new TaskDomainError(
      "INVALID_TRANSITION",
      `Task ${task.id} cannot perform this QA transition from ${task.state}.`,
    );
  }
};

const changeState = (
  task: Task,
  state: Task["state"],
  at: string,
  events: readonly TaskEvent[],
): Task => parseTask({
  ...task,
  state,
  updatedAt: at,
  events: [
    ...task.events,
    ...events,
    event("STATE_CHANGED", at, { from: task.state, to: state }),
  ],
});

export const beginTaskQA = (
  taskValue: Task,
  input: { readonly sessionId: string; readonly cycleNumber: number },
  at = timestamp(),
): Task => {
  const task = parseTask(taskValue);
  requireState(task, "READY_FOR_QA");
  return changeState(task, "TESTING", at, [
    event("QA_STARTED", at, {
      sessionId: input.sessionId,
      cycleNumber: String(input.cycleNumber),
    }),
  ]);
};

export const beginTaskGameplayQA = (
  taskValue: Task,
  input: { readonly sessionId: string; readonly cycleNumber: number },
  at = timestamp(),
): Task => {
  const task = parseTask(taskValue);
  requireState(task, "READY_FOR_GAMEPLAY_QA");
  return changeState(task, "TESTING", at, [
    event("GAMEPLAY_QA_STARTED", at, {
      sessionId: input.sessionId,
      cycleNumber: String(input.cycleNumber),
    }),
    event("QA_RESTARTED", at, {
      sessionId: input.sessionId,
      cycleNumber: String(input.cycleNumber),
      scope: "QA0_QA1_QA2_QA3",
    }),
  ]);
};

export const recordTaskQAFailure = (
  taskValue: Task,
  input: {
    readonly sessionId: string;
    readonly findingCount: number;
    readonly technical: boolean;
    readonly code?: string;
  },
  at = timestamp(),
): Task => {
  const task = parseTask(taskValue);
  requireState(task, "TESTING", "FIXING");
  return changeState(task, "FAILED", at, [
    event("QA_CYCLE_COMPLETED", at, {
      sessionId: input.sessionId,
      outcome: input.technical ? "TECHNICAL_FAILURE" : "FAIL",
    }),
    event("QA_FAILED", at, {
      sessionId: input.sessionId,
      findingCount: String(input.findingCount),
      technical: String(input.technical),
      ...(input.code === undefined ? {} : { code: input.code }),
    }),
  ]);
};

export const beginTaskFix = (
  taskValue: Task,
  input: { readonly sourceSessionId: string; readonly fixNumber: number; readonly automatic: boolean },
  at = timestamp(),
): Task => {
  const task = parseTask(taskValue);
  requireState(task, "FAILED");
  return changeState(task, "FIXING", at, [
    event("FIX_STARTED", at, {
      sourceSessionId: input.sourceSessionId,
      fixNumber: String(input.fixNumber),
      automatic: String(input.automatic),
    }),
  ]);
};

export const completeTaskFixAndRestartQA = (
  taskValue: Task,
  input: {
    readonly fixId: string;
    readonly runId: string;
    readonly checkpointId: string;
    readonly checkpointCommit: string;
    readonly nextSessionId: string;
    readonly nextCycleNumber: number;
  },
  at = timestamp(),
): Task => {
  const task = parseTask(taskValue);
  requireState(task, "FIXING");
  return changeState(task, "TESTING", at, [
    event("FIX_COMPLETED", at, { fixId: input.fixId, runId: input.runId }),
    event("FIX_CHECKPOINT_CREATED", at, {
      checkpointId: input.checkpointId,
      commit: input.checkpointCommit,
    }),
    event("QA_RESTARTED", at, {
      sessionId: input.nextSessionId,
      cycleNumber: String(input.nextCycleNumber),
    }),
  ]);
};

export const failTaskFix = (
  taskValue: Task,
  failureValue: QATechnicalFailure,
  sourceSessionId: string,
  at = timestamp(),
): Task => {
  const task = parseTask(taskValue);
  const failure = parseQATechnicalFailure(failureValue);
  requireState(task, "FIXING");
  return changeState(task, "FAILED", at, [
    event("QA_FAILED", at, {
      sessionId: sourceSessionId,
      phase: "FIX",
      code: failure.code,
      technical: "true",
    }),
  ]);
};

export const recordTaskQAProgress = (
  taskValue: Task,
  type:
    | "QA_TEST_STARTED"
    | "QA_TEST_COMPLETED"
    | "GAMEPLAY_TEST_STARTED"
    | "GAMEPLAY_TEST_COMPLETED"
    | "INPUT_SENT"
    | "SCREENSHOT_CAPTURED"
    | "GAMEPLAY_QA_CYCLE_COMPLETED"
    | "GAMEPLAY_QA_PASSED",
  metadata: Readonly<Record<string, string>>,
  at = timestamp(),
): Task => {
  const task = parseTask(taskValue);
  requireState(task, "TESTING");
  return parseTask({
    ...task,
    updatedAt: at,
    events: [...task.events, event(type, at, metadata)],
  });
};

export const completeTaskQAForGameplay = (
  taskValue: Task,
  input: { readonly sessionId: string; readonly gameplayTests: number },
  at = timestamp(),
): Task => {
  const task = parseTask(taskValue);
  requireState(task, "TESTING");
  return changeState(task, "READY_FOR_GAMEPLAY_QA", at, [
    event("QA_CYCLE_COMPLETED", at, { sessionId: input.sessionId, outcome: "INCOMPLETE_GAMEPLAY" }),
    event("QA_PASSED", at, { sessionId: input.sessionId, scope: "M7" }),
    event("QA_GAMEPLAY_PENDING", at, {
      sessionId: input.sessionId,
      gameplayTests: String(input.gameplayTests),
    }),
  ]);
};

export const completeTaskQAAndFinalize = (
  taskValue: Task,
  input: { readonly sessionId: string; readonly finalCommit: string; readonly taskBranch: string },
  at = timestamp(),
): Task => {
  const task = parseTask(taskValue);
  requireState(task, "TESTING");
  return changeState(task, "COMPLETED", at, [
    event("QA_CYCLE_COMPLETED", at, { sessionId: input.sessionId, outcome: "PASS" }),
    event("QA_PASSED", at, { sessionId: input.sessionId, scope: "ALL_REQUIRED" }),
    event("UNITY_TOOLING_REMOVED", at, { sessionId: input.sessionId }),
    event("TASK_FINALIZED", at, {
      finalCommit: input.finalCommit,
      taskBranch: input.taskBranch,
    }),
  ]);
};

export const failTaskQA = (
  taskValue: Task,
  failureValue: QATechnicalFailure,
  sessionId: string,
  at = timestamp(),
): Task => {
  const task = parseTask(taskValue);
  const failure = parseQATechnicalFailure(failureValue);
  requireState(task, "TESTING", "FIXING");
  return recordTaskQAFailure(task, {
    sessionId,
    findingCount: 0,
    technical: true,
    code: failure.code,
  }, at);
};

export const markPausedQAInterrupted = (
  taskValue: Task,
  failureValue: QATechnicalFailure,
  at = timestamp(),
): Task => {
  const task = parseTask(taskValue);
  const failure = parseQATechnicalFailure(failureValue);
  requireState(task, "PAUSED");
  if (task.pause?.previousState !== "TESTING" && task.pause?.previousState !== "FIXING") {
    throw new TaskDomainError("INVALID_TRANSITION", `Paused task ${task.id} has no active QA phase.`);
  }
  return parseTask({
    ...task,
    pause: { ...task.pause, previousState: "FAILED" },
    updatedAt: at,
    events: [
      ...task.events,
      event("QA_FAILED", at, { technical: "true", code: failure.code, phase: failure.phase }),
      event("ORCHESTRATION_INTERRUPTED", at, { phase: failure.phase, code: failure.code }),
    ],
  });
};
