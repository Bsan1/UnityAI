import { ServerError } from "./errors.js";

export type AIErrorCode =
  | "AGENT_NOT_FOUND"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_UNAVAILABLE"
  | "MODEL_NOT_CONFIGURED"
  | "UNSUPPORTED_REASONING_EFFORT"
  | "INVALID_WORKING_DIRECTORY"
  | "INVALID_EXECUTION_REQUEST"
  | "PROCESS_SPAWN_FAILED"
  | "EXECUTION_TIMEOUT"
  | "EXECUTION_CANCELLED"
  | "PROVIDER_EXIT_FAILURE"
  | "INVALID_PROVIDER_OUTPUT"
  | "STRUCTURED_OUTPUT_VALIDATION_FAILED"
  | "EXECUTION_ARTIFACT_FAILURE";

export class AIExecutionError extends ServerError {
  declare readonly code: AIErrorCode;

  constructor(
    code: AIErrorCode,
    message: string,
    statusCode = 422,
    details?: unknown,
  ) {
    super(code, message, statusCode, details);
    this.name = "AIExecutionError";
  }
}
