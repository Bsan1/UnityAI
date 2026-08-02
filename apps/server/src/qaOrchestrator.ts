import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  beginTaskFix,
  beginTaskQA,
  completeTaskFixAndRestartQA,
  completeTaskQAAndFinalize,
  completeTaskQAForGameplay,
  failTaskFix,
  failTaskQA,
  markPausedQAInterrupted,
  parseFixAgentOutput,
  parseQAAgentOutput,
  parseQASession,
  recordTaskQAFailure,
  recordTaskQAProgress,
} from "@unityai/core";
import type {
  FixResult,
  JsonValue,
  McpStdioServerConfiguration,
  ModelPlan,
  QAEvidence,
  QAEvidenceInput,
  QAFinding,
  QAPlannedTest,
  QAReport,
  QASession,
  QASessionSummary,
  QATechnicalFailure,
  QATechnicalPhase,
  QATestResult,
  ReasoningEffort,
  Task,
  TaskId,
} from "@unityai/core";
import { UnityIntegrationError } from "@unityai/unity";
import type {
  UnityBridgeClient,
  UnityEditorStatus,
} from "@unityai/unity";

import type { AIExecutionResult } from "./aiProvider.js";
import type { AIService } from "./aiService.js";
import type { AnalysisArtifactStore } from "./analysisArtifactStore.js";
import { ServerError } from "./errors.js";
import type { GitSafetyService } from "./gitSafetyService.js";
import type { OrchestrationArtifactStore } from "./orchestrationArtifactStore.js";
import type { QAArtifactStore } from "./qaArtifactStore.js";
import { TargetProjectGuard } from "./targetProjectGuard.js";
import type { TaskService } from "./taskService.js";
import type {
  UnityEnvironmentService,
  UnityTaskEnvironmentStatus,
} from "./unityEnvironmentService.js";

export const AUTOMATIC_FIX_CYCLE_LIMIT = 3 as const;

export const UNITY_QA_MCP_TOOLS = [
  "unity_ping",
  "unity_editor_status",
  "unity_request_compilation",
  "unity_enter_play_mode",
  "unity_exit_play_mode",
  "unity_set_play_mode_paused",
  "unity_console",
  "unity_scene_summary",
  "unity_scene_hierarchy",
  "unity_object_snapshot",
] as const;

const unityToolingPrefix = "Packages/com.unityai.editor-bridge";
const baselineCompilationId = "QA0-COMPILATION";
const baselineGitDiffId = "QA0-GIT-DIFF";

interface ActiveRun {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

export interface QAStartResult {
  readonly taskId: TaskId;
  readonly status: "STARTED";
}

export interface QAOrchestratorOptions {
  readonly unityMcpEntrypoint: string;
  readonly automaticFixLimit?: number;
  readonly targetGuard?: TargetProjectGuard;
  readonly playModeTimeoutMs?: number;
  readonly compilationTimeoutMs?: number;
}

class QARunError extends Error {
  readonly phase: QATechnicalPhase;
  readonly code: string;
  readonly runId?: string;

  constructor(phase: QATechnicalPhase, code: string, message: string, runId?: string) {
    super(message);
    this.name = "QARunError";
    this.phase = phase;
    this.code = code;
    if (runId !== undefined) {
      this.runId = runId;
    }
  }
}

interface EvidenceCollector {
  readonly values: QAEvidence[];
  add(input: QAEvidenceInput): string;
}

interface CycleAllocation {
  readonly cycleNumber: number;
  readonly sessionId: string;
}

interface CycleResult {
  readonly session: QASession;
  readonly report: QAReport;
}

const now = (): string => new Date().toISOString();

const maximumEvidenceDetailsBytes = 32 * 1024;

const jsonDetails = (value: unknown): JsonValue => {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= maximumEvidenceDetailsBytes) {
    return JSON.parse(serialized) as JsonValue;
  }
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    serializedPreview: Buffer.from(serialized, "utf8")
      .subarray(0, maximumEvidenceDetailsBytes)
      .toString("utf8"),
  };
};

const evidenceCollector = (): EvidenceCollector => {
  const values: QAEvidence[] = [];
  return {
    values,
    add: (input) => {
      const id = `EVID-${String(values.length + 1).padStart(4, "0")}`;
      values.push({ ...input, id, capturedAt: now() });
      return id;
    },
  };
};

const emptySummary = (text: string): QASessionSummary => ({
  text,
  passed: 0,
  failed: 0,
  blocked: 0,
  notRun: 0,
  gameplayPending: 0,
});

const summarize = (results: readonly QATestResult[], text: string): QASessionSummary => ({
  text,
  passed: results.filter((result) => result.status === "PASS").length,
  failed: results.filter((result) => result.status === "FAIL").length,
  blocked: results.filter((result) => result.status === "BLOCKED").length,
  notRun: results.filter((result) => result.status === "NOT_RUN").length,
  gameplayPending: results.filter(
    (result) => result.category === "GAMEPLAY" && result.status === "NOT_RUN",
  ).length,
});

const isToolingPath = (path: string): boolean => {
  const normalized = path.replaceAll("\\", "/");
  return normalized === unityToolingPrefix ||
    normalized === `${unityToolingPrefix}.meta` ||
    normalized.startsWith(`${unityToolingPrefix}/`);
};

const buildPlan = (task: Task): readonly QAPlannedTest[] => {
  const contractTests = task.taskContract?.testRequirementDetails ?? [];
  const reserved = new Set([baselineCompilationId, baselineGitDiffId]);
  const plan: QAPlannedTest[] = [
    {
      id: baselineGitDiffId,
      category: "STATIC",
      description: "The managed task diff contains meaningful product changes and excludes UnityAI tooling.",
      required: true,
      source: "BASELINE",
    },
    {
      id: baselineCompilationId,
      category: "STATIC",
      description: "The Unity project compiles without compiler errors introduced by the task.",
      required: true,
      source: "BASELINE",
    },
  ];
  for (const test of contractTests) {
    const id = reserved.has(test.id)
      ? `CONTRACT-${test.id}`
      : test.id;
    if (plan.some((candidate) => candidate.id === id)) {
      continue;
    }
    plan.push({
      id,
      category: test.category,
      description: test.description,
      required: true,
      source: "CONTRACT",
    });
  }
  return plan;
};

const technicalFailure = (
  error: unknown,
  fallbackPhase: QATechnicalPhase,
): QATechnicalFailure => ({
  phase: error instanceof QARunError ? error.phase : fallbackPhase,
  code:
    error instanceof QARunError
      ? error.code
      : error instanceof UnityIntegrationError || error instanceof ServerError
        ? error.code
        : error instanceof Error && error.name === "AbortError"
          ? "EXECUTION_CANCELLED"
          : "QA_TECHNICAL_FAILURE",
  message: error instanceof Error ? error.message : "Unknown QA infrastructure failure.",
  occurredAt: now(),
  ...(error instanceof QARunError && error.runId !== undefined
    ? { runId: error.runId }
    : {}),
});

const requireSuccessfulExecution = (
  result: AIExecutionResult,
  phase: "AGENT" | "FIX",
): void => {
  if (result.status !== "SUCCEEDED") {
    throw new QARunError(
      phase,
      result.failure?.code ?? "PROVIDER_EXIT_FAILURE",
      result.failure?.message ?? `${phase} provider execution failed.`,
      result.runId,
    );
  }
  if (result.structuredOutput === undefined) {
    throw new QARunError(
      phase,
      "INVALID_PROVIDER_OUTPUT",
      `${phase} provider execution returned no structured output.`,
      result.runId,
    );
  }
};

const requireEffort = (
  plan: ModelPlan,
  phase: "AGENT" | "FIX",
): ModelPlan & { readonly effort: ReasoningEffort } => {
  if (plan.effort === undefined) {
    throw new QARunError(
      phase,
      "ROUTING_SNAPSHOT_INVALID",
      `${phase === "FIX" ? "Fix" : "QA"} route requires explicit effort.`,
    );
  }
  return { ...plan, effort: plan.effort };
};

const reportFromSession = (session: QASession): QAReport => ({
  schemaVersion: 1,
  sessionId: session.sessionId,
  taskId: session.taskId,
  cycleNumber: session.cycleNumber,
  outcome: session.status === "RUNNING" ? "TECHNICAL_FAILURE" : session.status,
  summary: session.summary,
  results: session.results,
  findings: session.findings,
  blockedTests: session.blockedTests,
  generatedAt: session.completedAt ?? now(),
  manualFixAvailable: session.status === "FAIL" && session.findings.length > 0,
});

const commitMessageFor = (task: Task): string => {
  const title = (task.title ?? task.taskContract?.originalTaskSummary ?? task.originalRequest)
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
  return `${task.id}: ${title || "Complete approved task"}`;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
};

export const createUnityQAMcpConfiguration = (
  projectWorktreePath: string,
  unityMcpEntrypoint: string,
): McpStdioServerConfiguration => ({
  id: "unity",
  transport: "stdio",
  command: process.execPath,
  arguments: [resolve(unityMcpEntrypoint), "--projectPath", resolve(projectWorktreePath)],
  allowedTools: UNITY_QA_MCP_TOOLS,
  startupTimeoutMs: 30_000,
  toolTimeoutMs: 60_000,
});

export class QAOrchestrator {
  private readonly tasks: TaskService;
  private readonly git: GitSafetyService;
  private readonly ai: AIService;
  private readonly unity: UnityEnvironmentService;
  private readonly analysis: AnalysisArtifactStore;
  private readonly orchestration: OrchestrationArtifactStore;
  private readonly artifacts: QAArtifactStore;
  private readonly unityMcpEntrypoint: string;
  private readonly automaticFixLimit: number;
  private readonly targetGuard: TargetProjectGuard;
  private readonly playModeTimeoutMs: number;
  private readonly compilationTimeoutMs: number;
  private readonly active = new Map<TaskId, ActiveRun>();

  constructor(input: {
    readonly tasks: TaskService;
    readonly git: GitSafetyService;
    readonly ai: AIService;
    readonly unity: UnityEnvironmentService;
    readonly analysis: AnalysisArtifactStore;
    readonly orchestration: OrchestrationArtifactStore;
    readonly artifacts: QAArtifactStore;
  }, options: QAOrchestratorOptions) {
    this.tasks = input.tasks;
    this.git = input.git;
    this.ai = input.ai;
    this.unity = input.unity;
    this.analysis = input.analysis;
    this.orchestration = input.orchestration;
    this.artifacts = input.artifacts;
    this.unityMcpEntrypoint = resolve(options.unityMcpEntrypoint);
    this.automaticFixLimit = options.automaticFixLimit ?? AUTOMATIC_FIX_CYCLE_LIMIT;
    this.targetGuard = options.targetGuard ?? new TargetProjectGuard();
    this.playModeTimeoutMs = options.playModeTimeoutMs ?? 30_000;
    this.compilationTimeoutMs = options.compilationTimeoutMs ?? 180_000;
    if (!Number.isSafeInteger(this.automaticFixLimit) || this.automaticFixLimit < 1) {
      throw new Error("Automatic fix limit must be a positive integer.");
    }
  }

  async start(id: string): Promise<QAStartResult> {
    const task = await this.tasks.get(id);
    this.assertIdle(task.id);
    this.validateReadyTask(task);
    const allocation = await this.artifacts.nextCycle(task.id);
    await this.artifacts.clearFailure(task.id);
    await this.tasks.saveTask(beginTaskQA(task, allocation));
    this.launch(task.id, (signal) => this.executeCycles(task.id, allocation, signal, 0));
    return { taskId: task.id, status: "STARTED" };
  }

  async fixAndRetest(id: string): Promise<QAStartResult> {
    const task = await this.tasks.get(id);
    this.assertIdle(task.id);
    if (task.state !== "FAILED") {
      throw new ServerError(
        "INVALID_TRANSITION",
        `Task ${task.id} must have a failed QA batch before Fix & Retest.`,
        409,
      );
    }
    const qa = await this.artifacts.get(task.id);
    if (qa.latestReport?.outcome !== "FAIL" || qa.latestReport.findings.length === 0) {
      throw new ServerError(
        "QA_FIX_NOT_AVAILABLE",
        `Task ${task.id} has no fixable completed QA failure batch.`,
        409,
      );
    }
    await this.artifacts.clearFailure(task.id);
    this.launch(task.id, async (signal) => {
      const allocation = await this.runFix(task.id, qa.latestReport as QAReport, false, signal);
      await this.executeCycles(task.id, allocation, signal, 0);
    });
    return { taskId: task.id, status: "STARTED" };
  }

  cancel(id: string): boolean {
    const run = this.active.get(id as TaskId);
    if (run === undefined) {
      return false;
    }
    run.controller.abort();
    return true;
  }

  isActive(id: string): boolean {
    return this.active.has(id as TaskId);
  }

  async waitForIdle(id: string): Promise<Task> {
    const run = this.active.get(id as TaskId);
    if (run !== undefined) {
      await run.promise;
    }
    return this.tasks.get(id);
  }

  async get(id: string) {
    const task = await this.tasks.get(id);
    return this.artifacts.get(task.id);
  }

  async getCycle(id: string, cycle: number) {
    const task = await this.tasks.get(id);
    return this.artifacts.getCycle(task.id, cycle);
  }

  async recoverInterruptedRuns(): Promise<readonly Task[]> {
    const recovered: Task[] = [];
    for (const task of await this.tasks.list()) {
      if (task.state !== "TESTING" && task.state !== "FIXING") {
        continue;
      }
      const failure: QATechnicalFailure = {
        phase: "INTERRUPTION",
        code: "SERVER_RESTART_INTERRUPTED",
        message: `Server restarted while task ${task.id} was ${task.state}. QA artifacts, checkpoints, Unity metadata, and the managed worktree were preserved.`,
        occurredAt: now(),
      };
      await this.artifacts.saveFailure(task.id, failure);
      const qa = await this.artifacts.get(task.id);
      const sessionId = qa.latestSession?.sessionId ?? `QA-INTERRUPTED-${task.id}`;
      if (qa.latestSession?.status === "RUNNING") {
        const interruptedSession = parseQASession({
          ...qa.latestSession,
          completedAt: now(),
          status: "TECHNICAL_FAILURE",
          summary: {
            ...qa.latestSession.summary,
            text: failure.message,
          },
          technicalFailure: failure,
        });
        await Promise.all([
          this.artifacts.saveSession(task.id, interruptedSession),
          this.artifacts.saveReport(task.id, reportFromSession(interruptedSession)),
        ]);
      }
      recovered.push(await this.tasks.saveTask(failTaskQA(task, failure, sessionId)));
    }
    return recovered;
  }

  private launch(taskId: TaskId, execute: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    const promise = execute(controller.signal)
      .catch((error: unknown) => this.handleUncaught(taskId, error))
      .finally(() => this.active.delete(taskId));
    this.active.set(taskId, { controller, promise });
    void promise.catch(() => undefined);
  }

  private assertIdle(taskId: TaskId): void {
    if (this.active.has(taskId)) {
      throw new ServerError(
        "TASK_QA_IN_PROGRESS",
        `QA or fixing is already running for ${taskId}.`,
        409,
      );
    }
  }

  private validateReadyTask(task: Task): void {
    if (task.state !== "READY_FOR_QA") {
      throw new ServerError(
        "INVALID_TRANSITION",
        `Task ${task.id} must be READY_FOR_QA before QA can start.`,
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
    requireEffort(contract.executionPlan.qa, "AGENT");
    const qaAgent = this.ai.listAgents().find((agent) => agent.id === "qa");
    const fixAgent = this.ai.listAgents().find((agent) => agent.id === "fix");
    if (qaAgent?.permission !== "READ_ONLY") {
      throw new ServerError("AGENT_PERMISSION_MISMATCH", "QA Agent must be READ_ONLY.", 500);
    }
    if (fixAgent?.permission !== "WORKTREE_WRITE") {
      throw new ServerError("AGENT_PERMISSION_MISMATCH", "Fix Agent must use WORKTREE_WRITE.", 500);
    }
  }

  private async executeCycles(
    taskId: TaskId,
    firstAllocation: CycleAllocation,
    signal: AbortSignal,
    initialAutomaticFixes: number,
  ): Promise<void> {
    let allocation = firstAllocation;
    let automaticFixes = initialAutomaticFixes;
    for (;;) {
      const cycle = await this.runCycle(taskId, allocation, signal);
      if (cycle.session.status === "TECHNICAL_FAILURE") {
        await this.artifacts.saveFailure(taskId, cycle.session.technicalFailure as QATechnicalFailure);
        await this.failCurrentTask(taskId, cycle.session.technicalFailure as QATechnicalFailure, cycle.session.sessionId);
        return;
      }
      if (cycle.session.status === "INCOMPLETE_GAMEPLAY") {
        await this.leavePlayModeAndStopOwnedEditor(taskId, signal, false);
        const current = await this.tasks.get(taskId);
        await this.tasks.saveTask(completeTaskQAForGameplay(current, {
          sessionId: cycle.session.sessionId,
          gameplayTests: cycle.session.summary.gameplayPending,
        }));
        return;
      }
      if (cycle.session.status === "PASS") {
        await this.finalizeSuccessfulTask(taskId, cycle, signal);
        return;
      }

      let current = await this.tasks.get(taskId);
      current = recordTaskQAFailure(current, {
        sessionId: cycle.session.sessionId,
        findingCount: cycle.session.findings.length,
        technical: false,
      });
      await this.tasks.saveTask(current);
      const canAutomaticallyFix =
        current.automaticFixesEnabled &&
        cycle.session.findings.length > 0 &&
        automaticFixes < this.automaticFixLimit;
      if (!canAutomaticallyFix) {
        return;
      }
      automaticFixes += 1;
      allocation = await this.runFix(taskId, cycle.report, true, signal);
    }
  }

  private async runCycle(
    taskId: TaskId,
    allocation: CycleAllocation,
    signal: AbortSignal,
  ): Promise<CycleResult> {
    const task = await this.tasks.get(taskId);
    const plannedTests = buildPlan(task);
    const collector = evidenceCollector();
    const results: QATestResult[] = [];
    const findings: QAFinding[] = [];
    const startedAt = now();
    let unitySummary: QASession["unityEnvironment"];
    let qaAgentRunId: string | undefined;
    await this.artifacts.saveSession(taskId, {
      schemaVersion: 1,
      sessionId: allocation.sessionId,
      taskId,
      cycleNumber: allocation.cycleNumber,
      startedAt,
      status: "RUNNING",
      plannedTests,
      results: [],
      findings: [],
      blockedTests: [],
      evidence: [],
      summary: emptySummary(`QA cycle ${allocation.cycleNumber} is running.`),
    });

    try {
      const { environment: gitEnvironment } = await this.git.getEnvironmentWithStatus(taskId);
      if (
        gitEnvironment === undefined ||
        gitEnvironment.taskId !== taskId ||
        gitEnvironment.writeOwnerTaskId !== taskId ||
        gitEnvironment.status !== "ACTIVE" ||
        resolve(gitEnvironment.taskWorktreePath) === resolve(gitEnvironment.originalWorktreePath)
      ) {
        throw new QARunError("PREFLIGHT", "GIT_ENVIRONMENT_MISMATCH", "QA requires the active M2-managed task worktree.");
      }

      await this.progress(taskId, "QA_TEST_STARTED", {
        sessionId: allocation.sessionId,
        testId: baselineGitDiffId,
        category: "STATIC",
      });
      const [gitStatus, gitDiff, orchestration, analysis] = await Promise.all([
        this.git.status(taskId),
        this.git.diff(taskId),
        this.orchestration.get(taskId),
        this.analysis.get(taskId),
      ]);
      const productChangedFiles = gitDiff.changedFiles.filter((path) => !isToolingPath(path));
      const gitEvidence = collector.add({
        kind: "GIT_DIFF",
        summary: `${productChangedFiles.length} product file(s) differ from the recorded base commit.`,
        details: jsonDetails({
          branch: gitStatus.branch,
          baseCommit: gitDiff.baseCommit,
          headCommit: gitDiff.headCommit,
          changedFiles: productChangedFiles,
          toolingExcluded: gitDiff.changedFiles.filter(isToolingPath),
          summary: gitDiff.summary.slice(0, 20_000),
        }),
      });
      const meaningfulDiff = productChangedFiles.length > 0;
      results.push({
        testId: baselineGitDiffId,
        category: "STATIC",
        status: meaningfulDiff ? "PASS" : "FAIL",
        summary: meaningfulDiff
          ? "Managed worktree contains meaningful task changes."
          : "No meaningful product changes remain in the managed worktree.",
        expected: "At least one approved task change exists and UnityAI bridge tooling is excluded.",
        observed: `${productChangedFiles.length} product file(s); ${gitDiff.changedFiles.filter(isToolingPath).length} tooling file(s) excluded.`,
        evidence: [gitEvidence],
        likelyArea: ["Git task worktree"],
      });
      if (!meaningfulDiff) {
        findings.push({
          id: "FAIL-GIT-DIFF",
          severity: "blocking",
          title: "No meaningful task changes",
          description: "The managed task worktree has no product diff to validate or finalize.",
          relatedAcceptanceCriteria: [],
          relatedTests: [baselineGitDiffId],
          reproduction: ["Inspect the task diff against its recorded base commit."],
          expected: "The approved implementation produces meaningful product changes.",
          observed: "Only temporary tooling or no changes were found.",
          evidence: [gitEvidence],
          suspectedArea: ["Implementation"],
          source: "STATIC",
        });
      }
      await this.progress(taskId, "QA_TEST_COMPLETED", {
        sessionId: allocation.sessionId,
        testId: baselineGitDiffId,
        status: meaningfulDiff ? "PASS" : "FAIL",
      });

      const prepared = await this.unity.prepare(taskId);
      let unityStatus = await this.unity.status(taskId);
      if (unityStatus.bridge !== "CONNECTED") {
        unityStatus = await this.unity.startEditor(taskId, signal);
      }
      if (unityStatus.bridge !== "CONNECTED") {
        throw new QARunError(
          "MCP",
          unityStatus.diagnostic?.code ?? "UNITY_BRIDGE_NOT_CONNECTED",
          unityStatus.diagnostic?.message ?? "Unity bridge did not connect.",
        );
      }
      await this.unity.waitForIdle(taskId, {}, signal);
      const client = await this.unity.clientForTask(taskId);
      unitySummary = {
        projectWorktreePath: prepared.projectWorktreePath,
        unityVersion: prepared.unityVersion,
        editorExecutablePath: prepared.editorExecutablePath,
        ...(prepared.bridge.packageVersion === undefined
          ? {}
          : { bridgeVersion: prepared.bridge.packageVersion }),
      };

      await this.progress(taskId, "QA_TEST_STARTED", {
        sessionId: allocation.sessionId,
        testId: baselineCompilationId,
        category: "STATIC",
      });
      const consoleBaseline = await client.console({ limit: 200 }, signal);
      const compilationRequest = await client.requestCompilation(signal);
      if (
        !compilationRequest.requested ||
        compilationRequest.requestId === undefined ||
        compilationRequest.requestId.length === 0
      ) {
        throw new QARunError(
          "STATIC",
          "UNITY_COMPILATION_RESULT_UNAVAILABLE",
          "The Unity bridge did not return an identifiable compilation request.",
        );
      }
      const statusAfterCompilation = await this.waitForCompilation(
        client,
        compilationRequest.requestId,
        signal,
      );
      const consoleAfterCompilation = await client.console({ limit: 200 }, signal);
      const compilation = statusAfterCompilation.lastCompilation;
      if (
        compilation === undefined ||
        compilation.requestId !== compilationRequest.requestId ||
        !compilation.completed
      ) {
        throw new QARunError(
          "STATIC",
          "UNITY_COMPILATION_RESULT_UNAVAILABLE",
          "Unity became idle without a complete matching compilation result.",
        );
      }
      const errors = compilation.messages.filter((message) => message.severity === "error");
      const compilationEvidence = collector.add({
        kind: "COMPILER",
        summary: compilation.errorCount === 0
          ? "Unity compilation completed without newly observed compiler errors."
          : `Unity compilation produced ${compilation.errorCount} compiler error(s).`,
        details: jsonDetails({
          requestId: compilation.requestId,
          requestedAt: compilation.requestedAt,
          completedAt: compilation.completedAt,
          errorCount: compilation.errorCount,
          warningCount: compilation.warningCount,
          messagesTruncated: compilation.messagesTruncated,
          consoleComplete: consoleAfterCompilation.complete,
          baselineCount: consoleBaseline.count,
          observedCount: consoleAfterCompilation.count,
          errors: errors.slice(0, 50).map((entry) => ({
            severity: entry.severity,
            message: entry.message.slice(0, 4_000),
            file: entry.file,
            line: entry.line,
            column: entry.column,
          })),
        }),
      });
      const compilationHasErrors = compilation.errorCount > 0;
      const compilationVerified = !compilationHasErrors;
      const compilationStatus: QATestResult["status"] = compilationHasErrors ? "FAIL" : "PASS";
      const compilationObserved = errors.length > 0
        ? errors.map((entry) => entry.message).join(" | ").slice(0, 20_000)
        : `${compilation.errorCount} compiler error(s) were counted; detailed messages were unavailable or truncated.`;
      results.push({
        testId: baselineCompilationId,
        category: "STATIC",
        status: compilationStatus,
        summary: compilationHasErrors
          ? "Unity compilation failed."
          : "Unity compilation passed.",
        expected: "Unity compilation completes without compiler errors introduced by the task.",
        observed: compilationHasErrors
          ? compilationObserved
          : `Compilation result recorded 0 errors and ${compilation.warningCount} warning(s); general console complete=${String(consoleAfterCompilation.complete)}.`,
        evidence: [compilationEvidence],
        likelyArea: errors.length === 0 ? [] : ["Changed C# scripts", "Unity compilation"],
      });
      if (compilationHasErrors) {
        findings.push({
          id: "FAIL-COMPILATION",
          severity: "blocking",
          title: "Unity compilation failed",
          description: "New compiler errors were observed during the mandatory compilation baseline.",
          relatedAcceptanceCriteria: [],
          relatedTests: [baselineCompilationId],
          reproduction: ["Request Unity script compilation.", "Wait until the Editor is idle.", "Inspect newly emitted error entries."],
          expected: "The project compiles without errors.",
          observed: compilationObserved,
          evidence: [compilationEvidence],
          suspectedArea: ["Changed C# scripts"],
          source: "STATIC",
        });
      }
      await this.progress(taskId, "QA_TEST_COMPLETED", {
        sessionId: allocation.sessionId,
        testId: baselineCompilationId,
        status: compilationStatus,
      });

      const [editorStatus, sceneSummary, hierarchy] = await Promise.all([
        client.editorStatus(signal),
        client.sceneSummary(signal),
        client.sceneHierarchy({ maxDepth: 6, maxObjects: 300 }, signal),
      ]);
      const structuralEvidence = [
        collector.add({ kind: "EDITOR_STATE", summary: "Unity Editor state captured after compilation.", details: jsonDetails(editorStatus) }),
        collector.add({ kind: "SCENE", summary: "Loaded scene summary captured.", details: jsonDetails(sceneSummary) }),
        collector.add({ kind: "HIERARCHY", summary: `Captured ${hierarchy.count} bounded hierarchy object(s).`, details: jsonDetails(hierarchy) }),
      ];

      const runtimeTests = plannedTests.filter((test) => test.category === "RUNTIME");
      let runtimeEvidence: readonly string[] = [];
      if (runtimeTests.length > 0 && !compilationHasErrors) {
        try {
          await client.enterPlayMode(signal);
          const playing = await this.waitForPlayState(client, true, signal);
          const [runtimeConsole, runtimeHierarchy] = await Promise.all([
            client.console({ limit: 200 }, signal),
            client.sceneHierarchy({ maxDepth: 6, maxObjects: 300 }, signal),
          ]);
          runtimeEvidence = [
            collector.add({ kind: "PLAY_MODE", summary: "Unity entered Play Mode for runtime observation.", details: jsonDetails(playing) }),
            collector.add({ kind: "CONSOLE", summary: `Captured ${runtimeConsole.count} bounded runtime console entry/entries.`, details: jsonDetails(runtimeConsole) }),
            collector.add({ kind: "HIERARCHY", summary: `Captured ${runtimeHierarchy.count} runtime hierarchy object(s).`, details: jsonDetails(runtimeHierarchy) }),
          ];
        } finally {
          await this.exitPlayMode(client, signal);
        }
      }

      const gameplayResults: QATestResult[] = plannedTests
        .filter((test) => test.category === "GAMEPLAY")
        .map((test) => ({
          testId: test.id,
          category: "GAMEPLAY",
          status: "NOT_RUN",
          summary: "Player-level gameplay QA is outside M7 capabilities.",
          expected: test.description,
          observed: "No player input was injected or simulated.",
          evidence: [],
          likelyArea: [],
          blockingReason: "REQUIRES_M8_GAMEPLAY_QA",
        }));

      const compileBlockedRuntime: QATestResult[] = compilationHasErrors
        ? runtimeTests.map((test) => ({
            testId: test.id,
            category: "RUNTIME",
            status: "BLOCKED",
            summary: "Runtime test was blocked because Unity compilation failed.",
            expected: test.description,
            observed: "Play Mode was not entered after compilation failure.",
            evidence: [compilationEvidence],
            likelyArea: ["Unity compilation"],
            blockingReason: "COMPILATION_FAILED",
          }))
        : [];

      const testsForAgent = plannedTests.filter((test) =>
        test.source === "CONTRACT" &&
        test.category !== "GAMEPLAY" &&
        !(test.category === "RUNTIME" && compilationHasErrors),
      );
      if (testsForAgent.length > 0) {
        for (const test of testsForAgent) {
          await this.progress(taskId, "QA_TEST_STARTED", {
            sessionId: allocation.sessionId,
            testId: test.id,
            category: test.category,
          });
        }
        const qaPlan = requireEffort(task.taskContract?.executionPlan?.qa as ModelPlan, "AGENT");
        const beforeAgent = await this.targetGuard.capture(gitEnvironment.taskWorktreePath);
        const mcp = createUnityQAMcpConfiguration(
          gitEnvironment.taskWorktreePath,
          this.unityMcpEntrypoint,
        );
        let execution: AIExecutionResult;
        try {
          execution = await this.ai.executePlanned(
            {
              agentId: "qa",
              modelId: qaPlan.modelId,
              effort: qaPlan.effort,
              workingDirectory: gitEnvironment.taskWorktreePath,
              input: JSON.stringify({
                taskId,
                originalRequest: task.originalRequest,
                approvedTaskContract: task.taskContract,
                feasibility: analysis?.feasibility?.result,
                implementation: orchestration.implementation,
                implementationCheckpoint: orchestration.implementation === undefined
                  ? undefined
                  : {
                      id: orchestration.implementation.checkpointId,
                      commit: orchestration.implementation.checkpointCommit,
                    },
                review: orchestration.review,
                git: {
                  baseCommit: gitDiff.baseCommit,
                  headCommit: gitDiff.headCommit,
                  changedFiles: productChangedFiles,
                  summary: gitDiff.summary,
                  diff: gitDiff.diff.slice(0, 120_000),
                  diffTruncated: gitDiff.diff.length > 120_000,
                },
                testsToExecute: testsForAgent,
                deterministicPreflight: {
                  compilationPassed: compilationVerified,
                  compilationHadErrors: compilationHasErrors,
                  evidence: collector.values,
                  structuralEvidence,
                  runtimeEvidence,
                  runtimeBlockedByCompilation: compilationHasErrors,
                  consoleCaptureComplete: consoleAfterCompilation.complete,
                },
              }),
              context:
                "Complete every supplied M7-supported test before returning one batch. Use only read-only repository access and the explicit Unity MCP tools. Never modify files, never fix code, and never claim GAMEPLAY tests passed.",
            },
            qaPlan,
            signal,
            { mcpServers: [mcp] },
          );
        } finally {
          await this.exitPlayMode(client, signal).catch(() => undefined);
        }
        requireSuccessfulExecution(execution, "AGENT");
        qaAgentRunId = execution.runId;
        if (
          execution.providerId !== qaPlan.providerId ||
          execution.modelId !== qaPlan.modelId ||
          execution.effort !== qaPlan.effort
        ) {
          throw new QARunError("AGENT", "ROUTING_SNAPSHOT_MISMATCH", "QA execution did not match the approved routing snapshot.", execution.runId);
        }
        const output = parseQAAgentOutput(execution.structuredOutput);
        const expectedIds = new Set(testsForAgent.map((test) => test.id));
        const returnedIds = new Set(output.results.map((result) => result.testId));
        if (
          expectedIds.size !== returnedIds.size ||
          [...expectedIds].some((id) => !returnedIds.has(id)) ||
          output.results.some((result) => {
            const planned = testsForAgent.find((test) => test.id === result.testId);
            return planned === undefined || planned.category !== result.category;
          })
        ) {
          throw new QARunError(
            "AGENT",
            "INVALID_QA_OUTPUT",
            "QA Agent did not return exactly one correctly categorized result for every supplied test.",
            execution.runId,
          );
        }
        for (const agentResult of output.results) {
          const evidence = agentResult.evidence.map((entry) => collector.add(entry));
          results.push({
            ...agentResult,
            evidence,
          });
          await this.progress(taskId, "QA_TEST_COMPLETED", {
            sessionId: allocation.sessionId,
            testId: agentResult.testId,
            status: agentResult.status,
          });
        }
        for (const agentFinding of output.findings) {
          findings.push({
            ...agentFinding,
            evidence: agentFinding.evidence.map((entry) => collector.add(entry)),
          });
        }
        const afterAgent = await this.targetGuard.capture(gitEnvironment.taskWorktreePath);
        try {
          this.targetGuard.assertUnchanged(beforeAgent, afterAgent);
        } catch (error: unknown) {
          throw new QARunError(
            "AGENT",
            "QA_READ_ONLY_VIOLATION",
            error instanceof Error ? error.message : "QA Agent modified the managed worktree.",
            execution.runId,
          );
        }
      }

      results.push(...compileBlockedRuntime, ...gameplayResults);
      const orderedResults = plannedTests.map((planned) => {
        const result = results.find((candidate) => candidate.testId === planned.id);
        if (result === undefined) {
          throw new QARunError(
            "AGENT",
            "INVALID_QA_OUTPUT",
            `No QA result was produced for ${planned.id}.`,
            qaAgentRunId,
          );
        }
        return result;
      });

      for (const failed of orderedResults.filter((result) => result.status === "FAIL")) {
        if (!findings.some((finding) => finding.relatedTests.includes(failed.testId))) {
          findings.push({
            id: `FAIL-${failed.testId.replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-|-$/gu, "")}`,
            severity: "blocking",
            title: failed.summary,
            description: `Required test ${failed.testId} failed.`,
            relatedAcceptanceCriteria: [],
            relatedTests: [failed.testId],
            reproduction: ["Repeat the evidence-backed planned test."],
            expected: failed.expected,
            observed: failed.observed,
            evidence: failed.evidence,
            suspectedArea: failed.likelyArea,
            source: failed.category === "GAMEPLAY" ? "RUNTIME" : failed.category,
          });
        }
      }

      const hasM7Failure = orderedResults.some((result) =>
        result.category !== "GAMEPLAY" && result.status !== "PASS",
      );
      const gameplayPending = orderedResults.some((result) =>
        result.category === "GAMEPLAY" && result.status === "NOT_RUN",
      );
      const status: QASession["status"] = hasM7Failure
        ? "FAIL"
        : gameplayPending
          ? "INCOMPLETE_GAMEPLAY"
          : "PASS";
      const completedAt = now();
      const summary = summarize(
        orderedResults,
        status === "PASS"
          ? "All required M7 QA tests passed."
          : status === "INCOMPLETE_GAMEPLAY"
            ? "Static, structural, and runtime QA passed; required gameplay tests remain for M8."
            : "The complete available QA session found one or more failures or blockers.",
      );
      const session = parseQASession({
        schemaVersion: 1,
        sessionId: allocation.sessionId,
        taskId,
        cycleNumber: allocation.cycleNumber,
        startedAt,
        completedAt,
        status,
        plannedTests,
        results: orderedResults,
        findings,
        blockedTests: orderedResults.filter((result) => result.status === "BLOCKED").map((result) => result.testId),
        evidence: collector.values,
        ...(unitySummary === undefined ? {} : { unityEnvironment: unitySummary }),
        ...(qaAgentRunId === undefined ? {} : { qaAgentRunId }),
        summary,
      });
      const report = reportFromSession(session);
      await Promise.all([
        this.artifacts.saveSession(taskId, session),
        this.artifacts.saveReport(taskId, report),
      ]);
      return { session, report };
    } catch (error: unknown) {
      const failure = technicalFailure(error, "PREFLIGHT");
      const completedAt = now();
      const session = parseQASession({
        schemaVersion: 1,
        sessionId: allocation.sessionId,
        taskId,
        cycleNumber: allocation.cycleNumber,
        startedAt,
        completedAt,
        status: "TECHNICAL_FAILURE",
        plannedTests,
        results,
        findings,
        blockedTests: results.filter((result) => result.status === "BLOCKED").map((result) => result.testId),
        evidence: collector.values,
        ...(unitySummary === undefined ? {} : { unityEnvironment: unitySummary }),
        ...(qaAgentRunId === undefined ? {} : { qaAgentRunId }),
        summary: summarize(results, `QA stopped because of a technical failure: ${failure.message}`),
        technicalFailure: failure,
      });
      const report = reportFromSession(session);
      await Promise.all([
        this.artifacts.saveSession(taskId, session),
        this.artifacts.saveReport(taskId, report),
      ]);
      return { session, report };
    }
  }

  private async runFix(
    taskId: TaskId,
    report: QAReport,
    automatic: boolean,
    signal: AbortSignal,
  ): Promise<CycleAllocation> {
    const fixNumber = await this.artifacts.nextFixNumber(taskId);
    let task = await this.tasks.get(taskId);
    task = beginTaskFix(task, {
      sourceSessionId: report.sessionId,
      fixNumber,
      automatic,
    });
    await this.tasks.saveTask(task);
    try {
      const contract = task.taskContract;
      const routing = contract?.executionPlan;
      if (routing === undefined) {
        throw new QARunError("FIX", "ROUTING_SNAPSHOT_INVALID", "Fix requires the approved routing snapshot.");
      }
      const implementation = requireEffort(routing.implementation, "FIX");
      const fix = requireEffort(routing.fix.plan, "FIX");
      if (
        !routing.fix.enabled ||
        implementation.providerId !== fix.providerId ||
        implementation.modelId !== fix.modelId ||
        implementation.providerModelName !== fix.providerModelName ||
        implementation.effort !== fix.effort
      ) {
        throw new QARunError("FIX", "FIX_ROUTING_MISMATCH", "Fix route must exactly match the approved implementation route.");
      }
      const { environment } = await this.git.getEnvironmentWithStatus(taskId);
      if (environment === undefined || environment.status !== "ACTIVE") {
        throw new QARunError("FIX", "GIT_ENVIRONMENT_MISMATCH", "Fix requires the active managed task worktree.");
      }
      await this.removeUnityToolingForCheckpoint(taskId, environment.taskWorktreePath, signal);
      const [analysis, orchestration, beforeStatus, beforeDiff] = await Promise.all([
        this.analysis.get(taskId),
        this.orchestration.get(taskId),
        this.git.status(taskId),
        this.git.diff(taskId),
      ]);
      const execution = await this.ai.executePlanned(
        {
          agentId: "fix",
          modelId: fix.modelId,
          effort: fix.effort,
          workingDirectory: environment.taskWorktreePath,
          input: JSON.stringify({
            taskId,
            originalRequest: task.originalRequest,
            approvedTaskContract: contract,
            feasibility: analysis?.feasibility?.result,
            implementation: orchestration.implementation,
            implementationCheckpoint: orchestration.implementation === undefined
              ? undefined
              : {
                  id: orchestration.implementation.checkpointId,
                  commit: orchestration.implementation.checkpointCommit,
                },
            review: orchestration.review,
            completeQABatch: report,
            git: {
              headCommit: beforeStatus.headCommit,
              changedFiles: beforeDiff.changedFiles.filter((path) => !isToolingPath(path)),
              summary: beforeDiff.summary,
              diff: beforeDiff.diff.slice(0, 120_000),
              diffTruncated: beforeDiff.diff.length > 120_000,
            },
          }),
          context:
            "Fix the complete verified QA batch only. Do not alter the contract or routing, and do not stage, commit, reset, clean, finalize, merge, push, or perform authoritative QA.",
        },
        fix,
        signal,
      );
      requireSuccessfulExecution(execution, "FIX");
      if (
        execution.providerId !== implementation.providerId ||
        execution.modelId !== implementation.modelId ||
        execution.effort !== implementation.effort
      ) {
        throw new QARunError("FIX", "FIX_ROUTING_MISMATCH", "Fix execution did not use the exact implementation route.", execution.runId);
      }
      const output = parseFixAgentOutput(execution.structuredOutput);
      const afterStatus = await this.git.status(taskId);
      if (afterStatus.headCommit !== beforeStatus.headCommit) {
        throw new QARunError("FIX", "FIX_GIT_STATE_INVALID", "Fix Agent changed Git history instead of leaving changes for UnityAI checkpointing.", execution.runId);
      }
      const changed = [...afterStatus.stagedFiles, ...afterStatus.unstagedFiles, ...afterStatus.untrackedFiles]
        .filter((path) => !isToolingPath(path));
      if (changed.length === 0) {
        throw new QARunError("FIX", "FIX_NO_CHANGES", "Fix Agent reported success but produced no checkpointable product changes.", execution.runId);
      }
      const checkpoint = await this.git.checkpoint(taskId, { label: `fix-${fixNumber}` });
      const result: FixResult = {
        schemaVersion: 1,
        ...output,
        changedFiles: [...new Set(changed)].sort((left, right) => left.localeCompare(right)),
        fixId: `FIX-${String(fixNumber).padStart(3, "0")}`,
        taskId,
        sourceSessionId: report.sessionId,
        automatic,
        runId: execution.runId,
        providerId: execution.providerId,
        modelId: execution.modelId,
        effort: execution.effort,
        route: fix,
        status: "SUCCEEDED",
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        checkpointId: checkpoint.checkpoint.id,
        checkpointCommit: checkpoint.checkpoint.commit,
      };
      await this.artifacts.saveFix(taskId, result);
      const allocation = await this.artifacts.nextCycle(taskId);
      task = completeTaskFixAndRestartQA(await this.tasks.get(taskId), {
        fixId: result.fixId,
        runId: result.runId,
        checkpointId: result.checkpointId,
        checkpointCommit: result.checkpointCommit,
        nextSessionId: allocation.sessionId,
        nextCycleNumber: allocation.cycleNumber,
      });
      await this.tasks.saveTask(task);
      return allocation;
    } catch (error: unknown) {
      const failure = technicalFailure(error, "FIX");
      await this.artifacts.saveFailure(taskId, failure);
      const current = await this.tasks.get(taskId);
      if (current.state === "FIXING") {
        await this.tasks.saveTask(failTaskFix(current, failure, report.sessionId));
      }
      throw error;
    }
  }

  private async finalizeSuccessfulTask(
    taskId: TaskId,
    cycle: CycleResult,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const task = await this.tasks.get(taskId);
      if (task.state !== "TESTING" || cycle.session.summary.gameplayPending > 0) {
        throw new QARunError("FINALIZATION", "FINALIZATION_NOT_ALLOWED", "Task is not eligible for M7 finalization.");
      }
      const { environment } = await this.git.getEnvironmentWithStatus(taskId);
      if (environment === undefined || environment.status !== "ACTIVE") {
        throw new QARunError("FINALIZATION", "GIT_ENVIRONMENT_MISMATCH", "Finalization requires the active managed task worktree.");
      }
      await this.leavePlayModeAndStopOwnedEditor(taskId, signal, true);
      const beforeRemoval = await this.unity.status(taskId);
      if (beforeRemoval.bridge !== "NOT_INSTALLED") {
        await this.unity.removeBridge(taskId);
      }
      const afterRemoval = await this.unity.status(taskId);
      if (afterRemoval.bridge !== "NOT_INSTALLED") {
        throw new QARunError("FINALIZATION", "UNITY_BRIDGE_OWNERSHIP_MISMATCH", "Temporary UnityAI bridge tooling could not be removed.");
      }
      const bridgePath = join(environment.taskWorktreePath, ...unityToolingPrefix.split("/"));
      if (await pathExists(bridgePath)) {
        throw new QARunError("FINALIZATION", "UNITY_BRIDGE_OWNERSHIP_MISMATCH", "Temporary UnityAI bridge files remain in the managed worktree.");
      }
      const finalDiff = await this.git.diff(taskId);
      if (finalDiff.changedFiles.some(isToolingPath)) {
        throw new QARunError("FINALIZATION", "UNITY_TOOLING_IN_FINAL_DIFF", "Temporary UnityAI bridge tooling remains in the final product diff.");
      }
      if (finalDiff.changedFiles.length === 0) {
        throw new QARunError("FINALIZATION", "NOTHING_TO_FINALIZE", "No meaningful task changes remain after tooling cleanup.");
      }
      const finalized = await this.git.finalize(taskId, {
        commitMessage: commitMessageFor(task),
      });
      if (finalized.finalCommit === undefined || finalized.status !== "FINALIZED") {
        throw new QARunError("FINALIZATION", "GIT_ENVIRONMENT_MISMATCH", "M2 did not return a finalized task commit.");
      }
      await this.tasks.saveTask(completeTaskQAAndFinalize(await this.tasks.get(taskId), {
        sessionId: cycle.session.sessionId,
        finalCommit: finalized.finalCommit,
        taskBranch: finalized.taskBranch,
      }));
    } catch (error: unknown) {
      const failure = technicalFailure(error, "FINALIZATION");
      const failedSession = parseQASession({
        ...cycle.session,
        status: "TECHNICAL_FAILURE",
        completedAt: now(),
        summary: {
          ...cycle.session.summary,
          text: `QA tests passed, but safe finalization failed: ${failure.message}`,
        },
        technicalFailure: failure,
      });
      const report = reportFromSession(failedSession);
      await Promise.all([
        this.artifacts.saveSession(taskId, failedSession),
        this.artifacts.saveReport(taskId, report),
        this.artifacts.saveFailure(taskId, failure),
      ]);
      await this.failCurrentTask(taskId, failure, cycle.session.sessionId);
    }
  }

  private async leavePlayModeAndStopOwnedEditor(
    taskId: TaskId,
    signal: AbortSignal,
    requireStopped: boolean,
  ): Promise<void> {
    const status = await this.unity.status(taskId);
    if (status.bridge === "CONNECTED") {
      const client = await this.unity.clientForTask(taskId);
      await this.exitPlayMode(client, signal);
    }
    const refreshed = await this.unity.status(taskId);
    if (refreshed.editor === "RUNNING") {
      if (!refreshed.ownedEditor) {
        if (requireStopped) {
          throw new QARunError(
            "FINALIZATION",
            "EDITOR_NOT_OWNED",
            "A non-owned Unity Editor is still running; UnityAI will not stop it or remove tooling beneath it.",
          );
        }
        return;
      }
      await this.unity.stopEditor(taskId);
    }
  }

  private async removeUnityToolingForCheckpoint(
    taskId: TaskId,
    worktreePath: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.leavePlayModeAndStopOwnedEditor(taskId, signal, true);
    const status = await this.unity.status(taskId);
    if (status.bridge !== "NOT_INSTALLED") {
      await this.unity.removeBridge(taskId);
    }
    const bridgePath = join(worktreePath, ...unityToolingPrefix.split("/"));
    const [afterRemoval, diff] = await Promise.all([
      this.unity.status(taskId),
      this.git.diff(taskId),
    ]);
    if (
      afterRemoval.bridge !== "NOT_INSTALLED" ||
      await pathExists(bridgePath) ||
      diff.changedFiles.some(isToolingPath)
    ) {
      throw new QARunError(
        "FIX",
        "UNITY_TOOLING_IN_CHECKPOINT",
        "Temporary UnityAI bridge tooling could not be excluded from the fix checkpoint.",
      );
    }
  }

  private async exitPlayMode(client: UnityBridgeClient, signal: AbortSignal): Promise<void> {
    const status = await this.waitForResponsiveStatus(client, signal);
    if (!status.isPlaying) {
      return;
    }
    await client.exitPlayMode(signal);
    await this.waitForPlayState(client, false, signal);
  }

  private async waitForPlayState(
    client: UnityBridgeClient,
    expected: boolean,
    signal: AbortSignal,
  ): Promise<UnityEditorStatus> {
    const deadline = Date.now() + this.playModeTimeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) {
        throw new QARunError("RUNTIME", "EXECUTION_CANCELLED", "QA execution was cancelled.");
      }
      try {
        const status = await client.editorStatus(signal);
        if (status.isPlaying === expected && !status.isCompiling && !status.isUpdating) {
          return status;
        }
      } catch (error: unknown) {
        if (
          !(error instanceof UnityIntegrationError) ||
          (error.code !== "UNITY_BRIDGE_NOT_CONNECTED" && error.code !== "UNITY_BRIDGE_TIMEOUT")
        ) {
          throw error;
        }
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 200));
    }
    throw new QARunError(
      "RUNTIME",
      "UNITY_BRIDGE_TIMEOUT",
      `Unity did not ${expected ? "enter" : "exit"} Play Mode within ${this.playModeTimeoutMs} ms.`,
    );
  }

  private async waitForCompilation(
    client: UnityBridgeClient,
    requestId: string,
    signal: AbortSignal,
  ): Promise<UnityEditorStatus> {
    const deadline = Date.now() + this.compilationTimeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) {
        throw new QARunError("STATIC", "EXECUTION_CANCELLED", "QA compilation was cancelled.");
      }
      try {
        const status = await client.editorStatus(signal);
        if (
          !status.isCompiling &&
          !status.isUpdating &&
          status.lastCompilation?.requestId === requestId &&
          status.lastCompilation.completed
        ) {
          return status;
        }
      } catch (error: unknown) {
        if (
          !(error instanceof UnityIntegrationError) ||
          (error.code !== "UNITY_BRIDGE_NOT_CONNECTED" && error.code !== "UNITY_BRIDGE_TIMEOUT")
        ) {
          throw error;
        }
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 300));
    }
    throw new QARunError(
      "STATIC",
      "UNITY_COMPILATION_RESULT_UNAVAILABLE",
      `Unity did not publish a complete compilation result within ${this.compilationTimeoutMs} ms.`,
    );
  }

  private async waitForResponsiveStatus(
    client: UnityBridgeClient,
    signal: AbortSignal,
  ): Promise<UnityEditorStatus> {
    const deadline = Date.now() + this.playModeTimeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) {
        throw new QARunError("RUNTIME", "EXECUTION_CANCELLED", "QA execution was cancelled.");
      }
      try {
        return await client.editorStatus(signal);
      } catch (error: unknown) {
        if (
          !(error instanceof UnityIntegrationError) ||
          (error.code !== "UNITY_BRIDGE_NOT_CONNECTED" && error.code !== "UNITY_BRIDGE_TIMEOUT")
        ) {
          throw error;
        }
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 200));
    }
    throw new QARunError(
      "RUNTIME",
      "UNITY_BRIDGE_TIMEOUT",
      `Unity bridge did not become responsive within ${this.playModeTimeoutMs} ms.`,
    );
  }

  private async progress(
    taskId: TaskId,
    type: "QA_TEST_STARTED" | "QA_TEST_COMPLETED",
    metadata: Readonly<Record<string, string>>,
  ): Promise<void> {
    const task = await this.tasks.get(taskId);
    if (task.state === "TESTING") {
      await this.tasks.saveTask(recordTaskQAProgress(task, type, metadata));
    }
  }

  private async failCurrentTask(
    taskId: TaskId,
    failure: QATechnicalFailure,
    sessionId: string,
  ): Promise<void> {
    const current = await this.tasks.get(taskId);
    if (current.state === "TESTING" || current.state === "FIXING") {
      await this.tasks.saveTask(failTaskQA(current, failure, sessionId));
    } else if (
      current.state === "PAUSED" &&
      (current.pause?.previousState === "TESTING" || current.pause?.previousState === "FIXING")
    ) {
      await this.tasks.saveTask(markPausedQAInterrupted(current, failure));
    }
  }

  private async handleUncaught(taskId: TaskId, error: unknown): Promise<void> {
    const failure = technicalFailure(error, "PREFLIGHT");
    await this.artifacts.saveFailure(taskId, failure).catch(() => undefined);
    const qa = await this.artifacts.get(taskId).catch(() => undefined);
    await this.failCurrentTask(
      taskId,
      failure,
      qa?.latestSession?.sessionId ?? `QA-FAILED-${taskId}`,
    ).catch(() => undefined);
    try {
      const status: UnityTaskEnvironmentStatus = await this.unity.status(taskId);
      if (status.bridge === "CONNECTED") {
        const client = await this.unity.clientForTask(taskId);
        await this.exitPlayMode(client, new AbortController().signal).catch(() => undefined);
      }
    } catch {
      // Best-effort Play Mode cleanup must not hide the original failure.
    }
  }
}
