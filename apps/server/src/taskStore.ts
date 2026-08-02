import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { formatTaskId, parseTask, parseTaskId } from "@unityai/core";
import type { Task, TaskId } from "@unityai/core";

import { ServerError } from "./errors.js";

const taskDirectoryPattern = /^TASK-\d{4,}$/;

const sequenceFromTaskId = (id: TaskId): number => Number(id.slice(5));

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

export class TaskStore {
  readonly tasksRoot: string;
  private initialized = false;
  private nextSequence = 1;

  constructor(runtimeRoot: string) {
    this.tasksRoot = join(runtimeRoot, "tasks");
  }

  async initialize(): Promise<void> {
    await mkdir(this.tasksRoot, { recursive: true });
    const tasks = await this.readAllTasks();
    const maximumSequence = tasks.reduce(
      (maximum, task) => Math.max(maximum, sequenceFromTaskId(task.id)),
      0,
    );
    this.nextSequence = maximumSequence + 1;
    this.initialized = true;
  }

  allocateTaskId(): TaskId {
    this.assertInitialized();
    const id = formatTaskId(this.nextSequence);
    this.nextSequence += 1;
    return id;
  }

  async list(): Promise<readonly Task[]> {
    this.assertInitialized();
    return this.readAllTasks();
  }

  async get(id: TaskId): Promise<Task | undefined> {
    this.assertInitialized();
    const validId = parseTaskId(id);
    const path = this.taskFilePath(validId);

    try {
      await access(path);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "PERSISTENCE_ERROR",
        `Could not access persisted task ${validId}: ${message}`,
        500,
      );
    }

    return this.readTaskFile(path, validId);
  }

  async save(task: Task): Promise<Task> {
    this.assertInitialized();
    const validTask = parseTask(task);
    const taskDirectory = join(this.tasksRoot, validTask.id);
    const destination = this.taskFilePath(validTask.id);
    const temporary = join(
      taskDirectory,
      `.task.${process.pid}.${randomUUID()}.tmp`,
    );

    await mkdir(taskDirectory, { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(validTask, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporary, destination);
      return validTask;
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "PERSISTENCE_ERROR",
        `Could not save task ${validTask.id}: ${message}`,
        500,
      );
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new ServerError(
        "PERSISTENCE_ERROR",
        "Task store must be initialized before use.",
        500,
      );
    }
  }

  private taskFilePath(id: TaskId): string {
    return join(this.tasksRoot, id, "task.json");
  }

  private async readAllTasks(): Promise<readonly Task[]> {
    let entries;
    try {
      entries = await readdir(this.tasksRoot, { withFileTypes: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "PERSISTENCE_ERROR",
        `Could not list tasks in ${this.tasksRoot}: ${message}`,
        500,
      );
    }

    const taskDirectories = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("TASK-"))
      .map((entry) => entry.name);

    for (const directory of taskDirectories) {
      if (!taskDirectoryPattern.test(directory)) {
        throw new ServerError(
          "PERSISTENCE_ERROR",
          `Invalid task directory name: ${directory}.`,
          500,
        );
      }
    }

    const tasks = await Promise.all(
      taskDirectories.map(async (directory) => {
        const id = parseTaskId(directory);
        return this.readTaskFile(this.taskFilePath(id), id);
      }),
    );

    return tasks.sort(
      (left, right) =>
        sequenceFromTaskId(left.id) - sequenceFromTaskId(right.id),
    );
  }

  private async readTaskFile(path: string, expectedId: TaskId): Promise<Task> {
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "PERSISTENCE_ERROR",
        `Could not read persisted task ${expectedId}: ${message}`,
        500,
      );
    }

    try {
      const value: unknown = JSON.parse(contents);
      const task = parseTask(value);
      if (task.id !== expectedId) {
        throw new Error(
          `Task file identity ${task.id} does not match directory ${expectedId}.`,
        );
      }
      return task;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "PERSISTENCE_ERROR",
        `Persisted task ${expectedId} is invalid: ${message}`,
        500,
      );
    }
  }
}
