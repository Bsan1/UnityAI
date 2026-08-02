import { TaskDomainError } from "./errors.js";
import { GIT_ENVIRONMENT_STATUSES } from "./gitTypes.js";
import type {
  GitCheckpoint,
  GitEnvironmentStatus,
  GitTaskEnvironment,
} from "./gitTypes.js";
import { parseTaskId } from "./taskValidation.js";

type JsonRecord = Record<string, unknown>;

const statusSet = new Set<string>(GIT_ENVIRONMENT_STATUSES);
const commitPattern = /^[0-9a-f]{40,64}$/;
const checkpointPattern = /^CHECKPOINT-\d{4,}$/;

const invalid = (message: string): never => {
  throw new TaskDomainError("VALIDATION_ERROR", message);
};

const readRecord = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${path} must be an object.`);
  }
  return value as JsonRecord;
};

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
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return undefined;
  }
  return readString(record[key], `${path}.${key}`);
};

const readTimestamp = (value: unknown, path: string): string => {
  const timestamp = readString(value, path);
  if (Number.isNaN(Date.parse(timestamp))) {
    return invalid(`${path} must be a valid timestamp.`);
  }
  return timestamp;
};

const readCommit = (value: unknown, path: string): string => {
  const commit = readString(value, path);
  if (!commitPattern.test(commit)) {
    return invalid(`${path} must be a full hexadecimal Git commit ID.`);
  }
  return commit;
};

const parseCheckpoint = (value: unknown, index: number): GitCheckpoint => {
  const path = `git environment.checkpoints[${index}]`;
  const record = readRecord(value, path);
  const id = readString(record.id, `${path}.id`);
  if (!checkpointPattern.test(id)) {
    return invalid(`${path}.id must use the CHECKPOINT-0001 format.`);
  }

  return {
    id: id as GitCheckpoint["id"],
    label: readString(record.label, `${path}.label`),
    commit: readCommit(record.commit, `${path}.commit`),
    createdAt: readTimestamp(record.createdAt, `${path}.createdAt`),
  };
};

export const parseGitTaskEnvironment = (
  value: unknown,
): GitTaskEnvironment => {
  const record = readRecord(value, "git environment");
  if (record.schemaVersion !== 1) {
    return invalid("git environment.schemaVersion must be 1.");
  }

  const taskId = parseTaskId(record.taskId, "git environment.taskId");
  const writeOwnerTaskId = parseTaskId(
    record.writeOwnerTaskId,
    "git environment.writeOwnerTaskId",
  );
  if (writeOwnerTaskId !== taskId) {
    return invalid("The Git write owner must match the task ID.");
  }

  const status = record.status;
  if (typeof status !== "string" || !statusSet.has(status)) {
    return invalid("git environment.status is not recognized.");
  }
  const validStatus = status as GitEnvironmentStatus;

  if (!Array.isArray(record.checkpoints)) {
    return invalid("git environment.checkpoints must be an array.");
  }
  const checkpoints = record.checkpoints.map((checkpoint, index) =>
    parseCheckpoint(checkpoint, index),
  );
  if (new Set(checkpoints.map((checkpoint) => checkpoint.id)).size !== checkpoints.length) {
    return invalid("Git checkpoint IDs must be unique.");
  }

  const finalizedAtValue = readOptionalString(
    record,
    "finalizedAt",
    "git environment",
  );
  const finalCommitValue = readOptionalString(
    record,
    "finalCommit",
    "git environment",
  );
  const cleanedAtValue = readOptionalString(
    record,
    "cleanedAt",
    "git environment",
  );

  if ((finalizedAtValue === undefined) !== (finalCommitValue === undefined)) {
    return invalid("finalizedAt and finalCommit must be stored together.");
  }
  if (validStatus === "ACTIVE" && finalizedAtValue !== undefined) {
    return invalid("An active Git environment cannot be finalized.");
  }
  if (validStatus === "FINALIZED" && finalizedAtValue === undefined) {
    return invalid("A finalized Git environment needs final commit metadata.");
  }
  if (validStatus !== "CLEANED" && cleanedAtValue !== undefined) {
    return invalid("Only a cleaned Git environment may include cleanedAt.");
  }
  if (validStatus === "CLEANED" && cleanedAtValue === undefined) {
    return invalid("A cleaned Git environment must include cleanedAt.");
  }

  const taskBranch = readString(record.taskBranch, "git environment.taskBranch");
  if (taskBranch !== `ai/${taskId}`) {
    return invalid(`git environment.taskBranch must be ai/${taskId}.`);
  }

  const originalWorktreePath = readString(
    record.originalWorktreePath,
    "git environment.originalWorktreePath",
  );
  const taskWorktreePath = readString(
    record.taskWorktreePath,
    "git environment.taskWorktreePath",
  );
  if (originalWorktreePath === taskWorktreePath) {
    return invalid("Original and managed worktree paths must differ.");
  }

  return {
    schemaVersion: 1,
    taskId,
    repositoryRoot: readString(
      record.repositoryRoot,
      "git environment.repositoryRoot",
    ),
    originalWorktreePath,
    gitCommonDirectory: readString(
      record.gitCommonDirectory,
      "git environment.gitCommonDirectory",
    ),
    baseBranch: readString(record.baseBranch, "git environment.baseBranch"),
    baseCommit: readCommit(record.baseCommit, "git environment.baseCommit"),
    taskBranch,
    taskWorktreePath,
    writeOwnerTaskId,
    status: validStatus,
    createdAt: readTimestamp(record.createdAt, "git environment.createdAt"),
    checkpoints,
    ...(finalizedAtValue === undefined
      ? {}
      : {
          finalizedAt: readTimestamp(
            finalizedAtValue,
            "git environment.finalizedAt",
          ),
          finalCommit: readCommit(
            finalCommitValue,
            "git environment.finalCommit",
          ),
        }),
    ...(cleanedAtValue === undefined
      ? {}
      : {
          cleanedAt: readTimestamp(
            cleanedAtValue,
            "git environment.cleanedAt",
          ),
        }),
  };
};
