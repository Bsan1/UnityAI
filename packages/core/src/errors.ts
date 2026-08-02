export type TaskDomainErrorCode = "INVALID_TRANSITION" | "VALIDATION_ERROR";

export class TaskDomainError extends Error {
  readonly code: TaskDomainErrorCode;

  constructor(code: TaskDomainErrorCode, message: string) {
    super(message);
    this.name = "TaskDomainError";
    this.code = code;
  }
}
