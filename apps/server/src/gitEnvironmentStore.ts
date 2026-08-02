import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseGitTaskEnvironment, parseTaskId } from "@unityai/core";
import type { GitTaskEnvironment, TaskId } from "@unityai/core";

import { ServerError } from "./errors.js";

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

export class GitEnvironmentStore {
  private readonly tasksRoot: string;

  constructor(runtimeRoot: string) {
    this.tasksRoot = join(runtimeRoot, "tasks");
  }

  async initialize(): Promise<void> {
    await mkdir(this.tasksRoot, { recursive: true });
  }

  async get(taskId: TaskId): Promise<GitTaskEnvironment | undefined> {
    const validTaskId = parseTaskId(taskId);
    const path = this.gitFilePath(validTaskId);
    try {
      await access(path);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw this.persistenceError(validTaskId, "access", error);
    }

    try {
      const contents = await readFile(path, "utf8");
      const value: unknown = JSON.parse(contents);
      const environment = parseGitTaskEnvironment(value);
      if (environment.taskId !== validTaskId) {
        throw new Error("Git metadata task ID does not match its directory.");
      }
      return environment;
    } catch (error: unknown) {
      throw this.persistenceError(validTaskId, "read or validate", error);
    }
  }

  async save(environment: GitTaskEnvironment): Promise<GitTaskEnvironment> {
    const validEnvironment = parseGitTaskEnvironment(environment);
    const directory = join(this.tasksRoot, validEnvironment.taskId);
    const destination = this.gitFilePath(validEnvironment.taskId);
    const temporary = join(
      directory,
      `.git.${process.pid}.${randomUUID()}.tmp`,
    );
    await mkdir(directory, { recursive: true });

    try {
      await writeFile(
        temporary,
        `${JSON.stringify(validEnvironment, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(temporary, destination);
      return validEnvironment;
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw this.persistenceError(validEnvironment.taskId, "save", error);
    }
  }

  private gitFilePath(taskId: TaskId): string {
    return join(this.tasksRoot, taskId, "git.json");
  }

  private persistenceError(
    taskId: TaskId,
    operation: string,
    error: unknown,
  ): ServerError {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new ServerError(
      "PERSISTENCE_ERROR",
      `Could not ${operation} Git metadata for ${taskId}: ${message}`,
      500,
    );
  }
}
