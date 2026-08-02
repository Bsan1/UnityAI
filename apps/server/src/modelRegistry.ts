import type { ModelConfiguration, ModelDefinition } from "@unityai/core";

import { AIExecutionError } from "./aiErrors.js";

export class ModelRegistry {
  private readonly configuration: ModelConfiguration;
  private readonly models: ReadonlyMap<string, ModelDefinition>;

  constructor(configuration: ModelConfiguration) {
    this.configuration = configuration;
    this.models = new Map(
      configuration.models.map((model) => [model.id, model]),
    );
  }

  getConfiguration(): ModelConfiguration {
    return this.configuration;
  }

  list(): readonly ModelDefinition[] {
    return this.configuration.models;
  }

  get(id: string): ModelDefinition {
    const model = this.models.get(id);
    if (model === undefined) {
      throw new AIExecutionError(
        "MODEL_NOT_CONFIGURED",
        `Model ${id} is not configured.`,
        404,
      );
    }
    return model;
  }
}
