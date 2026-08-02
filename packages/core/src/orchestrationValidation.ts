import { TaskDomainError } from "./errors.js";
import {
  ORCHESTRATION_PHASES,
  REVIEW_SEVERITIES,
  REVIEW_STATUSES,
} from "./orchestrationTypes.js";
import type {
  ImplementationAgentOutput,
  ImplementationResult,
  ReviewAgentOutput,
  ReviewFinding,
  ReviewResult,
  TaskExecutionFailure,
} from "./orchestrationTypes.js";
import { parseReasoningEffort } from "./aiValidation.js";

type JsonRecord = Record<string, unknown>;

const invalid = (message: string): never => {
  throw new TaskDomainError("VALIDATION_ERROR", message);
};

const record = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${path} must be an object.`);
  }
  return value as JsonRecord;
};

const string = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`${path} must be a non-empty string.`);
  }
  return value;
};

const strings = (value: unknown, path: string): readonly string[] => {
  if (!Array.isArray(value)) {
    return invalid(`${path} must be an array.`);
  }
  return value.map((entry, index) => string(entry, `${path}[${index}]`));
};

const timestamp = (value: unknown, path: string): string => {
  const result = string(value, path);
  if (Number.isNaN(Date.parse(result))) {
    return invalid(`${path} must be a timestamp.`);
  }
  return result;
};

export const parseTaskExecutionFailure = (
  value: unknown,
): TaskExecutionFailure => {
  const input = record(value, "execution failure");
  if (
    typeof input.phase !== "string" ||
    !ORCHESTRATION_PHASES.includes(
      input.phase as (typeof ORCHESTRATION_PHASES)[number],
    )
  ) {
    return invalid("execution failure.phase is not recognized.");
  }
  const runId = input.runId === undefined
    ? undefined
    : string(input.runId, "execution failure.runId");
  return {
    phase: input.phase as TaskExecutionFailure["phase"],
    code: string(input.code, "execution failure.code"),
    message: string(input.message, "execution failure.message"),
    occurredAt: timestamp(input.occurredAt, "execution failure.occurredAt"),
    ...(runId === undefined ? {} : { runId }),
  };
};

export const parseImplementationAgentOutput = (
  value: unknown,
): ImplementationAgentOutput => {
  const input = record(value, "implementation output");
  return {
    summary: string(input.summary, "implementation output.summary"),
    changedFiles: strings(
      input.changedFiles,
      "implementation output.changedFiles",
    ),
    implementationNotes: strings(
      input.implementationNotes,
      "implementation output.implementationNotes",
    ),
    sanityChecks: strings(
      input.sanityChecks,
      "implementation output.sanityChecks",
    ),
    warnings: strings(input.warnings, "implementation output.warnings"),
  };
};

export const parseImplementationResult = (
  value: unknown,
): ImplementationResult => {
  const input = record(value, "implementation result");
  if (input.schemaVersion !== 1 || input.status !== "SUCCEEDED") {
    return invalid(
      "implementation result must use schemaVersion 1 and status SUCCEEDED.",
    );
  }
  const checkpointId = input.checkpointId === undefined
    ? undefined
    : string(input.checkpointId, "implementation result.checkpointId");
  const checkpointCommit = input.checkpointCommit === undefined
    ? undefined
    : string(input.checkpointCommit, "implementation result.checkpointCommit");
  if ((checkpointId === undefined) !== (checkpointCommit === undefined)) {
    return invalid("Implementation checkpoint ID and commit must be stored together.");
  }
  return {
    schemaVersion: 1,
    ...parseImplementationAgentOutput(input),
    runId: string(input.runId, "implementation result.runId"),
    providerId: string(input.providerId, "implementation result.providerId"),
    modelId: string(input.modelId, "implementation result.modelId"),
    effort: parseReasoningEffort(
      input.effort,
      "implementation result.effort",
    ),
    status: "SUCCEEDED",
    startedAt: timestamp(input.startedAt, "implementation result.startedAt"),
    finishedAt: timestamp(input.finishedAt, "implementation result.finishedAt"),
    ...(checkpointId === undefined || checkpointCommit === undefined
      ? {}
      : { checkpointId, checkpointCommit }),
  };
};

const parseReviewFinding = (value: unknown, path: string): ReviewFinding => {
  const input = record(value, path);
  if (
    typeof input.severity !== "string" ||
    !REVIEW_SEVERITIES.includes(
      input.severity as (typeof REVIEW_SEVERITIES)[number],
    )
  ) {
    return invalid(`${path}.severity is not recognized.`);
  }
  return {
    id: string(input.id, `${path}.id`),
    severity: input.severity as ReviewFinding["severity"],
    title: string(input.title, `${path}.title`),
    description: string(input.description, `${path}.description`),
    evidence: string(input.evidence, `${path}.evidence`),
    relatedFiles: strings(input.relatedFiles, `${path}.relatedFiles`),
  };
};

export const parseReviewAgentOutput = (value: unknown): ReviewAgentOutput => {
  const input = record(value, "review output");
  if (
    typeof input.status !== "string" ||
    !REVIEW_STATUSES.includes(input.status as (typeof REVIEW_STATUSES)[number])
  ) {
    return invalid("review output.status is not recognized.");
  }
  if (!Array.isArray(input.findings)) {
    return invalid("review output.findings must be an array.");
  }
  const findings = input.findings.map((entry, index) =>
    parseReviewFinding(entry, `review output.findings[${index}]`),
  );
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length) {
    return invalid("review finding IDs must be unique.");
  }
  if (input.status === "PASS" && findings.length > 0) {
    return invalid("A PASS review must not include findings.");
  }
  if (input.status === "FINDINGS" && findings.length === 0) {
    return invalid("A FINDINGS review must include at least one finding.");
  }
  return {
    status: input.status as ReviewAgentOutput["status"],
    summary: string(input.summary, "review output.summary"),
    findings,
    qaFocus: strings(input.qaFocus, "review output.qaFocus"),
  };
};

export const parseReviewResult = (value: unknown): ReviewResult => {
  const input = record(value, "review result");
  if (input.schemaVersion !== 1) {
    return invalid("review result.schemaVersion must be 1.");
  }
  return {
    schemaVersion: 1,
    ...parseReviewAgentOutput(input),
    runId: string(input.runId, "review result.runId"),
    providerId: string(input.providerId, "review result.providerId"),
    modelId: string(input.modelId, "review result.modelId"),
    effort: parseReasoningEffort(input.effort, "review result.effort"),
    startedAt: timestamp(input.startedAt, "review result.startedAt"),
    finishedAt: timestamp(input.finishedAt, "review result.finishedAt"),
  };
};
