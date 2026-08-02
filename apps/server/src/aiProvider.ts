import type {
  AgentDefinition,
  JsonObject,
  JsonValue,
  ModelDefinition,
  ReasoningEffort,
} from "@unityai/core";

import type { AIErrorCode } from "./aiErrors.js";

export type ProviderAvailabilityStatus =
  | "AVAILABLE"
  | "AUTHENTICATION_REQUIRED"
  | "AUTHENTICATION_UNKNOWN"
  | "UNAVAILABLE";

export type ProviderAuthenticationStatus =
  | "AUTHENTICATED"
  | "UNAUTHENTICATED"
  | "UNKNOWN";

export interface ProviderAvailability {
  readonly providerId: string;
  readonly status: ProviderAvailabilityStatus;
  readonly cliAvailable: boolean;
  readonly authentication: ProviderAuthenticationStatus;
  readonly version?: string;
  readonly message: string;
}

export interface ProviderExecutionRequest {
  readonly agent: AgentDefinition;
  readonly model: ModelDefinition;
  readonly effort: ReasoningEffort;
  readonly workingDirectory: string;
  readonly prompt: string;
  readonly expectedOutputSchema?: JsonObject;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type ProviderExecutionStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED";

export interface ProviderFailure {
  readonly code: AIErrorCode;
  readonly message: string;
}

export interface ProviderExecutionResult {
  readonly providerId: string;
  readonly status: ProviderExecutionStatus;
  readonly finalOutput?: string;
  readonly structuredOutput?: JsonValue;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly exitCode?: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly failure?: ProviderFailure;
}

export interface AIProvider {
  readonly id: string;
  availability(): Promise<ProviderAvailability>;
  execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult>;
}

export interface AIExecutionInput {
  readonly agentId: string;
  readonly modelId: string;
  readonly effort: ReasoningEffort;
  readonly workingDirectory: string;
  readonly input: string;
  readonly context?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AIExecutionDiagnostics {
  readonly exitCode?: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface AIExecutionResult {
  readonly runId: string;
  readonly agentId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort: ReasoningEffort;
  readonly status: ProviderExecutionStatus;
  readonly finalOutput?: string;
  readonly structuredOutput?: JsonValue;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly diagnostics: AIExecutionDiagnostics;
  readonly failure?: ProviderFailure;
  readonly artifactDirectory: string;
}
