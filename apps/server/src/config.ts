import { readFile } from "node:fs/promises";

import { parseTaskSettings } from "@unityai/core";
import type { TaskSettings } from "@unityai/core";

import { ServerError } from "./errors.js";

export const loadTaskSettings = async (path: string): Promise<TaskSettings> => {
  try {
    const contents = await readFile(path, "utf8");
    const value: unknown = JSON.parse(contents);
    return parseTaskSettings(value);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new ServerError(
      "CONFIG_ERROR",
      `Could not load task defaults from ${path}: ${message}`,
      500,
    );
  }
};
