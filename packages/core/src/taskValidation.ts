import { TaskDomainError } from "./errors.js";
import {
  parseAcceptanceCriterion,
  parseExecutionRoutingSnapshot,
  parsePlannedTestRequirement,
  parseTaskAnalysisFailure,
  parseTaskAnalysisSummary,
} from "./analysisValidation.js";
import {
  FEASIBILITY_STATUSES,
  TASK_EVENT_TYPES,
  TASK_STATES,
  TASK_STRENGTHS,
} from "./taskTypes.js";
import { parseTaskExecutionFailure } from "./orchestrationValidation.js";
import type {
  CancellationInfo,
  CreateTaskInput,
  DraftTaskPatch,
  FeasibilityResult,
  PauseInfo,
  Task,
  TaskContract,
  TaskContractInput,
  TaskContractPatch,
  TaskEvent,
  TaskId,
  TaskSettings,
  TaskState,
} from "./taskTypes.js";

type JsonRecord = Record<string, unknown>;

const taskStateSet = new Set<string>(TASK_STATES);
const taskStrengthSet = new Set<string>(TASK_STRENGTHS);
const feasibilityStatusSet = new Set<string>(FEASIBILITY_STATUSES);
const taskEventTypeSet = new Set<string>(TASK_EVENT_TYPES);

const pausableStates = new Set<TaskState>([
  "CREATED",
  "ANALYZING",
  "WAITING_FOR_APPROVAL",
  "BLOCKED",
  "READY_FOR_IMPLEMENTATION",
  "IMPLEMENTING",
  "REVIEWING",
  "READY_FOR_QA",
  "TESTING",
  "FAILED",
  "FIXING",
]);

const implementationStates = new Set<TaskState>([
  "READY_FOR_IMPLEMENTATION",
  "IMPLEMENTING",
  "REVIEWING",
  "READY_FOR_QA",
  "TESTING",
  "FAILED",
  "FIXING",
  "COMPLETED",
]);

const invalid = (message: string): never => {
  throw new TaskDomainError("VALIDATION_ERROR", message);
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readRecord = (value: unknown, path: string): JsonRecord => {
  if (!isRecord(value)) {
    return invalid(`${path} must be an object.`);
  }

  return value;
};

const hasOwn = (record: JsonRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const readString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`${path} must be a non-empty string.`);
  }

  return value;
};

const readOptionalString = (
  record: JsonRecord,
  key: string,
  path: string,
): string | undefined => {
  if (!hasOwn(record, key) || record[key] === undefined) {
    return undefined;
  }

  return readString(record[key], `${path}.${key}`);
};

const readBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    return invalid(`${path} must be a boolean.`);
  }

  return value;
};

const readTimestamp = (value: unknown, path: string): string => {
  const timestamp = readString(value, path);
  if (Number.isNaN(Date.parse(timestamp))) {
    return invalid(`${path} must be a valid timestamp.`);
  }

  return timestamp;
};

const readStringArray = (value: unknown, path: string): readonly string[] => {
  if (!Array.isArray(value)) {
    return invalid(`${path} must be an array.`);
  }

  return value.map((item, index) => readString(item, `${path}[${index}]`));
};

const readStringMetadata = (
  value: unknown,
  path: string,
): Readonly<Record<string, string>> => {
  const record = readRecord(value, path);
  const metadata: Record<string, string> = {};

  for (const [key, entry] of Object.entries(record)) {
    metadata[key] = readString(entry, `${path}.${key}`);
  }

  return metadata;
};

const readTaskState = (value: unknown, path: string): TaskState => {
  if (typeof value !== "string" || !taskStateSet.has(value)) {
    return invalid(`${path} must be a recognized task state.`);
  }

  return value as TaskState;
};

export const parseTaskId = (value: unknown, path = "task.id"): TaskId => {
  if (typeof value !== "string" || !/^TASK-\d{4,}$/.test(value)) {
    return invalid(`${path} must use the TASK-0001 format.`);
  }

  const sequence = Number(value.slice(5));
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    return invalid(`${path} must contain a positive numeric sequence.`);
  }

  return value as TaskId;
};

export const parseTaskSettings = (value: unknown): TaskSettings => {
  const record = readRecord(value, "settings");
  return {
    crossReviewEnabled: readBoolean(
      record.crossReviewEnabled,
      "settings.crossReviewEnabled",
    ),
    automaticFixesEnabled: readBoolean(
      record.automaticFixesEnabled,
      "settings.automaticFixesEnabled",
    ),
  };
};

export const parseCreateTaskInput = (value: unknown): CreateTaskInput => {
  const record = readRecord(value, "task input");
  const strength = record.strength;

  if (
    strength !== undefined &&
    (typeof strength !== "string" || !taskStrengthSet.has(strength))
  ) {
    return invalid(
      "task input.strength must be LIGHT, STANDARD, or STRONG.",
    );
  }

  const title = readOptionalString(record, "title", "task input");
  const targetProjectPath = readOptionalString(
    record,
    "targetProjectPath",
    "task input",
  );
  const crossReviewEnabled = hasOwn(record, "crossReviewEnabled")
    ? readBoolean(record.crossReviewEnabled, "task input.crossReviewEnabled")
    : undefined;
  const automaticFixesEnabled = hasOwn(record, "automaticFixesEnabled")
    ? readBoolean(
        record.automaticFixesEnabled,
        "task input.automaticFixesEnabled",
      )
    : undefined;

  return {
    originalRequest: readString(
      record.originalRequest,
      "task input.originalRequest",
    ),
    ...(strength === undefined
      ? {}
      : { strength: strength as NonNullable<CreateTaskInput["strength"]> }),
    ...(title === undefined ? {} : { title }),
    ...(targetProjectPath === undefined ? {} : { targetProjectPath }),
    ...(crossReviewEnabled === undefined ? {} : { crossReviewEnabled }),
    ...(automaticFixesEnabled === undefined
      ? {}
      : { automaticFixesEnabled }),
  };
};

export const parseDraftTaskPatch = (value: unknown): DraftTaskPatch => {
  const record = readRecord(value, "draft patch");
  const patch: DraftTaskPatch = {};

  if (hasOwn(record, "title")) {
    patch.title =
      record.title === null
        ? null
        : readString(record.title, "draft patch.title");
  }

  if (hasOwn(record, "originalRequest")) {
    patch.originalRequest = readString(
      record.originalRequest,
      "draft patch.originalRequest",
    );
  }

  if (hasOwn(record, "targetProjectPath")) {
    patch.targetProjectPath =
      record.targetProjectPath === null
        ? null
        : readString(
            record.targetProjectPath,
            "draft patch.targetProjectPath",
          );
  }

  if (hasOwn(record, "strength")) {
    if (
      typeof record.strength !== "string" ||
      !taskStrengthSet.has(record.strength)
    ) {
      return invalid(
        "draft patch.strength must be LIGHT, STANDARD, or STRONG.",
      );
    }
    patch.strength = record.strength as NonNullable<
      CreateTaskInput["strength"]
    >;
  }

  if (hasOwn(record, "crossReviewEnabled")) {
    patch.crossReviewEnabled = readBoolean(
      record.crossReviewEnabled,
      "draft patch.crossReviewEnabled",
    );
  }

  if (hasOwn(record, "automaticFixesEnabled")) {
    patch.automaticFixesEnabled = readBoolean(
      record.automaticFixesEnabled,
      "draft patch.automaticFixesEnabled",
    );
  }

  if (Object.keys(patch).length === 0) {
    return invalid("draft patch must contain at least one editable field.");
  }

  return patch;
};

export const parseFeasibilityResult = (
  value: unknown,
): FeasibilityResult => {
  const record = readRecord(value, "feasibility result");
  const status = record.status;
  if (typeof status !== "string" || !feasibilityStatusSet.has(status)) {
    return invalid("feasibility result.status is not recognized.");
  }

  const suggestedPrerequisite = readOptionalString(
    record,
    "suggestedPrerequisite",
    "feasibility result",
  );
  const metadata = hasOwn(record, "metadata")
    ? readStringMetadata(record.metadata, "feasibility result.metadata")
    : undefined;

  return {
    status: status as FeasibilityResult["status"],
    summary: readString(record.summary, "feasibility result.summary"),
    missingCapabilities: hasOwn(record, "missingCapabilities")
      ? readStringArray(
          record.missingCapabilities,
          "feasibility result.missingCapabilities",
        )
      : [],
    ...(suggestedPrerequisite === undefined
      ? {}
      : { suggestedPrerequisite }),
    ...(metadata === undefined ? {} : { metadata }),
  };
};

export const parseTaskContractInput = (
  value: unknown,
): TaskContractInput => {
  const record = readRecord(value, "task contract");
  const nonGoals = hasOwn(record, "nonGoals")
    ? readStringArray(record.nonGoals, "task contract.nonGoals")
    : undefined;

  const originalTaskSummary = readOptionalString(
    record,
    "originalTaskSummary",
    "task contract",
  );
  const taskStrength = hasOwn(record, "taskStrength")
    ? (() => {
        if (
          typeof record.taskStrength !== "string" ||
          !taskStrengthSet.has(record.taskStrength)
        ) {
          return invalid(
            "task contract.taskStrength must be LIGHT, STANDARD, or STRONG.",
          );
        }
        return record.taskStrength as TaskContractInput["taskStrength"];
      })()
    : undefined;
  const executionPlan = hasOwn(record, "executionPlan")
    ? parseExecutionRoutingSnapshot(record.executionPlan)
    : undefined;
  const criteriaDetails = hasOwn(record, "acceptanceCriteriaDetails")
    ? (() => {
        if (!Array.isArray(record.acceptanceCriteriaDetails)) {
          return invalid(
            "task contract.acceptanceCriteriaDetails must be an array.",
          );
        }
        return record.acceptanceCriteriaDetails.map((entry, index) =>
          parseAcceptanceCriterion(
            entry,
            `task contract.acceptanceCriteriaDetails[${index}]`,
          ),
        );
      })()
    : undefined;
  const testDetails = hasOwn(record, "testRequirementDetails")
    ? (() => {
        if (!Array.isArray(record.testRequirementDetails)) {
          return invalid(
            "task contract.testRequirementDetails must be an array.",
          );
        }
        return record.testRequirementDetails.map((entry, index) =>
          parsePlannedTestRequirement(
            entry,
            `task contract.testRequirementDetails[${index}]`,
          ),
        );
      })()
    : undefined;
  const acceptanceCriteria = readStringArray(
    record.acceptanceCriteria,
    "task contract.acceptanceCriteria",
  );
  const testRequirements = readStringArray(
    record.testRequirements,
    "task contract.testRequirements",
  );

  if ((taskStrength === undefined) !== (executionPlan === undefined)) {
    return invalid(
      "task contract taskStrength and executionPlan must be provided together.",
    );
  }
  if (taskStrength !== undefined && taskStrength !== executionPlan?.taskStrength) {
    return invalid(
      "task contract task strength must match its execution plan.",
    );
  }
  if (
    criteriaDetails !== undefined &&
    new Set(criteriaDetails.map((criterion) => criterion.id)).size !==
      criteriaDetails.length
  ) {
    return invalid("task contract acceptance criterion IDs must be unique.");
  }
  if (
    testDetails !== undefined &&
    new Set(testDetails.map((requirement) => requirement.id)).size !==
      testDetails.length
  ) {
    return invalid("task contract test requirement IDs must be unique.");
  }
  if (
    criteriaDetails !== undefined &&
    JSON.stringify(criteriaDetails.map((criterion) => criterion.description)) !==
      JSON.stringify(acceptanceCriteria)
  ) {
    return invalid(
      "task contract acceptanceCriteria must match acceptanceCriteriaDetails.",
    );
  }
  if (
    testDetails !== undefined &&
    JSON.stringify(
      testDetails.map(
        (requirement) => `${requirement.category}: ${requirement.description}`,
      ),
    ) !== JSON.stringify(testRequirements)
  ) {
    return invalid(
      "task contract testRequirements must match testRequirementDetails.",
    );
  }

  return {
    ...(originalTaskSummary === undefined ? {} : { originalTaskSummary }),
    understoodExplicitRequirements: readStringArray(
      record.understoodExplicitRequirements,
      "task contract.understoodExplicitRequirements",
    ),
    inferredRequirements: readStringArray(
      record.inferredRequirements,
      "task contract.inferredRequirements",
    ),
    prerequisites: readStringArray(
      record.prerequisites,
      "task contract.prerequisites",
    ),
    implementationScope: readStringArray(
      record.implementationScope,
      "task contract.implementationScope",
    ),
    ...(nonGoals === undefined ? {} : { nonGoals }),
    acceptanceCriteria,
    testRequirements,
    ...(taskStrength === undefined ? {} : { taskStrength }),
    ...(executionPlan === undefined ? {} : { executionPlan }),
    ...(criteriaDetails === undefined
      ? {}
      : { acceptanceCriteriaDetails: criteriaDetails }),
    ...(testDetails === undefined
      ? {}
      : { testRequirementDetails: testDetails }),
  };
};

export const parseTaskContract = (value: unknown): TaskContract => {
  const record = readRecord(value, "task.taskContract");
  const input = parseTaskContractInput(record);
  const approved = readBoolean(record.approved, "task.taskContract.approved");
  const approvedAt = readOptionalString(
    record,
    "approvedAt",
    "task.taskContract",
  );

  if (approved && approvedAt === undefined) {
    return invalid("An approved task contract must include approvedAt.");
  }
  if (!approved && approvedAt !== undefined) {
    return invalid("An unapproved task contract cannot include approvedAt.");
  }

  return {
    ...input,
    nonGoals: input.nonGoals ?? [],
    approved,
    ...(approvedAt === undefined
      ? {}
      : { approvedAt: readTimestamp(approvedAt, "task.taskContract.approvedAt") }),
  };
};

export const parseTaskContractPatch = (
  value: unknown,
): TaskContractPatch => {
  const record = readRecord(value, "task contract patch");
  const allowed = new Set([
    "understoodExplicitRequirements",
    "inferredRequirements",
    "prerequisites",
    "implementationScope",
    "nonGoals",
    "acceptanceCriteriaDetails",
    "testRequirementDetails",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return invalid(`task contract patch.${key} is not editable.`);
    }
  }
  const patch: {
    -readonly [Key in keyof TaskContractPatch]: TaskContractPatch[Key];
  } = {};
  for (const field of [
    "understoodExplicitRequirements",
    "inferredRequirements",
    "prerequisites",
    "implementationScope",
    "nonGoals",
  ] as const) {
    if (hasOwn(record, field)) {
      patch[field] = readStringArray(
        record[field],
        `task contract patch.${field}`,
      );
    }
  }
  if (hasOwn(record, "acceptanceCriteriaDetails")) {
    if (!Array.isArray(record.acceptanceCriteriaDetails)) {
      return invalid(
        "task contract patch.acceptanceCriteriaDetails must be an array.",
      );
    }
    patch.acceptanceCriteriaDetails = record.acceptanceCriteriaDetails.map(
      (entry, index) =>
        parseAcceptanceCriterion(
          entry,
          `task contract patch.acceptanceCriteriaDetails[${index}]`,
        ),
    );
  }
  if (hasOwn(record, "testRequirementDetails")) {
    if (!Array.isArray(record.testRequirementDetails)) {
      return invalid(
        "task contract patch.testRequirementDetails must be an array.",
      );
    }
    patch.testRequirementDetails = record.testRequirementDetails.map(
      (entry, index) =>
        parsePlannedTestRequirement(
          entry,
          `task contract patch.testRequirementDetails[${index}]`,
        ),
    );
  }
  if (Object.keys(patch).length === 0) {
    return invalid("task contract patch must contain an editable field.");
  }
  return patch;
};

const parsePauseInfo = (value: unknown): PauseInfo => {
  const record = readRecord(value, "task.pause");
  const previousState = readTaskState(
    record.previousState,
    "task.pause.previousState",
  );
  if (previousState === "PAUSED" || !pausableStates.has(previousState)) {
    return invalid("task.pause.previousState is not a resumable state.");
  }
  const reason = readOptionalString(record, "reason", "task.pause");

  return {
    pausedAt: readTimestamp(record.pausedAt, "task.pause.pausedAt"),
    previousState,
    ...(reason === undefined ? {} : { reason }),
  };
};

const parseCancellationInfo = (value: unknown): CancellationInfo => {
  const record = readRecord(value, "task.cancellation");
  const reason = readOptionalString(record, "reason", "task.cancellation");

  return {
    cancelledAt: readTimestamp(
      record.cancelledAt,
      "task.cancellation.cancelledAt",
    ),
    ...(reason === undefined ? {} : { reason }),
  };
};

const parseTaskEvent = (value: unknown, index: number): TaskEvent => {
  const path = `task.events[${index}]`;
  const record = readRecord(value, path);
  if (typeof record.type !== "string" || !taskEventTypeSet.has(record.type)) {
    return invalid(`${path}.type is not recognized.`);
  }
  const metadata = hasOwn(record, "metadata")
    ? readStringMetadata(record.metadata, `${path}.metadata`)
    : undefined;

  return {
    timestamp: readTimestamp(record.timestamp, `${path}.timestamp`),
    type: record.type as TaskEvent["type"],
    ...(metadata === undefined ? {} : { metadata }),
  };
};

const validateTaskInvariants = (task: Task): void => {
  if (Date.parse(task.updatedAt) < Date.parse(task.createdAt)) {
    invalid("task.updatedAt cannot be earlier than task.createdAt.");
  }

  if (task.state === "PAUSED" && task.pause === undefined) {
    invalid("A paused task must include pause information.");
  }
  if (task.state !== "PAUSED" && task.pause !== undefined) {
    invalid("Only a paused task may include pause information.");
  }

  if (task.state === "CANCELLED" && task.cancellation === undefined) {
    invalid("A cancelled task must include cancellation information.");
  }
  if (task.state !== "CANCELLED" && task.cancellation !== undefined) {
    invalid("Only a cancelled task may include cancellation information.");
  }

  const effectiveState =
    task.state === "PAUSED" ? task.pause?.previousState : task.state;
  const feasibilityStatus = task.feasibility?.status;

  if (
    effectiveState === "BLOCKED" &&
    feasibilityStatus !== "AUTO_FIXABLE" &&
    feasibilityStatus !== "BLOCKED_ARCHITECTURE" &&
    feasibilityStatus !== "BLOCKED_USER"
  ) {
    invalid("A blocked task must retain a blocking feasibility result.");
  }

  if (
    effectiveState === "WAITING_FOR_APPROVAL" &&
    feasibilityStatus !== "READY"
  ) {
    invalid(
      "A task waiting for approval must have a ready feasibility result.",
    );
  }

  const isAnalysisFailure =
    effectiveState === "FAILED" && task.analysisFailure !== undefined;
  const isExecutionFailure =
    effectiveState === "FAILED" && task.executionFailure !== undefined;
  if (
    effectiveState !== undefined &&
    implementationStates.has(effectiveState) &&
    !isAnalysisFailure &&
    !isExecutionFailure &&
    task.taskContract?.approved !== true
  ) {
    invalid(
      `Task state ${effectiveState} requires an approved Task Contract.`,
    );
  }

  if (task.analysisFailure !== undefined && task.state !== "FAILED") {
    invalid("Only a failed task may retain an analysis failure.");
  }
  if (
    task.executionFailure !== undefined &&
    task.state !== "FAILED" &&
    !(task.state === "PAUSED" && task.pause?.previousState === "FAILED")
  ) {
    invalid("Only a failed or interrupted paused task may retain an execution failure.");
  }
  if (task.analysisFailure !== undefined && task.executionFailure !== undefined) {
    invalid("A task cannot retain analysis and execution failures together.");
  }
  if (task.analysis !== undefined) {
    if (task.analysis.finalStrength !== task.strength) {
      invalid("task.analysis.finalStrength must match task.strength.");
    }
    if (
      task.analysis.routingSnapshot.taskStrength !== task.analysis.finalStrength
    ) {
      invalid("task analysis strength must match its routing snapshot.");
    }
  }
  if (
    task.taskContract?.taskStrength !== undefined &&
    task.taskContract.taskStrength !== task.strength
  ) {
    invalid("Task Contract strength must match task.strength.");
  }

  if (task.originTaskId === task.id) {
    invalid("A task cannot be its own prerequisite origin.");
  }

  const draftIds = new Set(task.prerequisiteDraftIds);
  if (draftIds.size !== task.prerequisiteDraftIds.length) {
    invalid("task.prerequisiteDraftIds cannot contain duplicates.");
  }
  if (draftIds.has(task.id)) {
    invalid("A task cannot reference itself as a prerequisite draft.");
  }

  if (task.events.length === 0) {
    invalid("task.events must contain at least one history event.");
  }
};

export const parseTask = (value: unknown): Task => {
  const record = readRecord(value, "task");
  const title = readOptionalString(record, "title", "task");
  const targetProjectPath = readOptionalString(
    record,
    "targetProjectPath",
    "task",
  );
  const originTaskId = hasOwn(record, "originTaskId")
    ? parseTaskId(record.originTaskId, "task.originTaskId")
    : undefined;
  const feasibility = hasOwn(record, "feasibility")
    ? parseFeasibilityResult(record.feasibility)
    : undefined;
  const taskContract = hasOwn(record, "taskContract")
    ? parseTaskContract(record.taskContract)
    : undefined;
  const analysis = hasOwn(record, "analysis")
    ? parseTaskAnalysisSummary(record.analysis)
    : undefined;
  const analysisFailure = hasOwn(record, "analysisFailure")
    ? parseTaskAnalysisFailure(record.analysisFailure)
    : undefined;
  const executionFailure = hasOwn(record, "executionFailure")
    ? parseTaskExecutionFailure(record.executionFailure)
    : undefined;
  const pause = hasOwn(record, "pause")
    ? parsePauseInfo(record.pause)
    : undefined;
  const cancellation = hasOwn(record, "cancellation")
    ? parseCancellationInfo(record.cancellation)
    : undefined;

  if (!Array.isArray(record.prerequisiteDraftIds)) {
    return invalid("task.prerequisiteDraftIds must be an array.");
  }
  if (!Array.isArray(record.events)) {
    return invalid("task.events must be an array.");
  }

  const strength = record.strength;
  if (typeof strength !== "string" || !taskStrengthSet.has(strength)) {
    return invalid("task.strength must be LIGHT, STANDARD, or STRONG.");
  }

  const task: Task = {
    id: parseTaskId(record.id),
    ...(title === undefined ? {} : { title }),
    originalRequest: readString(record.originalRequest, "task.originalRequest"),
    ...(targetProjectPath === undefined ? {} : { targetProjectPath }),
    strength: strength as Task["strength"],
    state: readTaskState(record.state, "task.state"),
    createdAt: readTimestamp(record.createdAt, "task.createdAt"),
    updatedAt: readTimestamp(record.updatedAt, "task.updatedAt"),
    crossReviewEnabled: readBoolean(
      record.crossReviewEnabled,
      "task.crossReviewEnabled",
    ),
    automaticFixesEnabled: readBoolean(
      record.automaticFixesEnabled,
      "task.automaticFixesEnabled",
    ),
    ...(feasibility === undefined ? {} : { feasibility }),
    ...(taskContract === undefined ? {} : { taskContract }),
    ...(analysis === undefined ? {} : { analysis }),
    ...(analysisFailure === undefined ? {} : { analysisFailure }),
    ...(executionFailure === undefined ? {} : { executionFailure }),
    ...(pause === undefined ? {} : { pause }),
    ...(cancellation === undefined ? {} : { cancellation }),
    ...(originTaskId === undefined ? {} : { originTaskId }),
    prerequisiteDraftIds: record.prerequisiteDraftIds.map((item, index) =>
      parseTaskId(item, `task.prerequisiteDraftIds[${index}]`),
    ),
    events: record.events.map((event, index) => parseTaskEvent(event, index)),
  };

  validateTaskInvariants(task);
  return task;
};
