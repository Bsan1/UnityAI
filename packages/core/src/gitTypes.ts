import type { TaskId } from "./taskTypes.js";

export const GIT_ENVIRONMENT_STATUSES = [
  "ACTIVE",
  "FINALIZED",
  "CLEANED",
] as const;

export type GitEnvironmentStatus =
  (typeof GIT_ENVIRONMENT_STATUSES)[number];

export interface GitCheckpoint {
  readonly id: `CHECKPOINT-${string}`;
  readonly label: string;
  readonly commit: string;
  readonly createdAt: string;
}

export interface GitTaskEnvironment {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly repositoryRoot: string;
  readonly originalWorktreePath: string;
  readonly gitCommonDirectory: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
  readonly taskBranch: string;
  readonly taskWorktreePath: string;
  readonly writeOwnerTaskId: TaskId;
  readonly status: GitEnvironmentStatus;
  readonly createdAt: string;
  readonly checkpoints: readonly GitCheckpoint[];
  readonly finalizedAt?: string;
  readonly finalCommit?: string;
  readonly cleanedAt?: string;
}
