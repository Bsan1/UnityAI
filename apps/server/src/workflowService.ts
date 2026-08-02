import type { Task, TaskEvent } from "@unityai/core";

import type { AnalysisArtifactStore } from "./analysisArtifactStore.js";
import { ServerError } from "./errors.js";
import type { GitSafetyService } from "./gitSafetyService.js";
import type { ImplementationOrchestrator } from "./implementationOrchestrator.js";
import type { OrchestrationArtifactStore } from "./orchestrationArtifactStore.js";
import type { ProjectRecord, ProjectRegistry } from "./projectRegistry.js";
import type { SettingsStore } from "./settingsStore.js";
import type { TaskService } from "./taskService.js";

export type ProgressStepStatus = "COMPLETE" | "CURRENT" | "PENDING" | "SKIPPED" | "FAILED";

export interface ProgressStep {
  readonly id: string;
  readonly label: string;
  readonly status: ProgressStepStatus;
}

const asObject = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServerError("VALIDATION_ERROR", `${name} must be an object.`, 400);
  }
  return value as Record<string, unknown>;
};

const step = (id: string, label: string, status: ProgressStepStatus): ProgressStep => ({
  id,
  label,
  status,
});

const hasEvent = (events: readonly TaskEvent[], type: TaskEvent["type"]): boolean =>
  events.some((entry) => entry.type === type);

const progressSteps = (task: Task): readonly ProgressStep[] => {
  const failed = task.state === "FAILED";
  const implementationComplete = hasEvent(task.events, "IMPLEMENTATION_COMPLETED");
  const reviewComplete = hasEvent(task.events, "REVIEW_COMPLETED");
  const gitPrepared = hasEvent(task.events, "GIT_ENVIRONMENT_PREPARED");
  const interpretationComplete = task.analysis !== undefined || hasEvent(task.events, "ANALYSIS_COMPLETED");
  const feasibilityComplete = task.feasibility !== undefined;
  const contractApproved = task.taskContract?.approved === true;
  const implementationStatus: ProgressStepStatus = implementationComplete
    ? "COMPLETE"
    : task.state === "IMPLEMENTING"
      ? "CURRENT"
      : failed && task.executionFailure?.phase !== "REVIEW"
        ? "FAILED"
        : "PENDING";
  const reviewStatus: ProgressStepStatus = !task.crossReviewEnabled
    ? "SKIPPED"
    : reviewComplete
      ? "COMPLETE"
      : task.state === "REVIEWING"
        ? "CURRENT"
        : failed && task.executionFailure?.phase === "REVIEW"
          ? "FAILED"
          : "PENDING";
  return [
    step("created", "Task Created", "COMPLETE"),
    step(
      "interpretation",
      "Interpretation",
      interpretationComplete ? "COMPLETE" : task.state === "ANALYZING" ? "CURRENT" : "PENDING",
    ),
    step(
      "feasibility",
      "Feasibility",
      feasibilityComplete ? "COMPLETE" : task.state === "ANALYZING" ? "CURRENT" : "PENDING",
    ),
    step(
      "contract",
      "Contract Approved",
      contractApproved
        ? "COMPLETE"
        : task.state === "WAITING_FOR_APPROVAL"
          ? "CURRENT"
          : "PENDING",
    ),
    step(
      "git",
      "Git Environment",
      gitPrepared ? "COMPLETE" : task.state === "READY_FOR_IMPLEMENTATION" ? "CURRENT" : "PENDING",
    ),
    step("implementation", "Implementation", implementationStatus),
    step("review", "Cross Review", reviewStatus),
    step(
      "ready-for-qa",
      "Ready for QA",
      task.state === "READY_FOR_QA" ? "COMPLETE" : "PENDING",
    ),
  ];
};

export class WorkflowService {
  private readonly tasks: TaskService;
  private readonly projects: ProjectRegistry;
  private readonly settings: SettingsStore;
  private readonly analysis: AnalysisArtifactStore;
  private readonly git: GitSafetyService;
  private readonly orchestration: ImplementationOrchestrator;
  private readonly orchestrationArtifacts: OrchestrationArtifactStore;

  constructor(input: {
    readonly tasks: TaskService;
    readonly projects: ProjectRegistry;
    readonly settings: SettingsStore;
    readonly analysis: AnalysisArtifactStore;
    readonly git: GitSafetyService;
    readonly orchestration: ImplementationOrchestrator;
    readonly orchestrationArtifacts: OrchestrationArtifactStore;
  }) {
    this.tasks = input.tasks;
    this.projects = input.projects;
    this.settings = input.settings;
    this.analysis = input.analysis;
    this.git = input.git;
    this.orchestration = input.orchestration;
    this.orchestrationArtifacts = input.orchestrationArtifacts;
  }

  async createTask(value: unknown): Promise<Task> {
    const input = asObject(value, "task input");
    const projectId = input.projectId;
    if (projectId === undefined) {
      return this.tasks.create(input);
    }
    if (typeof projectId !== "string") {
      throw new ServerError("VALIDATION_ERROR", "task input.projectId must be a string.", 400);
    }
    const project = this.projects.get(projectId);
    const { projectId: _projectId, targetProjectPath: _path, ...taskInput } = input;
    const task = await this.tasks.create({
      ...taskInput,
      targetProjectPath: project.path,
    });
    await this.projects.markUsed(project.id);
    return task;
  }

  getSettings() {
    return this.settings.get();
  }

  async updateSettings(value: unknown) {
    const updated = await this.settings.update(value);
    this.tasks.setSettings(updated);
    return updated;
  }

  async getProgress(id: string) {
    const task = await this.tasks.get(id);
    const artifacts = await this.orchestrationArtifacts.get(task.id);
    return {
      taskId: task.id,
      state: task.state,
      active: this.orchestration.isActive(task.id),
      steps: progressSteps(task),
      events: task.events,
      failure: artifacts.failure,
      reviewFindingCount: artifacts.review?.findings.length ?? 0,
    };
  }

  async getDetails(id: string) {
    const task = await this.tasks.get(id);
    const project = this.projects.findByPath(task.targetProjectPath);
    const [analysis, orchestration, environment] = await Promise.all([
      this.analysis.get(task.id),
      this.orchestrationArtifacts.get(task.id),
      this.git.getEnvironment(task.id),
    ]);
    let gitStatus;
    let gitDiff;
    if (environment !== undefined && environment.status !== "CLEANED") {
      try {
        [gitStatus, gitDiff] = await Promise.all([
          this.git.status(task.id),
          this.git.diff(task.id),
        ]);
      } catch {
        // Persisted metadata and orchestration failure remain visible even when
        // a damaged external worktree cannot be inspected live.
      }
    }
    return {
      task,
      ...(project === undefined ? {} : { project }),
      ...(analysis === undefined ? {} : { analysis }),
      git: {
        environment,
        status: gitStatus,
        diff: gitDiff,
      },
      orchestration,
      progress: {
        taskId: task.id,
        state: task.state,
        active: this.orchestration.isActive(task.id),
        steps: progressSteps(task),
        events: task.events,
        failure: orchestration.failure,
        reviewFindingCount: orchestration.review?.findings.length ?? 0,
      },
      blockedActions:
        task.state === "BLOCKED" ||
        (task.state === "PAUSED" && task.pause?.previousState === "BLOCKED")
          ? ["CREATE_PREREQUISITE_TASK", "PAUSE", "RECHECK", "CANCEL"]
          : [],
    };
  }

  projectForTask(task: Task): ProjectRecord | undefined {
    return this.projects.findByPath(task.targetProjectPath);
  }
}
