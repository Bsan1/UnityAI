import type { JsonValue, ProviderConfiguration } from "@unityai/core";

import type {
  AIProvider,
  ProviderAvailability,
  ProviderExecutionRequest,
  ProviderExecutionResult,
} from "./aiProvider.js";
import type { ProviderCommand } from "./codexProvider.js";
import type { ProviderLaunch } from "./cliLaunch.js";
import type { ProcessRunner } from "./processRunner.js";
import {
  isJsonValue,
  processFailure,
  providerResult,
  unsupportedEffortResult,
} from "./providerResult.js";

const toolsFor = (request: ProviderExecutionRequest): string =>
  request.agent.permission === "READ_ONLY"
    ? "Read,Glob,Grep"
    : "Read,Glob,Grep,Write,Edit,Bash";

const allowedToolsFor = (request: ProviderExecutionRequest): string =>
  [
    ...(request.agent.permission === "READ_ONLY"
      ? ["Read", "Glob", "Grep"]
      : ["Read", "Glob", "Grep", "Write", "Edit"]),
    ...(request.mcpServers ?? []).flatMap((server) =>
      server.allowedTools.map((tool) => `mcp__${server.id}__${tool}`),
    ),
  ].join(",");

const claudeMcpConfiguration = (
  request: ProviderExecutionRequest,
): string | undefined => {
  if (request.mcpServers === undefined || request.mcpServers.length === 0) {
    return undefined;
  }
  return JSON.stringify({
    mcpServers: Object.fromEntries(request.mcpServers.map((server) => [
      server.id,
      {
        type: "stdio",
        command: server.command,
        args: server.arguments,
        ...(server.environment === undefined ? {} : { env: server.environment }),
      },
    ])),
  });
};

export const buildClaudeCommand = (
  launch: ProviderLaunch,
  request: ProviderExecutionRequest,
): ProviderCommand => {
  const mcpConfiguration = claudeMcpConfiguration(request);
  return ({
  executable: launch.executable,
  arguments: [
    ...launch.argumentPrefix,
    "--print",
    ...(mcpConfiguration === undefined
      ? ["--safe-mode"]
      : [
          "--setting-sources",
          "",
          "--strict-mcp-config",
          "--mcp-config",
          mcpConfiguration,
          "--disable-slash-commands",
          "--no-chrome",
        ]),
    "--no-session-persistence",
    "--output-format",
    "json",
    "--model",
    request.model.providerModelName,
    "--effort",
    request.effort,
    "--permission-mode",
    "dontAsk",
    "--tools",
    toolsFor(request),
    "--allowed-tools",
    allowedToolsFor(request),
    ...(request.expectedOutputSchema === undefined
      ? []
      : ["--json-schema", JSON.stringify(request.expectedOutputSchema)]),
  ],
  input: request.prompt,
  });
};

interface ClaudeEnvelope {
  readonly result?: string;
  readonly structured_output?: JsonValue;
}

const parseEnvelope = (stdout: string): ClaudeEnvelope | undefined => {
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const result = typeof record.result === "string" ? record.result : undefined;
    const structuredOutput = isJsonValue(record.structured_output)
      ? record.structured_output
      : undefined;
    return {
      ...(result === undefined ? {} : { result }),
      ...(structuredOutput === undefined
        ? {}
        : { structured_output: structuredOutput }),
    };
  } catch {
    return undefined;
  }
};

export class ClaudeProvider implements AIProvider {
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
        message: "Claude Code CLI is not available.",
      };
    }
    const version = (versionResult.stdout || versionResult.stderr)
      .trim()
      .slice(0, 200);
    const authenticationResult = await this.runner.run({
      executable: this.launch.executable,
      arguments: [...this.launch.argumentPrefix, "auth", "status", "--json"],
      workingDirectory: process.cwd(),
      timeoutMs: 5_000,
      maximumCaptureBytes: 16_384,
    });
    if (
      authenticationResult.status === "EXITED" &&
      authenticationResult.exitCode === 0
    ) {
      try {
        const value: unknown = JSON.parse(authenticationResult.stdout);
        if (typeof value === "object" && value !== null) {
          const loggedIn = (value as Record<string, unknown>).loggedIn;
          if (loggedIn === true) {
            return {
              providerId: this.id,
              status: "AVAILABLE",
              cliAvailable: true,
              authentication: "AUTHENTICATED",
              ...(version.length === 0 ? {} : { version }),
              message: "Claude Code CLI and local authentication are available.",
            };
          }
          if (loggedIn === false) {
            return {
              providerId: this.id,
              status: "AUTHENTICATION_REQUIRED",
              cliAvailable: true,
              authentication: "UNAUTHENTICATED",
              ...(version.length === 0 ? {} : { version }),
              message: "Claude Code CLI is installed but local authentication is unavailable.",
            };
          }
        }
      } catch {
        // Authentication remains unknown; sensitive status details are discarded.
      }
    }
    return {
      providerId: this.id,
      status: "AUTHENTICATION_UNKNOWN",
      cliAvailable: true,
      authentication: "UNKNOWN",
      ...(version.length === 0 ? {} : { version }),
      message: "Claude Code CLI is installed; authentication could not be confirmed cheaply.",
    };
  }

  async execute(
    request: ProviderExecutionRequest,
  ): Promise<ProviderExecutionResult> {
    if (!request.model.supportedReasoningEfforts.includes(request.effort)) {
      return unsupportedEffortResult(this.id, request);
    }
    const command = buildClaudeCommand(this.launch, request);
    const processResult = await this.runner.run({
      executable: command.executable,
      arguments: command.arguments,
      workingDirectory: request.workingDirectory,
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
    const envelope = parseEnvelope(processResult.stdout);
    if (envelope === undefined) {
      return providerResult(this.id, processResult, {
        failure: {
          code: "INVALID_PROVIDER_OUTPUT",
          message: "Claude completed without a valid JSON result envelope.",
        },
      });
    }
    const finalOutput =
      envelope.result ??
      (envelope.structured_output === undefined
        ? undefined
        : JSON.stringify(envelope.structured_output));
    if (finalOutput === undefined) {
      return providerResult(this.id, processResult, {
        failure: {
          code: "INVALID_PROVIDER_OUTPUT",
          message: "Claude completed without a readable final result.",
        },
      });
    }
    return providerResult(this.id, processResult, {
      finalOutput,
      ...(envelope.structured_output === undefined
        ? {}
        : { structuredOutput: envelope.structured_output }),
    });
  }
}
