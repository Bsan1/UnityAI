import type { AIProvider, ProviderAvailability } from "./aiProvider.js";
import { AIExecutionError } from "./aiErrors.js";

export class ProviderRegistry {
  private readonly providers: ReadonlyMap<string, AIProvider>;

  constructor(providers: readonly AIProvider[]) {
    if (new Set(providers.map((provider) => provider.id)).size !== providers.length) {
      throw new AIExecutionError(
        "PROVIDER_NOT_FOUND",
        "Provider implementations must use unique IDs.",
        500,
      );
    }
    this.providers = new Map(
      providers.map((provider) => [provider.id, provider]),
    );
  }

  get(id: string): AIProvider {
    const provider = this.providers.get(id);
    if (provider === undefined) {
      throw new AIExecutionError(
        "PROVIDER_NOT_FOUND",
        `Provider ${id} is not registered.`,
        404,
      );
    }
    return provider;
  }

  async availability(): Promise<readonly ProviderAvailability[]> {
    return Promise.all(
      [...this.providers.values()].map((provider) => provider.availability()),
    );
  }
}
