import { readFile } from "node:fs/promises";

import {
  parseAIProviderConfiguration,
  parseModelConfiguration,
} from "@unityai/core";
import type {
  AIProviderConfiguration,
  ModelConfiguration,
} from "@unityai/core";

import { ServerError } from "./errors.js";

const loadJson = async (path: string, name: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ServerError(
      "CONFIG_ERROR",
      `Could not load ${name} from ${path}: ${message}`,
      500,
    );
  }
};

export const loadAIProviderConfiguration = async (
  path: string,
): Promise<AIProviderConfiguration> => {
  try {
    return parseAIProviderConfiguration(
      await loadJson(path, "provider configuration"),
    );
  } catch (error: unknown) {
    if (error instanceof ServerError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ServerError(
      "CONFIG_ERROR",
      `Provider configuration ${path} is invalid: ${message}`,
      500,
    );
  }
};

export const loadModelConfiguration = async (
  path: string,
): Promise<ModelConfiguration> => {
  try {
    return parseModelConfiguration(await loadJson(path, "model configuration"));
  } catch (error: unknown) {
    if (error instanceof ServerError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ServerError(
      "CONFIG_ERROR",
      `Model configuration ${path} is invalid: ${message}`,
      500,
    );
  }
};
