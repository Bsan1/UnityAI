import { ServerError } from "./errors.js";

export type GitSafetyErrorCode =
  | "INVALID_TARGET_PATH"
  | "NOT_A_GIT_REPOSITORY"
  | "TARGET_WORKTREE_DIRTY"
  | "NO_COMMITS"
  | "UNSUPPORTED_HEAD_STATE"
  | "TASK_BRANCH_EXISTS"
  | "TASK_WORKTREE_EXISTS"
  | "GIT_ENVIRONMENT_NOT_PREPARED"
  | "GIT_ENVIRONMENT_MISMATCH"
  | "NOT_MANAGED_WORKTREE"
  | "NOTHING_TO_CHECKPOINT"
  | "NOTHING_TO_FINALIZE"
  | "CHECKPOINT_NOT_FOUND"
  | "WORKTREE_HAS_CHANGES"
  | "GIT_COMMAND_FAILED";

export class GitSafetyError extends ServerError {
  declare readonly code: GitSafetyErrorCode;

  constructor(
    code: GitSafetyErrorCode,
    message: string,
    statusCode = 409,
    details?: unknown,
  ) {
    super(code, message, statusCode, details);
    this.name = "GitSafetyError";
  }
}
