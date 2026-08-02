import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseAgentDefinition } from "@unityai/core";
import type { AgentDefinition } from "@unityai/core";

import { AIExecutionError } from "./aiErrors.js";
import { ServerError } from "./errors.js";

export class AgentRegistry {
  private readonly definitions: ReadonlyMap<string, AgentDefinition>;

  constructor(definitions: readonly AgentDefinition[]) {
    if (new Set(definitions.map((agent) => agent.id)).size !== definitions.length) {
      throw new ServerError("CONFIG_ERROR", "Agent IDs must be unique.", 500);
    }
    this.definitions = new Map(
      definitions.map((definition) => [definition.id, definition]),
    );
  }

  static async load(directory: string): Promise<AgentRegistry> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
      if (files.length === 0) {
        throw new Error("No JSON agent definitions were found.");
      }
      const definitions = await Promise.all(
        files.map(async (file) => {
          const contents = await readFile(join(directory, file), "utf8");
          const value: unknown = JSON.parse(contents);
          return parseAgentDefinition(value);
        }),
      );
      return new AgentRegistry(definitions);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "CONFIG_ERROR",
        `Could not load agent definitions from ${directory}: ${message}`,
        500,
      );
    }
  }

  list(): readonly AgentDefinition[] {
    return [...this.definitions.values()];
  }

  get(id: string): AgentDefinition {
    const definition = this.definitions.get(id);
    if (definition === undefined) {
      throw new AIExecutionError(
        "AGENT_NOT_FOUND",
        `Agent ${id} is not configured.`,
        404,
      );
    }
    return definition;
  }
}
