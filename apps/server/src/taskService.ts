import {
  TaskDomainError,
  approveTaskContract,
  beginTaskAnalysis,
  cancelTask,
  createPrerequisiteDraft,
  createTask,
  editTaskDraft,
  parseCreateTaskInput,
  parseDraftTaskPatch,
  parseFeasibilityResult,
  parseTaskContractInput,
  parseTaskId,
  pauseTask,
  recheckTask,
  recordFeasibilityResult,
  resumeTask,
  storeTaskContract,
  submitTaskDraft,
} from "@unityai/core";
import type {
  PrerequisiteDraftResult,
  Task,
  TaskId,
  TaskSettings,
} from "@unityai/core";

import { ServerError } from "./errors.js";
import { TaskStore } from "./taskStore.js";

type TaskAction = (task: Task) => Task;

const readObject = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskDomainError("VALIDATION_ERROR", `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const readOptionalReason = (value: unknown): string | undefined => {
  const record = readObject(value, "action body");
  if (record.reason === undefined) {
    return undefined;
  }
  if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
    throw new TaskDomainError(
      "VALIDATION_ERROR",
      "action body.reason must be a non-empty string.",
    );
  }
  return record.reason;
};

const readSuggestedRequest = (value: unknown): string | undefined => {
  const record = readObject(value, "prerequisite draft body");
  if (record.suggestedRequest === undefined) {
    return undefined;
  }
  if (
    typeof record.suggestedRequest !== "string" ||
    record.suggestedRequest.trim().length === 0
  ) {
    throw new TaskDomainError(
      "VALIDATION_ERROR",
      "prerequisite draft body.suggestedRequest must be a non-empty string.",
    );
  }
  return record.suggestedRequest;
};

export class TaskService {
  private readonly store: TaskStore;
  private settings: TaskSettings;

  constructor(store: TaskStore, settings: TaskSettings) {
    this.store = store;
    this.settings = settings;
  }

  getSettings(): TaskSettings {
    return this.settings;
  }

  setSettings(settings: TaskSettings): void {
    this.settings = settings;
  }

  async create(value: unknown): Promise<Task> {
    const input = parseCreateTaskInput(value);
    const task = createTask(this.store.allocateTaskId(), input, this.settings);
    return this.store.save(task);
  }

  async list(): Promise<readonly Task[]> {
    return this.store.list();
  }

  async get(id: string): Promise<Task> {
    return this.requireTask(parseTaskId(id));
  }

  async saveTask(task: Task): Promise<Task> {
    return this.store.save(task);
  }

  async editDraft(id: string, value: unknown): Promise<Task> {
    const patch = parseDraftTaskPatch(value);
    return this.update(id, (task) => editTaskDraft(task, patch));
  }

  async submitDraft(id: string): Promise<Task> {
    return this.update(id, (task) => submitTaskDraft(task));
  }

  async analyze(id: string): Promise<Task> {
    return this.update(id, (task) => beginTaskAnalysis(task));
  }

  async storeFeasibility(id: string, value: unknown): Promise<Task> {
    const result = parseFeasibilityResult(value);
    return this.update(id, (task) => recordFeasibilityResult(task, result));
  }

  async storeContract(id: string, value: unknown): Promise<Task> {
    const contract = parseTaskContractInput(value);
    return this.update(id, (task) => storeTaskContract(task, contract));
  }

  async approve(id: string): Promise<Task> {
    return this.update(id, (task) => approveTaskContract(task));
  }

  async pause(id: string, value: unknown): Promise<Task> {
    const reason = readOptionalReason(value);
    return this.update(id, (task) => pauseTask(task, reason));
  }

  async resume(id: string): Promise<Task> {
    return this.update(id, (task) => resumeTask(task));
  }

  async recheck(id: string): Promise<Task> {
    return this.update(id, (task) => recheckTask(task));
  }

  async cancel(id: string, value: unknown): Promise<Task> {
    const reason = readOptionalReason(value);
    return this.update(id, (task) => cancelTask(task, reason));
  }

  async createPrerequisiteDraft(
    id: string,
    value: unknown,
  ): Promise<PrerequisiteDraftResult> {
    const parent = await this.get(id);
    const suppliedRequest = readSuggestedRequest(value);
    const suggestedRequest =
      suppliedRequest ?? parent.feasibility?.suggestedPrerequisite;
    if (suggestedRequest === undefined) {
      throw new TaskDomainError(
        "VALIDATION_ERROR",
        "A suggested prerequisite request is required.",
      );
    }

    const result = createPrerequisiteDraft(
      parent,
      this.store.allocateTaskId(),
      suggestedRequest,
    );
    await this.store.save(result.prerequisiteDraft);
    await this.store.save(result.parentTask);
    return result;
  }

  private async update(id: string, action: TaskAction): Promise<Task> {
    const task = await this.get(id);
    return this.store.save(action(task));
  }

  private async requireTask(id: TaskId): Promise<Task> {
    const task = await this.store.get(id);
    if (task === undefined) {
      throw new ServerError(
        "TASK_NOT_FOUND",
        `Task ${id} was not found.`,
        404,
      );
    }
    return task;
  }
}
