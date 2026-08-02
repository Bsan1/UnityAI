import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue, ProviderConfiguration } from "@unityai/core";

import type {
  AIProvider,
  ProviderAvailability,
  ProviderExecutionRequest,
  ProviderExecutionResult,
} from "./aiProvider.js";
import type { ProviderLaunch } from "./cliLaunch.js";
import type { ProcessRunner } from "./processRunner.js";
import {
  isJsonValue,
  processFailure,
  providerResult,
  unsupportedEffortResult,
} from "./providerResult.js";

export interface CodexCommandFiles {
  readonly finalOutputPath: string;
  readonly schemaPath?: string;
}

export interface ProviderCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly input: string;
}

const sandboxFor = (
  request: ProviderExecutionRequest,
): "read-only" | "workspace-write" =>
  request.agent.permission === "READ_ONLY" ? "read-only" : "workspace-write";

// UnityAI launches an independent Codex CLI execution. Desktop-host control
// variables describe the parent Codex task and can otherwise override the
// explicitly selected sandbox/permission context in the child process.
export const codexChildEnvironment = {
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
  CODEX_PERMISSION_PROFILE: undefined,
  CODEX_THREAD_ID: undefined,
} as const;

export const buildCodexCommand = (
  launch: ProviderLaunch,
  request: ProviderExecutionRequest,
  files: CodexCommandFiles,
  windowsSandbox?: "elevated" | "unelevated",
): ProviderCommand => ({
  executable: launch.executable,
  arguments: [
    ...launch.argumentPrefix,
    "exec",
    "--ephemeral",
    "--json",
    "--color",
    "never",
    "--ignore-user-config",
    ...(process.platform === "win32" && windowsSandbox !== undefined
      ? ["-c", `windows.sandbox="${windowsSandbox}"`]
      : []),
    "--model",
    request.model.providerModelName,
    "-c",
    `model_reasoning_effort="${request.effort}"`,
    "-c",
    'approval_policy="never"',
    "--sandbox",
    sandboxFor(request),
    "--cd",
    request.workingDirectory,
    "--output-last-message",
    files.finalOutputPath,
    ...(files.schemaPath === undefined
      ? []
      : ["--output-schema", files.schemaPath]),
    "-",
  ],
  input: request.prompt,
});

const finalMessageFromJsonLines = (stdout: string): string | undefined => {
  let finalMessage: string | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null) {
        continue;
      }
      const event = value as Record<string, unknown>;
      if (event.type !== "item.completed") {
        continue;
      }
      const item = event.item;
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const record = item as Record<string, unknown>;
      if (record.type === "agent_message" && typeof record.text === "string") {
        finalMessage = record.text;
      }
    } catch {
      // A malformed diagnostic line is ignored when the final-message file exists.
    }
  }
  return finalMessage;
};

const parseStructuredOutput = (output: string): JsonValue | undefined => {
  try {
    const value: unknown = JSON.parse(output);
    return isJsonValue(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

export class CodexProvider implements AIProvider {
  readonly id: string;
  private readonly configuration: ProviderConfiguration;
  private readonly launch: ProviderLaunch;
  private readonly runner: ProcessRunner;

  constructor(
    configuration: ProviderConfiguration,
    launch: ProviderLaunch,
    runner: ProcessRunner,
  ) {
    this.id = configuration.id;
    this.configuration = configuration;
    this.launch = launch;
    this.runner = runner;
  }

  async availability(): Promise<ProviderAvailability> {
    if (!this.configuration.enabled) {
      return {
        providerId: this.id,
        status: "UNAVAILABLE",
        cliAvailable: false,
        authentication: "UNKNOWN",
        message: "Provider is disabled in configuration.",
      };
    }
    const versionResult = await this.runner.run({
      executable: this.launch.executable,
      arguments: [...this.launch.argumentPrefix, "--version"],
      workingDirectory: process.cwd(),
      timeoutMs: 5_000,
      maximumCaptureBytes: 16_384,
    });
    if (processFailure(versionResult) !== undefined) {
      return {
        providerId: this.id,
        status: "UNAVAILABLE",
        cliAvailable: false,
        authentication: "UNKNOWN",
        message: "Codex CLI is not available.",
      };
    }

    const version = (versionResult.stdout || versionResult.stderr)
      .trim()
      .slice(0, 200);
    const authenticationResult = await this.runner.run({
      executable: this.launch.executable,
      arguments: [...this.launch.argumentPrefix, "login", "status"],
      workingDirectory: process.cwd(),
      timeoutMs: 5_000,
      maximumCaptureBytes: 16_384,
    });
    if (
      authenticationResult.status === "EXITED" &&
      authenticationResult.exitCode === 0
    ) {
      return {
        providerId: this.id,
        status: "AVAILABLE",
        cliAvailable: true,
        authentication: "AUTHENTICATED",
        ...(version.length === 0 ? {} : { version }),
        message: "Codex CLI and local authentication are available.",
      };
    }
    if (
      authenticationResult.status === "EXITED" &&
      authenticationResult.exitCode !== 0
    ) {
      return {
        providerId: this.id,
        status: "AUTHENTICATION_REQUIRED",
        cliAvailable: true,
        authentication: "UNAUTHENTICATED",
        ...(version.length === 0 ? {} : { version }),
        message: "Codex CLI is installed but local authentication is unavailable.",
      };
    }
    return {
      providerId: this.id,
      status: "AUTHENTICATION_UNKNOWN",
      cliAvailable: true,
      authentication: "UNKNOWN",
      ...(version.length === 0 ? {} : { version }),
      message: "Codex CLI is installed; authentication could not be confirmed cheaply.",
    };
  }

  async execute(
    request: ProviderExecutionRequest,
  ): Promise<ProviderExecutionResult> {
    if (!request.model.supportedReasoningEfforts.includes(request.effort)) {
      return unsupportedEffortResult(this.id, request);
    }

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "unityai-codex-"));
    const finalOutputPath = join(temporaryDirectory, "final.txt");
    const schemaPath =
      request.expectedOutputSchema === undefined
        ? undefined
        : join(temporaryDirectory, "schema.json");
    try {
      if (
        schemaPath !== undefined &&
        request.expectedOutputSchema !== undefined
      ) {
        await writeFile(
          schemaPath,
          `${JSON.stringify(request.expectedOutputSchema, null, 2)}\n`,
          "utf8",
        );
      }
      const command = buildCodexCommand(this.launch, request, {
        finalOutputPath,
        ...(schemaPath === undefined ? {} : { schemaPath }),
      }, this.configuration.windowsSandbox);
      const processResult = await this.runner.run({
        executable: command.executable,
        arguments: command.arguments,
        workingDirectory: request.workingDirectory,
        environment: codexChildEnvironment,
        input: command.input,
        timeoutMs: request.timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const processResultFailure = processFailure(processResult);
      if (processResultFailure !== undefined) {
        return providerResult(this.id, processResult, {
          failure: processResultFailure,
        });
      }

      const fileOutput = await readFile(finalOutputPath, "utf8").catch(
        () => undefined,
      );
      const finalOutput =
        fileOutput?.trim() || finalMessageFromJsonLines(processResult.stdout);
      if (finalOutput === undefined || finalOutput.length === 0) {
        return providerResult(this.id, processResult, {
          failure: {
            code: "INVALID_PROVIDER_OUTPUT",
            message: "Codex completed without a readable final agent message.",
          },
        });
      }
      const structuredOutput =
        request.expectedOutputSchema === undefined
          ? undefined
          : parseStructuredOutput(finalOutput);
      return providerResult(this.id, processResult, {
        finalOutput,
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}
