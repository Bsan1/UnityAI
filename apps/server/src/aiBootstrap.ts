import type {
  AIProviderConfiguration,
  ProviderConfiguration,
} from "@unityai/core";

import { AgentExecutor } from "./agentExecutor.js";
import { AgentRegistry } from "./agentRegistry.js";
import {
  loadAIProviderConfiguration,
  loadModelConfiguration,
} from "./aiConfig.js";
import { AIService } from "./aiService.js";
import { ClaudeProvider } from "./claudeProvider.js";
import {
  resolveClaudeLaunch,
  resolveCodexLaunch,
} from "./cliLaunch.js";
import { CodexProvider } from "./codexProvider.js";
import { ServerError } from "./errors.js";
import { ExecutionArtifactStore } from "./executionArtifactStore.js";
import { ModelRegistry } from "./modelRegistry.js";
import { SafeProcessRunner } from "./processRunner.js";
import { ProviderRegistry } from "./providerRegistry.js";

export interface AIBootstrapPaths {
  readonly agentsDirectory: string;
  readonly modelsPath: string;
  readonly providersPath: string;
  readonly runtimeRoot: string;
}

const requireProviderConfiguration = (
  configuration: AIProviderConfiguration,
  id: string,
): ProviderConfiguration => {
  const provider = configuration.providers.find(
    (candidate) => candidate.id === id,
  );
  if (provider === undefined) {
    throw new ServerError(
      "CONFIG_ERROR",
      `Provider configuration must define ${id}.`,
      500,
    );
  }
  return provider;
};

export const bootstrapAIService = async (
  paths: AIBootstrapPaths,
): Promise<AIService> => {
  const [agents, modelConfiguration, providerConfiguration] = await Promise.all([
    AgentRegistry.load(paths.agentsDirectory),
    loadModelConfiguration(paths.modelsPath),
    loadAIProviderConfiguration(paths.providersPath),
  ]);
  const configuredProviderIds = new Set(
    providerConfiguration.providers.map((provider) => provider.id),
  );
  for (const provider of providerConfiguration.providers) {
    if (provider.id !== "codex" && provider.id !== "claude") {
      throw new ServerError(
        "CONFIG_ERROR",
        `Provider ${provider.id} is configured but has no M3 implementation.`,
        500,
      );
    }
  }
  for (const model of modelConfiguration.models) {
    if (!configuredProviderIds.has(model.providerId)) {
      throw new ServerError(
        "CONFIG_ERROR",
        `Model ${model.id} references unconfigured provider ${model.providerId}.`,
        500,
      );
    }
  }

  const runner = new SafeProcessRunner();
  const codexConfiguration = requireProviderConfiguration(
    providerConfiguration,
    "codex",
  );
  const claudeConfiguration = requireProviderConfiguration(
    providerConfiguration,
    "claude",
  );
  const providers = new ProviderRegistry([
    new CodexProvider(
      codexConfiguration,
      await resolveCodexLaunch(codexConfiguration.executable),
      runner,
    ),
    new ClaudeProvider(
      claudeConfiguration,
      await resolveClaudeLaunch(claudeConfiguration.executable),
      runner,
    ),
  ]);
  const models = new ModelRegistry(modelConfiguration);
  const artifacts = new ExecutionArtifactStore(
    paths.runtimeRoot,
    providerConfiguration.maximumPersistedLogBytes,
  );
  await artifacts.initialize();
  const executor = new AgentExecutor(
    agents,
    models,
    providers,
    artifacts,
    providerConfiguration.defaultTimeoutMs,
  );
  return new AIService(agents, models, providers, executor);
};
