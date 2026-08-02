import type {
  AgentDefinition,
  ModelPlan,
  ModelConfiguration,
  ReasoningEffort,
} from "@unityai/core";

import type {
  AIExecutionResult,
  ProviderAvailability,
} from "./aiProvider.js";
import { AgentExecutor } from "./agentExecutor.js";
import { AgentRegistry } from "./agentRegistry.js";
import { ModelRegistry } from "./modelRegistry.js";
import { ProviderRegistry } from "./providerRegistry.js";

export class AIService {
  private readonly agents: AgentRegistry;
  private readonly models: ModelRegistry;
  private readonly providers: ProviderRegistry;
  private readonly executor: AgentExecutor;

  constructor(
    agents: AgentRegistry,
    models: ModelRegistry,
    providers: ProviderRegistry,
    executor: AgentExecutor,
  ) {
    this.agents = agents;
    this.models = models;
    this.providers = providers;
    this.executor = executor;
  }

  listAgents(): readonly AgentDefinition[] {
    return this.agents.list();
  }

  getModelConfiguration(): ModelConfiguration {
    return this.models.getConfiguration();
  }

  providerAvailability(): Promise<readonly ProviderAvailability[]> {
    return this.providers.availability();
  }

  execute(value: unknown, signal?: AbortSignal): Promise<AIExecutionResult> {
    return this.executor.execute(value, signal);
  }

  executePlanned(
    value: unknown,
    plan: ModelPlan & { readonly effort: ReasoningEffort },
    signal?: AbortSignal,
  ): Promise<AIExecutionResult> {
    return this.executor.executePlanned(value, plan, signal);
  }
}
