import type { JsonValue } from "@unityai/core";

import type {
  ProviderExecutionRequest,
  ProviderExecutionResult,
  ProviderFailure,
} from "./aiProvider.js";
import type { AIErrorCode } from "./aiErrors.js";
import type { ProcessExecutionResult } from "./processRunner.js";

export const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
};

export const processFailure = (
  processResult: ProcessExecutionResult,
): ProviderFailure | undefined => {
  switch (processResult.status) {
    case "SPAWN_FAILED":
      return {
        code: "PROCESS_SPAWN_FAILED",
        message: "The provider CLI process could not be started.",
      };
    case "TIMED_OUT":
      return {
        code: "EXECUTION_TIMEOUT",
        message: "The provider execution exceeded its configured timeout.",
      };
    case "CANCELLED":
      return {
        code: "EXECUTION_CANCELLED",
        message: "The provider execution was cancelled.",
      };
    case "EXITED":
      if (processResult.exitCode !== 0) {
        return {
          code: "PROVIDER_EXIT_FAILURE",
          message: `The provider CLI exited with code ${processResult.exitCode ?? "unknown"}.`,
        };
      }
      return undefined;
  }
};

const statusForFailure = (
  code: AIErrorCode,
): ProviderExecutionResult["status"] => {
  if (code === "EXECUTION_TIMEOUT") {
    return "TIMED_OUT";
  }
  if (code === "EXECUTION_CANCELLED") {
    return "CANCELLED";
  }
  return "FAILED";
};

export const providerResult = (
  providerId: string,
  processResult: ProcessExecutionResult,
  options: {
    readonly finalOutput?: string;
    readonly structuredOutput?: JsonValue;
    readonly failure?: ProviderFailure;
  },
): ProviderExecutionResult => {
  const failure = options.failure ?? processFailure(processResult);
  return {
    providerId,
    status: failure === undefined ? "SUCCEEDED" : statusForFailure(failure.code),
    ...(options.finalOutput === undefined
      ? {}
      : { finalOutput: options.finalOutput }),
    ...(options.structuredOutput === undefined
      ? {}
      : { structuredOutput: options.structuredOutput }),
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    stdoutTruncated: processResult.stdoutTruncated,
    stderrTruncated: processResult.stderrTruncated,
    ...(processResult.exitCode === undefined
      ? {}
      : { exitCode: processResult.exitCode }),
    startedAt: processResult.startedAt,
    finishedAt: processResult.finishedAt,
    durationMs: processResult.durationMs,
    ...(failure === undefined ? {} : { failure }),
  };
};

export const unsupportedEffortResult = (
  providerId: string,
  request: ProviderExecutionRequest,
): ProviderExecutionResult => {
  const now = new Date().toISOString();
  return {
    providerId,
    status: "FAILED",
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    failure: {
      code: "UNSUPPORTED_REASONING_EFFORT",
      message: `Model ${request.model.id} does not support effort ${request.effort}.`,
    },
  };
};
