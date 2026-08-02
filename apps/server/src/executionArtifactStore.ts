import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentDefinition,
  ModelDefinition,
  ReasoningEffort,
} from "@unityai/core";

import type {
  AIExecutionResult,
  ProviderExecutionResult,
} from "./aiProvider.js";
import { AIExecutionError } from "./aiErrors.js";

export interface ExecutionArtifactHandle {
  readonly runId: string;
  readonly directory: string;
}

export interface ExecutionArtifactRequest {
  readonly agent: AgentDefinition;
  readonly model: ModelDefinition;
  readonly effort: ReasoningEffort;
  readonly workingDirectory: string;
  readonly input: string;
  readonly context?: string;
  readonly timeoutMs: number;
  readonly startedAt: string;
}

const sensitiveKeyPattern =
  /(?:api[-_]?key|access[-_]?token|auth(?:orization)?|password|secret)/iu;
const secretTextPatterns = [
  /\b(?:sk|sk-ant)-[A-Za-z0-9_-]{4,}\b/gu,
  /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN)\s*[=:]\s*[^\s"']+/giu,
  /\bAuthorization\s*:\s*Bearer\s+[^\s"']+/giu,
] as const;

export const redactSensitiveText = (value: string): string => {
  let redacted = value;
  for (const pattern of secretTextPatterns) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
};

const sanitizeValue = (value: unknown, key?: string): unknown => {
  if (key !== undefined && sensitiveKeyPattern.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeValue(childValue, childKey),
      ]),
    );
  }
  return value;
};

export const boundLog = (value: string, maximumBytes: number): string => {
  const redacted = Buffer.from(redactSensitiveText(value), "utf8");
  if (redacted.length <= maximumBytes) {
    return redacted.toString("utf8");
  }
  const marker = Buffer.from("[truncated: retained tail]\n", "utf8");
  const tailLength = Math.max(0, maximumBytes - marker.length);
  return Buffer.concat([
    marker,
    redacted.subarray(redacted.length - tailLength),
  ]).toString("utf8");
};

const digestInput = (input: string, context: string | undefined): string =>
  createHash("sha256")
    .update(input)
    .update("\0")
    .update(context ?? "")
    .digest("hex");

export class ExecutionArtifactStore {
  private readonly runsRoot: string;
  private readonly maximumLogBytes: number;

  constructor(runtimeRoot: string, maximumLogBytes: number) {
    this.runsRoot = join(runtimeRoot, "ai", "runs");
    this.maximumLogBytes = maximumLogBytes;
  }

  async initialize(): Promise<void> {
    await mkdir(this.runsRoot, { recursive: true });
  }

  async begin(request: ExecutionArtifactRequest): Promise<ExecutionArtifactHandle> {
    let handle: ExecutionArtifactHandle | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const runId = `RUN-${randomUUID().toUpperCase()}`;
      const directory = join(this.runsRoot, runId);
      try {
        await mkdir(directory);
        handle = { runId, directory };
        break;
      } catch (error: unknown) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error as NodeJS.ErrnoException).code !== "EEXIST"
        ) {
          throw this.artifactError("create execution directory", error);
        }
      }
    }
    if (handle === undefined) {
      throw new AIExecutionError(
        "EXECUTION_ARTIFACT_FAILURE",
        "Could not allocate a unique AI run ID.",
        500,
      );
    }

    const requestRecord = {
      schemaVersion: 1,
      runId: handle.runId,
      agentId: request.agent.id,
      providerId: request.model.providerId,
      modelId: request.model.id,
      providerModelName: request.model.providerModelName,
      effort: request.effort,
      permission: request.agent.permission,
      toolPolicy: request.agent.toolPolicy,
      workingDirectory: request.workingDirectory,
      timeoutMs: request.timeoutMs,
      startedAt: request.startedAt,
      inputCharacters: request.input.length,
      contextCharacters: request.context?.length ?? 0,
      inputDigest: digestInput(request.input, request.context),
    };
    await this.writeJson(handle.directory, "request.json", requestRecord);
    return handle;
  }

  async complete(
    handle: ExecutionArtifactHandle,
    result: AIExecutionResult,
    providerResult: ProviderExecutionResult,
  ): Promise<void> {
    try {
      await Promise.all([
        this.writeJson(handle.directory, "result.json", sanitizeValue(result)),
        this.writeText(
          handle.directory,
          "stdout.log",
          boundLog(providerResult.stdout, this.maximumLogBytes),
        ),
        this.writeText(
          handle.directory,
          "stderr.log",
          boundLog(providerResult.stderr, this.maximumLogBytes),
        ),
      ]);
    } catch (error: unknown) {
      if (error instanceof AIExecutionError) {
        throw error;
      }
      throw this.artifactError("complete execution artifacts", error);
    }
  }

  private async writeJson(
    directory: string,
    name: string,
    value: unknown,
  ): Promise<void> {
    await this.writeText(directory, name, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async writeText(
    directory: string,
    name: string,
    value: string,
  ): Promise<void> {
    const destination = join(directory, name);
    const temporary = join(
      directory,
      `.${name}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, value, { encoding: "utf8", flag: "wx" });
      await rename(temporary, destination);
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw this.artifactError(`write ${name}`, error);
    }
  }

  private artifactError(operation: string, error: unknown): AIExecutionError {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new AIExecutionError(
      "EXECUTION_ARTIFACT_FAILURE",
      `Could not ${operation}: ${message}`,
      500,
    );
  }
}
