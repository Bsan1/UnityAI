import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseTaskSettings } from "@unityai/core";
import type { TaskSettings } from "@unityai/core";

import { ServerError } from "./errors.js";

const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

export class SettingsStore {
  private readonly path: string;
  private settings: TaskSettings | undefined;

  constructor(runtimeRoot: string) {
    this.path = join(runtimeRoot, "settings.json");
  }

  async initialize(defaults: TaskSettings): Promise<TaskSettings> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      this.settings = parseTaskSettings(value);
    } catch (error: unknown) {
      if (!isMissing(error)) {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new ServerError(
          "SETTINGS_INVALID",
          `Could not load application settings: ${message}`,
          500,
        );
      }
      this.settings = parseTaskSettings(defaults);
      await this.persist(this.settings);
    }
    return this.settings;
  }

  get(): TaskSettings {
    if (this.settings === undefined) {
      throw new ServerError("SETTINGS_INVALID", "Settings are not initialized.", 500);
    }
    return this.settings;
  }

  async update(value: unknown): Promise<TaskSettings> {
    const current = this.get();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ServerError("VALIDATION_ERROR", "Settings patch must be an object.", 400);
    }
    const input = value as Record<string, unknown>;
    const allowed = new Set(["crossReviewEnabled", "automaticFixesEnabled"]);
    const keys = Object.keys(input);
    if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
      throw new ServerError(
        "VALIDATION_ERROR",
        "Settings patch may contain only Cross Review and Automatic Fixes booleans.",
        400,
      );
    }
    const updated = parseTaskSettings({
      crossReviewEnabled: input.crossReviewEnabled ?? current.crossReviewEnabled,
      automaticFixesEnabled:
        input.automaticFixesEnabled ?? current.automaticFixesEnabled,
    });
    await this.persist(updated);
    this.settings = updated;
    return updated;
  }

  private async persist(settings: TaskSettings): Promise<void> {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporary, this.path);
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "SETTINGS_PERSISTENCE_ERROR",
        `Could not save application settings: ${message}`,
        500,
      );
    }
  }
}
