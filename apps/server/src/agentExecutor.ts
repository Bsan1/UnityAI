import { realpath, stat } from "node:fs/promises";

import { Ajv } from "ajv";
import {
  TaskDomainError,
  parseReasoningEffort,
} from "@unityai/core";
import type {
  AgentDefinition,
  JsonObject,
  JsonValue,
  ReasoningEffort,
} from "@unityai/core";

import type {
  AIExecutionInput,
  AIExecutionResult,
  ProviderExecutionResult,
} from "./aiProvider.js";
import { AIExecutionError } from "./aiErrors.js";
import { AgentRegistry } from "./agentRegistry.js";
import {
  ExecutionArtifactStore,
} from "./executionArtifactStore.js";
import { ModelRegistry } from "./modelRegistry.js";
import { isJsonValue } from "./providerResult.js";
import { ProviderRegistry } from "./providerRegistry.js";

type JsonRecord = Record<string, unknown>;

const readObject = (value: unknown): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AIExecutionError(
      "INVALID_EXECUTION_REQUEST",
      "AI execution request must be an object.",
      400,
    );
  }
  return value as JsonRecord;
};

const readString = (
  record: JsonRecord,
  field: string,
  optional = false,
): string | undefined => {
  const value = record[field];
  if (value === undefined && optional) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AIExecutionError(
      "INVALID_EXECUTION_REQUEST",
      `AI execution request.${field} must be a non-empty string.`,
      400,
    );
  }
  return value;
};

const parseTimeout = (value: unknown, defaultTimeoutMs: number): number => {
  if (value === undefined) {
    return defaultTimeoutMs;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1_000 ||
    value > 3_600_000
  ) {
    throw new AIExecutionError(
      "INVALID_EXECUTION_REQUEST",
      "AI execution request.timeoutMs must be an integer from 1000 to 3600000.",
      400,
    );
  }
  return value;
};

const parseInput = (
  value: unknown,
  defaultTimeoutMs: number,
  signal?: AbortSignal,
): AIExecutionInput => {
  const record = readObject(value);
  let effort: ReasoningEffort;
  try {
    effort = parseReasoningEffort(
      record.effort,
      "AI execution request.effort",
    );
  } catch (error: unknown) {
    if (error instanceof TaskDomainError) {
      throw new AIExecutionError(
        "INVALID_EXECUTION_REQUEST",
        error.message,
        400,
      );
    }
    throw error;
  }
  const agentId = readString(record, "agentId");
  const modelId = readString(record, "modelId");
  const workingDirectory = readString(record, "workingDirectory");
  const input = readString(record, "input");
  const context = readString(record, "context", true);
  if (
    agentId === undefined ||
    modelId === undefined ||
    workingDirectory === undefined ||
    input === undefined
  ) {
    throw new AIExecutionError(
      "INVALID_EXECUTION_REQUEST",
      "AI execution request is incomplete.",
      400,
    );
  }
  return {
    agentId,
    modelId,
    effort,
    workingDirectory,
    input,
    ...(context === undefined ? {} : { context }),
    timeoutMs: parseTimeout(record.timeoutMs, defaultTimeoutMs),
    ...(signal === undefined ? {} : { signal }),
  };
};

const assemblePrompt = (
  agent: AgentDefinition,
  input: string,
  context: string | undefined,
): string =>
  [
    `Agent role: ${agent.role}`,
    "",
    "Agent instructions:",
    agent.instructions,
    "",
    `Permission policy: ${agent.permission}`,
    `Tool policy: ${agent.toolPolicy}`,
    `Repository instructions: ${
      agent.contextPolicy.includeRepositoryInstructions ? "include" : "exclude"
    }`,
    ...(context === undefined ? [] : ["", "Execution context:", context]),
    "",
    "User input:",
    input,
  ].join("\n");

const structuredOutputFrom = (
  providerResult: ProviderExecutionResult,
): JsonValue | undefined => {
  if (providerResult.structuredOutput !== undefined) {
    return providerResult.structuredOutput;
  }
  if (providerResult.finalOutput === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(providerResult.finalOutput);
    return isJsonValue(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const validateStructuredOutput = (
  schema: JsonObject,
  value: JsonValue | undefined,
): string | undefined => {
  if (value === undefined) {
    return "Provider output was not valid JSON.";
  }
  try {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (validate(value)) {
      return undefined;
    }
    return ajv.errorsText(validate.errors, { separator: "; " }).slice(0, 1_000);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid schema";
    return `Expected output schema could not be evaluated: ${message}`;
  }
};

const unexpectedProviderResult = (
  providerId: string,
  startedAt: string,
): ProviderExecutionResult => {
  const finishedAt = new Date().toISOString();
  return {
    providerId,
    status: "FAILED",
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    failure: {
      code: "PROVIDER_EXIT_FAILURE",
      message: "The provider failed before returning a normalized result.",
    },
  };
};

export class AgentExecutor {
  private readonly agents: AgentRegistry;
  private readonly models: ModelRegistry;
  private readonly providers: ProviderRegistry;
  private readonly artifacts: ExecutionArtifactStore;
  private readonly defaultTimeoutMs: number;

  constructor(
    agents: AgentRegistry,
    models: ModelRegistry,
    providers: ProviderRegistry,
    artifacts: ExecutionArtifactStore,
    defaultTimeoutMs: number,
  ) {
    this.agents = agents;
    this.models = models;
    this.providers = providers;
    this.artifacts = artifacts;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async execute(value: unknown, signal?: AbortSignal): Promise<AIExecutionResult> {
    const input = parseInput(value, this.defaultTimeoutMs, signal);
    const agent = this.agents.get(input.agentId);
    const model = this.models.get(input.modelId);
    if (!model.supportedReasoningEfforts.includes(input.effort)) {
      throw new AIExecutionError(
        "UNSUPPORTED_REASONING_EFFORT",
        `Model ${model.id} does not support reasoning effort ${input.effort}.`,
        422,
      );
    }
    if (
      agent.expectedOutputSchema !== undefined &&
      !model.capabilities.structuredOutput
    ) {
      throw new AIExecutionError(
        "INVALID_EXECUTION_REQUEST",
        `Model ${model.id} is not configured for structured output.`,
        422,
      );
    }
    if (
      input.input.length + (input.context?.length ?? 0) >
      agent.contextPolicy.maximumInputCharacters
    ) {
      throw new AIExecutionError(
        "INVALID_EXECUTION_REQUEST",
        `Input exceeds agent ${agent.id}'s context limit.`,
        413,
      );
    }

    let workingDirectory: string;
    try {
      const information = await stat(input.workingDirectory);
      if (!information.isDirectory()) {
        throw new Error("Path is not a directory.");
      }
      workingDirectory = await realpath(input.workingDirectory);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new AIExecutionError(
        "INVALID_WORKING_DIRECTORY",
        `Working directory is not usable: ${message}`,
        422,
      );
    }

    const provider = this.providers.get(model.providerId);
    const availability = await provider.availability();
    if (
      availability.status === "UNAVAILABLE" ||
      availability.status === "AUTHENTICATION_REQUIRED"
    ) {
      throw new AIExecutionError(
        "PROVIDER_UNAVAILABLE",
        availability.message,
        503,
      );
    }

    const startedAt = new Date().toISOString();
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const handle = await this.artifacts.begin({
      agent,
      model,
      effort: input.effort,
      workingDirectory,
      input: input.input,
      ...(input.context === undefined ? {} : { context: input.context }),
      timeoutMs,
      startedAt,
    });
    const prompt = assemblePrompt(agent, input.input, input.context);
    let providerExecution: ProviderExecutionResult;
    try {
      providerExecution = await provider.execute({
        agent,
        model,
        effort: input.effort,
        workingDirectory,
        prompt,
        ...(agent.expectedOutputSchema === undefined
          ? {}
          : { expectedOutputSchema: agent.expectedOutputSchema }),
        timeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch {
      providerExecution = unexpectedProviderResult(provider.id, startedAt);
    }

    let structuredOutput = structuredOutputFrom(providerExecution);
    let status = providerExecution.status;
    let failure = providerExecution.failure;
    if (
      status === "SUCCEEDED" &&
      agent.expectedOutputSchema !== undefined
    ) {
      const validationFailure = validateStructuredOutput(
        agent.expectedOutputSchema,
        structuredOutput,
      );
      if (validationFailure !== undefined) {
        status = "FAILED";
        structuredOutput = undefined;
        failure = {
          code: "STRUCTURED_OUTPUT_VALIDATION_FAILED",
          message: validationFailure,
        };
      }
    }

    const result: AIExecutionResult = {
      runId: handle.runId,
      agentId: agent.id,
      providerId: provider.id,
      modelId: model.id,
      effort: input.effort,
      status,
      ...(providerExecution.finalOutput === undefined
        ? {}
        : { finalOutput: providerExecution.finalOutput }),
      ...(structuredOutput === undefined ? {} : { structuredOutput }),
      startedAt: providerExecution.startedAt,
      finishedAt: providerExecution.finishedAt,
      durationMs: providerExecution.durationMs,
      diagnostics: {
        ...(providerExecution.exitCode === undefined
          ? {}
          : { exitCode: providerExecution.exitCode }),
        stdoutTruncated: providerExecution.stdoutTruncated,
        stderrTruncated: providerExecution.stderrTruncated,
      },
      ...(failure === undefined ? {} : { failure }),
      artifactDirectory: handle.directory,
    };
    await this.artifacts.complete(handle, result, providerExecution);
    return result;
  }
}
