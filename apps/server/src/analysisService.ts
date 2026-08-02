import {
  buildDeterministicTaskContract,
  buildExecutionRoutingSnapshot,
  classifyFinalStrength,
  classifyPreliminaryStrength,
  completeTaskAnalysis,
  editTaskContract,
  failTaskAnalysis,
  parseAnalysisFeasibilityResult,
  parseTaskContract,
  parseTaskContractPatch,
  parseTaskInterpretationResult,
  recheckTask,
  resolveConfiguredModelPlan,
} from "@unityai/core";
import type {
  AnalysisFailureArtifact,
  AnalysisFeasibilityResult,
  AnalysisPhase,
  FeasibilityArtifact,
  InterpretationArtifact,
  ModelConfiguration,
  ModelPlan,
  Task,
  TaskAnalysisArtifacts,
  TaskAnalysisFailure,
  TaskContract,
  TaskId,
  TaskInterpretationResult,
  TaskStrength,
} from "@unityai/core";

import type { AIExecutionResult } from "./aiProvider.js";
import type { AIService } from "./aiService.js";
import { AnalysisArtifactStore } from "./analysisArtifactStore.js";
import { ServerError } from "./errors.js";
import { TaskService } from "./taskService.js";
import {
  TargetProjectGuard,
} from "./targetProjectGuard.js";
import type { TargetProjectSnapshot } from "./targetProjectGuard.js";

interface AnalysisExecutor {
  getModelConfiguration(): ModelConfiguration;
  execute(value: unknown, signal?: AbortSignal): Promise<AIExecutionResult>;
}

export interface AnalysisOperationResult {
  readonly task: Task;
  readonly analysis: TaskAnalysisArtifacts;
}

class AnalysisRunError extends ServerError {
  readonly runId?: string;
  readonly causeCode: string;

  constructor(
    causeCode: string,
    message: string,
    runId?: string,
  ) {
    super(
      "ANALYSIS_EXECUTION_FAILED",
      message,
      502,
      {
        causeCode,
        ...(runId === undefined ? {} : { runId }),
      },
    );
    this.name = "AnalysisRunError";
    this.causeCode = causeCode;
    if (runId !== undefined) {
      this.runId = runId;
    }
  }
}

const requireEffort = (plan: ModelPlan, work: string): NonNullable<ModelPlan["effort"]> => {
  if (plan.effort === undefined) {
    throw new ServerError(
      "CONFIG_ERROR",
      `${work} routing must specify reasoning effort.`,
      500,
    );
  }
  return plan.effort;
};

const structuredResult = <T>(
  result: AIExecutionResult,
  parse: (value: unknown) => T,
): T => {
  if (result.status !== "SUCCEEDED") {
    throw new AnalysisRunError(
      result.failure?.code ?? "PROVIDER_EXIT_FAILURE",
      result.failure?.message ?? `AI run ${result.runId} failed.`,
      result.runId,
    );
  }
  if (result.structuredOutput === undefined) {
    throw new AnalysisRunError(
      "INVALID_PROVIDER_OUTPUT",
      `AI run ${result.runId} returned no structured output.`,
      result.runId,
    );
  }
  try {
    return parse(result.structuredOutput);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid structured output";
    throw new AnalysisRunError(
      "STRUCTURED_OUTPUT_VALIDATION_FAILED",
      message,
      result.runId,
    );
  }
};

const minimalFeasibility = (result: AnalysisFeasibilityResult) => ({
  status: result.status,
  summary: result.summary,
  missingCapabilities: result.missingCapabilities,
  ...(result.suggestedPrerequisite === null
    ? {}
    : { suggestedPrerequisite: result.suggestedPrerequisite.request }),
  metadata: {
    source: "m4_ai_analysis",
    evidenceCount: String(result.evidence.length),
    architectureImpact: result.architectureImpact,
    implementationComplexity: result.implementationComplexity,
    regressionRisk: result.regressionRisk,
  },
});

const failureDetails = (
  error: unknown,
  phase: AnalysisPhase,
): TaskAnalysisFailure => {
  const code =
    error instanceof AnalysisRunError
      ? error.causeCode
      : error instanceof ServerError
        ? error.code
        : "ANALYSIS_FAILED";
  const message = error instanceof Error ? error.message : "Unknown analysis failure";
  const runId = error instanceof AnalysisRunError ? error.runId : undefined;
  return {
    phase,
    code,
    message,
    occurredAt: new Date().toISOString(),
    ...(runId === undefined ? {} : { runId }),
  };
};

const isBlockedTask = (task: Task): boolean =>
  task.state === "BLOCKED" ||
  (task.state === "PAUSED" && task.pause?.previousState === "BLOCKED");

export class AnalysisService {
  private readonly tasks: TaskService;
  private readonly artifacts: AnalysisArtifactStore;
  private readonly ai: AnalysisExecutor;
  private readonly targetGuard: TargetProjectGuard;
  private readonly activeTaskIds = new Set<TaskId>();

  constructor(
    tasks: TaskService,
    artifacts: AnalysisArtifactStore,
    ai: AIService | AnalysisExecutor,
    targetGuard = new TargetProjectGuard(),
  ) {
    this.tasks = tasks;
    this.artifacts = artifacts;
    this.ai = ai;
    this.targetGuard = targetGuard;
  }

  async analyze(id: string, signal?: AbortSignal): Promise<AnalysisOperationResult> {
    return this.withTaskGuard(id, async () => {
      const task = await this.tasks.get(id);
      if (task.targetProjectPath === undefined) {
        throw new ServerError(
          "TARGET_PROJECT_REQUIRED",
          `Task ${task.id} requires targetProjectPath before analysis.`,
          422,
        );
      }
      const before = await this.targetGuard.capture(task.targetProjectPath);
      const analyzing = await this.tasks.analyze(task.id);
      await this.artifacts.resetForInitialAnalysis(task.id);
      return this.executePipeline({
        analyzingTask: analyzing,
        targetSnapshot: before,
        recheckCount: 0,
        ...(signal === undefined ? {} : { signal }),
      });
    });
  }

  async recheck(id: string, signal?: AbortSignal): Promise<AnalysisOperationResult> {
    return this.withTaskGuard(id, async () => {
      const task = await this.tasks.get(id);
      if (!isBlockedTask(task)) {
        throw new ServerError(
          "INVALID_TRANSITION",
          `Task ${task.id} must be blocked before recheck.`,
          409,
        );
      }
      if (task.targetProjectPath === undefined) {
        throw new ServerError(
          "TARGET_PROJECT_REQUIRED",
          `Task ${task.id} requires targetProjectPath before recheck.`,
          422,
        );
      }
      const interpretation = await this.artifacts.getInterpretationForRecheck(task.id);
      const before = await this.targetGuard.capture(task.targetProjectPath);
      const analyzing = await this.tasks.saveTask(recheckTask(task));
      await this.artifacts.resetForRecheck(
        task.id,
        interpretation !== undefined,
      );
      return this.executePipeline({
        analyzingTask: analyzing,
        targetSnapshot: before,
        ...(interpretation === undefined
          ? {}
          : { reuseInterpretation: interpretation }),
        recheckCount: (task.analysis?.recheckCount ?? 0) + 1,
        ...(signal === undefined ? {} : { signal }),
      });
    });
  }

  async getAnalysis(id: string): Promise<AnalysisOperationResult> {
    const task = await this.tasks.get(id);
    const analysis = await this.artifacts.get(task.id);
    if (analysis === undefined) {
      throw new ServerError(
        "ANALYSIS_NOT_FOUND",
        `Task ${task.id} has no persisted M4 analysis.`,
        404,
      );
    }
    return {
      task,
      analysis: {
        ...analysis,
        ...(task.taskContract === undefined
          ? {}
          : { contract: task.taskContract }),
      },
    };
  }

  async editContract(id: string, value: unknown): Promise<AnalysisOperationResult> {
    const task = await this.tasks.get(id);
    if (task.analysis === undefined) {
      throw new ServerError(
        "ANALYSIS_NOT_FOUND",
        `Task ${task.id} has no M4 Task Contract to edit.`,
        404,
      );
    }
    const updated = editTaskContract(task, parseTaskContractPatch(value));
    await this.tasks.saveTask(updated);
    if (updated.taskContract === undefined) {
      throw new ServerError("ANALYSIS_PERSISTENCE_ERROR", "Updated contract was lost.", 500);
    }
    await this.artifacts.saveContract(updated.id, updated.taskContract);
    return this.requireArtifacts(updated);
  }

  async approve(id: string): Promise<AnalysisOperationResult | { readonly task: Task }> {
    const task = await this.tasks.get(id);
    if (task.analysis === undefined) {
      return { task: await this.tasks.approve(id) };
    }
    const updated = await this.tasks.approve(id);
    if (updated.taskContract === undefined) {
      throw new ServerError("ANALYSIS_PERSISTENCE_ERROR", "Approved contract was lost.", 500);
    }
    await this.artifacts.saveContract(updated.id, updated.taskContract);
    return this.requireArtifacts(updated);
  }

  private async executePipeline(input: {
    readonly analyzingTask: Task;
    readonly targetSnapshot: TargetProjectSnapshot;
    readonly reuseInterpretation?: InterpretationArtifact;
    readonly recheckCount: number;
    readonly signal?: AbortSignal;
  }): Promise<AnalysisOperationResult> {
    let phase: AnalysisPhase = "INTERPRETATION";
    let interpretationArtifact = input.reuseInterpretation;
    const configuration = this.ai.getModelConfiguration();
    try {
      if (interpretationArtifact === undefined) {
        const interpreterPlan = resolveConfiguredModelPlan(
          configuration,
          "INTERPRETER",
          input.analyzingTask.strength,
        );
        const result = await this.ai.execute(
          {
            agentId: "task-interpreter",
            modelId: interpreterPlan.modelId,
            effort: requireEffort(interpreterPlan, "Interpreter"),
            workingDirectory: input.targetSnapshot.canonicalPath,
            input: JSON.stringify({
              taskId: input.analyzingTask.id,
              ...(input.analyzingTask.title === undefined
                ? {}
                : { title: input.analyzingTask.title }),
              originalRequest: input.analyzingTask.originalRequest,
              targetProjectPath: input.targetSnapshot.canonicalPath,
            }),
          },
          input.signal,
        );
        const interpretation = structuredResult(
          result,
          parseTaskInterpretationResult,
        );
        interpretationArtifact = {
          schemaVersion: 1,
          runId: result.runId,
          recordedAt: result.finishedAt,
          result: interpretation,
        };
        await this.artifacts.saveInterpretation(
          input.analyzingTask.id,
          interpretationArtifact,
        );
      }

      const interpretation = interpretationArtifact.result;
      const preliminaryStrength = classifyPreliminaryStrength(interpretation);
      phase = "FEASIBILITY";
      const feasibilityPlan = resolveConfiguredModelPlan(
        configuration,
        "FEASIBILITY",
        preliminaryStrength,
      );
      const feasibilityExecution = await this.ai.execute(
        {
          agentId: "feasibility",
          modelId: feasibilityPlan.modelId,
          effort: requireEffort(feasibilityPlan, "Feasibility"),
          workingDirectory: input.targetSnapshot.canonicalPath,
          input: JSON.stringify({
            taskId: input.analyzingTask.id,
            originalRequest: input.analyzingTask.originalRequest,
            preliminaryStrength,
            interpretation,
          }),
          context:
            "Inspect the current working-directory state. It may include user changes. Do not modify, clean, stash, commit, or install anything.",
        },
        input.signal,
      );
      const feasibility = structuredResult(
        feasibilityExecution,
        parseAnalysisFeasibilityResult,
      );
      const feasibilityArtifact: FeasibilityArtifact = {
        schemaVersion: 1,
        runId: feasibilityExecution.runId,
        recordedAt: feasibilityExecution.finishedAt,
        preliminaryStrength,
        result: feasibility,
      };
      await this.artifacts.saveFeasibility(
        input.analyzingTask.id,
        feasibilityArtifact,
      );

      phase = "READ_ONLY_VERIFICATION";
      const after = await this.targetGuard.capture(
        input.targetSnapshot.canonicalPath,
      );
      this.targetGuard.assertUnchanged(input.targetSnapshot, after);

      phase = "PLANNING";
      const finalStrength = classifyFinalStrength(interpretation, feasibility);
      const timestamp = new Date().toISOString();
      const routing = buildExecutionRoutingSnapshot(
        configuration,
        finalStrength,
        input.analyzingTask.crossReviewEnabled,
        input.analyzingTask.automaticFixesEnabled,
        timestamp,
      );
      const contractInput = feasibility.status === "READY"
        ? buildDeterministicTaskContract(
            interpretation,
            feasibility,
            finalStrength,
            routing,
          )
        : undefined;
      const contract: TaskContract | undefined = contractInput === undefined
        ? undefined
        : parseTaskContract({
            ...contractInput,
            nonGoals: contractInput.nonGoals ?? [],
            approved: false,
          });
      await this.artifacts.saveRouting(input.analyzingTask.id, routing);
      if (contract !== undefined) {
        await this.artifacts.saveContract(input.analyzingTask.id, contract);
      }
      const completed = completeTaskAnalysis(
        input.analyzingTask,
        {
          title: interpretation.title,
          feasibility: minimalFeasibility(feasibility),
          ...(contractInput === undefined ? {} : { taskContract: contractInput }),
          analysis: {
            preliminaryStrength,
            finalStrength,
            interpretationRunId: interpretationArtifact.runId,
            feasibilityRunId: feasibilityExecution.runId,
            routingSnapshot: routing,
            analyzedAt: timestamp,
            recheckCount: input.recheckCount,
          },
        },
        timestamp,
      );
      await this.tasks.saveTask(completed);
      return this.requireArtifacts(completed);
    } catch (originalError: unknown) {
      let error = originalError;
      try {
        const after = await this.targetGuard.capture(
          input.targetSnapshot.canonicalPath,
        );
        this.targetGuard.assertUnchanged(input.targetSnapshot, after);
      } catch (guardError: unknown) {
        error = guardError;
        phase = "READ_ONLY_VERIFICATION";
      }
      const failure = failureDetails(error, phase);
      const failed = failTaskAnalysis(input.analyzingTask, failure);
      await this.tasks.saveTask(failed);
      await this.artifacts.resetForRecheck(
        failed.id,
        interpretationArtifact !== undefined,
      );
      const failureArtifact: AnalysisFailureArtifact = {
        schemaVersion: 1,
        ...failure,
      };
      await this.artifacts.saveFailure(failed.id, failureArtifact);
      throw error;
    }
  }

  private async requireArtifacts(task: Task): Promise<AnalysisOperationResult> {
    const analysis = await this.artifacts.get(task.id);
    if (analysis === undefined) {
      throw new ServerError(
        "ANALYSIS_PERSISTENCE_ERROR",
        `Analysis artifacts for ${task.id} were not persisted.`,
        500,
      );
    }
    return { task, analysis };
  }

  private async withTaskGuard<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const task = await this.tasks.get(id);
    if (this.activeTaskIds.has(task.id)) {
      throw new ServerError(
        "TASK_ANALYSIS_IN_PROGRESS",
        `Analysis is already running for ${task.id}.`,
        409,
      );
    }
    this.activeTaskIds.add(task.id);
    try {
      return await operation();
    } finally {
      this.activeTaskIds.delete(task.id);
    }
  }
}
