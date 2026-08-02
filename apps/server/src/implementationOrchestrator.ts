import {
  beginTaskImplementation,
  completeTaskImplementation,
  completeTaskReview,
  failTaskExecution,
  markPausedExecutionInterrupted,
  parseImplementationAgentOutput,
  parseReviewAgentOutput,
  recordTaskOrchestrationFailure,
} from "@unityai/core";
import type {
  ImplementationResult,
  ModelPlan,
  ReasoningEffort,
  ReviewResult,
  Task,
  TaskExecutionFailure,
  TaskId,
} from "@unityai/core";

import type { AIExecutionResult } from "./aiProvider.js";
import type { AIService } from "./aiService.js";
import type { AnalysisArtifactStore } from "./analysisArtifactStore.js";
import { ServerError } from "./errors.js";
import type { GitSafetyService } from "./gitSafetyService.js";
import type { OrchestrationArtifactStore } from "./orchestrationArtifactStore.js";
import { TargetProjectGuard } from "./targetProjectGuard.js";
import type { TaskService } from "./taskService.js";

interface ActiveRun {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

export interface ImplementationStartResult {
  readonly taskId: TaskId;
  readonly status: "STARTED";
}

class OrchestrationRunError extends Error {
  readonly phase: TaskExecutionFailure["phase"];
  readonly code: string;
  readonly runId?: string;

  constructor(
    phase: TaskExecutionFailure["phase"],
    code: string,
    message: string,
    runId?: string,
  ) {
    super(message);
    this.name = "OrchestrationRunError";
    this.phase = phase;
    this.code = code;
    if (runId !== undefined) {
      this.runId = runId;
    }
  }
}

const requireSuccessfulExecution = (
  result: AIExecutionResult,
  phase: "IMPLEMENTATION" | "REVIEW",
): void => {
  if (result.status !== "SUCCEEDED") {
    throw new OrchestrationRunError(
      phase,
      result.failure?.code ?? "PROVIDER_EXIT_FAILURE",
      result.failure?.message ?? `${phase} provider execution failed.`,
      result.runId,
    );
  }
  if (result.structuredOutput === undefined) {
    throw new OrchestrationRunError(
      phase,
      "INVALID_PROVIDER_OUTPUT",
      `${phase} provider execution returned no structured output.`,
      result.runId,
    );
  }
};

const failureFrom = (
  error: unknown,
  fallbackPhase: TaskExecutionFailure["phase"],
): TaskExecutionFailure => {
  const phase = error instanceof OrchestrationRunError
    ? error.phase
    : fallbackPhase;
  const code = error instanceof OrchestrationRunError
    ? error.code
    : error instanceof ServerError
      ? error.code
      : "ORCHESTRATION_FAILED";
  const message = error instanceof Error ? error.message : "Unknown orchestration failure";
  const runId = error instanceof OrchestrationRunError ? error.runId : undefined;
  return {
    phase,
    code,
    message,
    occurredAt: new Date().toISOString(),
    ...(runId === undefined ? {} : { runId }),
  };
};

const requireEffort = (
  plan: ModelPlan,
  phase: "Implementation" | "Review",
): ModelPlan & { readonly effort: ReasoningEffort } => {
  if (plan.effort === undefined) {
    throw new OrchestrationRunError(
      phase === "Review" ? "REVIEW" : "IMPLEMENTATION",
      "ROUTING_SNAPSHOT_INVALID",
      `${phase} routing snapshot must contain an explicit reasoning effort.`,
    );
  }
  return { ...plan, effort: plan.effort };
};

const assertAgentPermission = (
  ai: AIService,
  agentId: string,
  permission: "READ_ONLY" | "WORKTREE_WRITE",
): void => {
  const agent = ai.listAgents().find((candidate) => candidate.id === agentId);
  if (agent?.permission !== permission) {
    throw new OrchestrationRunError(
      agentId === "review" ? "REVIEW" : "IMPLEMENTATION",
      "AGENT_PERMISSION_MISMATCH",
      `Agent ${agentId} must use ${permission} permission.`,
    );
  }
};

const taskPlanningContext = (
  task: Task,
  analysis: Awaited<ReturnType<AnalysisArtifactStore["get"]>>,
): Record<string, unknown> => ({
  taskId: task.id,
  originalRequest: task.originalRequest,
  ...(task.title === undefined ? {} : { title: task.title }),
  approvedTaskContract: task.taskContract,
  feasibility: analysis?.feasibility?.result,
  interpretation: analysis?.interpretation?.result,
  routingSnapshot: task.taskContract?.executionPlan,
});

export class ImplementationOrchestrator {
  private readonly tasks: TaskService;
  private readonly git: GitSafetyService;
  private readonly ai: AIService;
  private readonly analysisArtifacts: AnalysisArtifactStore;
  private readonly artifacts: OrchestrationArtifactStore;
  private readonly targetGuard: TargetProjectGuard;
  private readonly active = new Map<TaskId, ActiveRun>();

  constructor(
    tasks: TaskService,
    git: GitSafetyService,
    ai: AIService,
    analysisArtifacts: AnalysisArtifactStore,
    artifacts: OrchestrationArtifactStore,
    targetGuard = new TargetProjectGuard(),
  ) {
    this.tasks = tasks;
    this.git = git;
    this.ai = ai;
    this.analysisArtifacts = analysisArtifacts;
    this.artifacts = artifacts;
    this.targetGuard = targetGuard;
  }

  async start(id: string): Promise<ImplementationStartResult> {
    const task = await this.tasks.get(id);
    if (this.active.has(task.id)) {
      throw new ServerError(
        "TASK_IMPLEMENTATION_IN_PROGRESS",
        `Implementation is already running for ${task.id}.`,
        409,
      );
    }
    this.validateStart(task);
    const controller = new AbortController();
    const promise = this.execute(task.id, controller.signal).finally(() => {
      this.active.delete(task.id);
    });
    this.active.set(task.id, { controller, promise });
    void promise.catch(() => undefined);
    return { taskId: task.id, status: "STARTED" };
  }

  abort(id: string): boolean {
    const entry = this.active.get(id as TaskId);
    if (entry === undefined) {
      return false;
    }
    entry.controller.abort();
    return true;
  }

  isActive(id: string): boolean {
    return this.active.has(id as TaskId);
  }

  async waitForIdle(id: string): Promise<Task> {
    const entry = this.active.get(id as TaskId);
    if (entry !== undefined) {
      await entry.promise;
    }
    return this.tasks.get(id);
  }

  async recoverInterruptedRuns(): Promise<readonly Task[]> {
    const recovered: Task[] = [];
    for (const task of await this.tasks.list()) {
      if (task.state !== "IMPLEMENTING" && task.state !== "REVIEWING") {
        continue;
      }
      const failure: TaskExecutionFailure = {
        phase: "INTERRUPTION",
        code: "SERVER_RESTART_INTERRUPTED",
        message: `Server restarted while task ${task.id} was ${task.state}. The managed worktree was preserved.`,
        occurredAt: new Date().toISOString(),
      };
      await this.artifacts.saveFailure(task.id, failure);
      const failed = failTaskExecution(task, failure);
      recovered.push(await this.tasks.saveTask(failed));
    }
    return recovered;
  }

  private validateStart(task: Task): void {
    if (task.state !== "READY_FOR_IMPLEMENTATION") {
      throw new ServerError(
        "INVALID_TRANSITION",
        `Task ${task.id} must be READY_FOR_IMPLEMENTATION before it can start.`,
        409,
      );
    }
    const contract = task.taskContract;
    if (contract?.approved !== true || contract.executionPlan === undefined) {
      throw new ServerError(
        "TASK_CONTRACT_NOT_APPROVED",
        `Task ${task.id} requires an approved routed Task Contract.`,
        409,
      );
    }
    requireEffort(contract.executionPlan.implementation, "Implementation");
    if (contract.executionPlan.review.enabled) {
      requireEffort(contract.executionPlan.review.plan, "Review");
    }
    assertAgentPermission(this.ai, "implementation", "WORKTREE_WRITE");
    if (contract.executionPlan.review.enabled) {
      assertAgentPermission(this.ai, "review", "READ_ONLY");
    }
  }

  private async execute(id: TaskId, signal: AbortSignal): Promise<void> {
    let phase: TaskExecutionFailure["phase"] = "GIT_PREPARATION";
    try {
      await this.artifacts.clearFailure(id);
      let task = await this.tasks.get(id);
      const contract = task.taskContract;
      if (contract?.executionPlan === undefined) {
        throw new OrchestrationRunError(
          "GIT_PREPARATION",
          "ROUTING_SNAPSHOT_INVALID",
          `Task ${id} lost its approved execution routing snapshot.`,
        );
      }
      const routing = contract.executionPlan;
      const environment = await this.git.prepare(id);
      if (
        environment.writeOwnerTaskId !== task.id ||
        environment.taskId !== task.id ||
        environment.taskWorktreePath === environment.originalWorktreePath
      ) {
        throw new OrchestrationRunError(
          "GIT_PREPARATION",
          "GIT_ENVIRONMENT_MISMATCH",
          `Managed worktree ownership is invalid for ${task.id}.`,
        );
      }

      task = beginTaskImplementation(task, {
        taskBranch: environment.taskBranch,
        worktreePath: environment.taskWorktreePath,
        baseCommit: environment.baseCommit,
      });
      await this.tasks.saveTask(task);

      phase = "IMPLEMENTATION";
      const analysis = await this.analysisArtifacts.get(task.id);
      const implementationPlan = requireEffort(
        routing.implementation,
        "Implementation",
      );
      const implementationExecution = await this.ai.executePlanned(
        {
          agentId: "implementation",
          modelId: implementationPlan.modelId,
          effort: implementationPlan.effort,
          workingDirectory: environment.taskWorktreePath,
          input: JSON.stringify(taskPlanningContext(task, analysis)),
          context:
            "Implement only the approved contract in this managed worktree. Do not stage, commit, reset, clean, finalize, merge, push, or run the future full QA session.",
        },
        implementationPlan,
        signal,
      );
      requireSuccessfulExecution(implementationExecution, "IMPLEMENTATION");
      const implementationOutput = parseImplementationAgentOutput(
        implementationExecution.structuredOutput,
      );
      if (
        implementationExecution.providerId !== implementationPlan.providerId ||
        implementationExecution.modelId !== implementationPlan.modelId ||
        implementationExecution.effort !== implementationPlan.effort
      ) {
        throw new OrchestrationRunError(
          "IMPLEMENTATION",
          "ROUTING_SNAPSHOT_MISMATCH",
          "Implementation execution did not match the approved routing snapshot.",
          implementationExecution.runId,
        );
      }

      const status = await this.git.status(id);
      const diff = await this.git.diff(id);
      if (status.headCommit !== environment.baseCommit) {
        throw new OrchestrationRunError(
          "IMPLEMENTATION",
          "IMPLEMENTATION_GIT_STATE_INVALID",
          "Implementation agent changed Git history instead of leaving changes for UnityAI checkpointing.",
          implementationExecution.runId,
        );
      }
      if (status.isClean || diff.changedFiles.length === 0) {
        throw new OrchestrationRunError(
          "IMPLEMENTATION",
          "IMPLEMENTATION_NO_CHANGES",
          "Implementation reported success but made no project changes.",
          implementationExecution.runId,
        );
      }

      let implementationResult: ImplementationResult = {
        schemaVersion: 1,
        ...implementationOutput,
        changedFiles: diff.changedFiles,
        runId: implementationExecution.runId,
        providerId: implementationExecution.providerId,
        modelId: implementationExecution.modelId,
        effort: implementationExecution.effort,
        status: "SUCCEEDED",
        startedAt: implementationExecution.startedAt,
        finishedAt: implementationExecution.finishedAt,
      };
      await this.artifacts.saveImplementation(id, implementationResult);

      phase = "CHECKPOINT";
      const checkpoint = await this.git.checkpoint(id, {
        label: "implementation-1",
      });
      implementationResult = {
        ...implementationResult,
        checkpointId: checkpoint.checkpoint.id,
        checkpointCommit: checkpoint.checkpoint.commit,
      };
      await this.artifacts.saveImplementation(id, implementationResult);
      const checkpointStatus = await this.git.status(id);
      const checkpointDiff = await this.git.diff(id);
      await this.artifacts.saveGitSnapshot(id, {
        schemaVersion: 1,
        branch: checkpointStatus.branch,
        headCommit: checkpointStatus.headCommit,
        isClean: checkpointStatus.isClean,
        changedFiles: checkpointDiff.changedFiles,
        stagedFiles: checkpointStatus.stagedFiles,
        unstagedFiles: checkpointStatus.unstagedFiles,
        untrackedFiles: checkpointStatus.untrackedFiles,
        diffSummary: checkpointDiff.summary,
        recordedAt: new Date().toISOString(),
      });

      const reviewEnabled = routing.review.enabled;
      task = completeTaskImplementation(
        await this.tasks.get(id),
        {
          runId: implementationExecution.runId,
          checkpointId: checkpoint.checkpoint.id,
          checkpointCommit: checkpoint.checkpoint.commit,
          changedFileCount: diff.changedFiles.length,
          reviewEnabled,
        },
      );
      await this.tasks.saveTask(task);
      if (!reviewEnabled) {
        return;
      }

      phase = "REVIEW";
      const reviewPlan = requireEffort(routing.review.plan, "Review");
      const beforeReview = await this.targetGuard.capture(
        environment.taskWorktreePath,
      );
      const reviewDiff = await this.git.diff(id);
      const reviewExecution = await this.ai.executePlanned(
        {
          agentId: "review",
          modelId: reviewPlan.modelId,
          effort: reviewPlan.effort,
          workingDirectory: environment.taskWorktreePath,
          input: JSON.stringify({
            ...taskPlanningContext(task, analysis),
            implementation: implementationResult,
            git: {
              changedFiles: reviewDiff.changedFiles,
              summary: reviewDiff.summary,
              diff: reviewDiff.diff.slice(0, 120_000),
              diffTruncated: reviewDiff.diff.length > 120_000,
            },
          }),
          context:
            "Review only. Do not modify files or Git state, do not run full QA, and do not apply fixes.",
        },
        reviewPlan,
        signal,
      );
      requireSuccessfulExecution(reviewExecution, "REVIEW");
      const afterReview = await this.targetGuard.capture(
        environment.taskWorktreePath,
      );
      try {
        this.targetGuard.assertUnchanged(beforeReview, afterReview);
      } catch (error: unknown) {
        throw new OrchestrationRunError(
          "REVIEW",
          "REVIEW_READ_ONLY_VIOLATION",
          error instanceof Error ? error.message : "Reviewer modified the worktree.",
          reviewExecution.runId,
        );
      }
      const reviewOutput = parseReviewAgentOutput(reviewExecution.structuredOutput);
      if (
        reviewExecution.providerId !== reviewPlan.providerId ||
        reviewExecution.modelId !== reviewPlan.modelId ||
        reviewExecution.effort !== reviewPlan.effort
      ) {
        throw new OrchestrationRunError(
          "REVIEW",
          "ROUTING_SNAPSHOT_MISMATCH",
          "Review execution did not match the approved routing snapshot.",
          reviewExecution.runId,
        );
      }
      const reviewResult: ReviewResult = {
        schemaVersion: 1,
        ...reviewOutput,
        runId: reviewExecution.runId,
        providerId: reviewExecution.providerId,
        modelId: reviewExecution.modelId,
        effort: reviewExecution.effort,
        startedAt: reviewExecution.startedAt,
        finishedAt: reviewExecution.finishedAt,
      };
      await this.artifacts.saveReview(id, reviewResult);
      task = completeTaskReview(
        await this.tasks.get(id),
        {
          runId: reviewExecution.runId,
          status: reviewResult.status,
          findingCount: reviewResult.findings.length,
        },
      );
      await this.tasks.saveTask(task);
    } catch (error: unknown) {
      const failure = failureFrom(error, phase);
      await this.artifacts.saveFailure(id, failure);
      const current = await this.tasks.get(id);
      if (current.state === "IMPLEMENTING" || current.state === "REVIEWING") {
        await this.tasks.saveTask(failTaskExecution(current, failure));
      } else if (
        current.state === "PAUSED" &&
        (current.pause?.previousState === "IMPLEMENTING" ||
          current.pause?.previousState === "REVIEWING")
      ) {
        await this.tasks.saveTask(markPausedExecutionInterrupted(current, failure));
      } else if (current.state === "READY_FOR_IMPLEMENTATION") {
        await this.tasks.saveTask(recordTaskOrchestrationFailure(current, failure));
      }
    }
  }
}
