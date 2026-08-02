import type {
  AcceptanceCriterion,
  ExecutionRoutingSnapshot,
  PlannedTestRequirement,
  TaskAnalysisFailure,
  TaskAnalysisSummary,
} from "./analysisTypes.js";
import type { TaskExecutionFailure } from "./orchestrationTypes.js";

export const TASK_STATES = [
  "DRAFT",
  "CREATED",
  "ANALYZING",
  "WAITING_FOR_APPROVAL",
  "BLOCKED",
  "PAUSED",
  "READY_FOR_IMPLEMENTATION",
  "IMPLEMENTING",
  "REVIEWING",
  "READY_FOR_QA",
  "TESTING",
  "READY_FOR_GAMEPLAY_QA",
  "FAILED",
  "FIXING",
  "COMPLETED",
  "CANCELLED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TASK_STRENGTHS = ["LIGHT", "STANDARD", "STRONG"] as const;

export type TaskStrength = (typeof TASK_STRENGTHS)[number];

export const FEASIBILITY_STATUSES = [
  "READY",
  "AUTO_FIXABLE",
  "BLOCKED_ARCHITECTURE",
  "BLOCKED_USER",
] as const;

export type FeasibilityStatus = (typeof FEASIBILITY_STATUSES)[number];

export const TASK_EVENT_TYPES = [
  "TASK_DRAFT_CREATED",
  "TASK_CREATED",
  "DRAFT_UPDATED",
  "STATE_CHANGED",
  "FEASIBILITY_RECORDED",
  "CONTRACT_STORED",
  "CONTRACT_APPROVED",
  "CONTRACT_UPDATED",
  "ANALYSIS_COMPLETED",
  "ANALYSIS_FAILED",
  "TASK_PAUSED",
  "TASK_RESUMED",
  "TASK_CANCELLED",
  "RECHECK_REQUESTED",
  "PREREQUISITE_DRAFT_CREATED",
  "GIT_ENVIRONMENT_PREPARED",
  "IMPLEMENTATION_STARTED",
  "IMPLEMENTATION_COMPLETED",
  "IMPLEMENTATION_CHECKPOINT_CREATED",
  "IMPLEMENTATION_FAILED",
  "REVIEW_STARTED",
  "REVIEW_COMPLETED",
  "REVIEW_FAILED",
  "READY_FOR_QA",
  "ORCHESTRATION_INTERRUPTED",
  "QA_STARTED",
  "QA_TEST_STARTED",
  "QA_TEST_COMPLETED",
  "QA_CYCLE_COMPLETED",
  "QA_FAILED",
  "QA_GAMEPLAY_PENDING",
  "FIX_STARTED",
  "FIX_COMPLETED",
  "FIX_CHECKPOINT_CREATED",
  "QA_RESTARTED",
  "QA_PASSED",
  "UNITY_TOOLING_REMOVED",
  "TASK_FINALIZED",
] as const;

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export type TaskId = `TASK-${string}`;

export interface TaskSettings {
  readonly crossReviewEnabled: boolean;
  readonly automaticFixesEnabled: boolean;
}

export interface FeasibilityResult {
  readonly status: FeasibilityStatus;
  readonly summary: string;
  readonly missingCapabilities: readonly string[];
  readonly suggestedPrerequisite?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface TaskContractInput {
  readonly originalTaskSummary?: string;
  readonly understoodExplicitRequirements: readonly string[];
  readonly inferredRequirements: readonly string[];
  readonly prerequisites: readonly string[];
  readonly implementationScope: readonly string[];
  readonly nonGoals?: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly testRequirements: readonly string[];
  readonly taskStrength?: TaskStrength;
  readonly executionPlan?: ExecutionRoutingSnapshot;
  readonly acceptanceCriteriaDetails?: readonly AcceptanceCriterion[];
  readonly testRequirementDetails?: readonly PlannedTestRequirement[];
}

export interface TaskContract {
  readonly originalTaskSummary?: string;
  readonly understoodExplicitRequirements: readonly string[];
  readonly inferredRequirements: readonly string[];
  readonly prerequisites: readonly string[];
  readonly implementationScope: readonly string[];
  readonly nonGoals: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly testRequirements: readonly string[];
  readonly taskStrength?: TaskStrength;
  readonly executionPlan?: ExecutionRoutingSnapshot;
  readonly acceptanceCriteriaDetails?: readonly AcceptanceCriterion[];
  readonly testRequirementDetails?: readonly PlannedTestRequirement[];
  readonly approved: boolean;
  readonly approvedAt?: string;
}

export interface PauseInfo {
  readonly pausedAt: string;
  readonly previousState: Exclude<TaskState, "PAUSED">;
  readonly reason?: string;
}

export interface CancellationInfo {
  readonly cancelledAt: string;
  readonly reason?: string;
}

export interface TaskEvent {
  readonly timestamp: string;
  readonly type: TaskEventType;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface Task {
  readonly id: TaskId;
  readonly title?: string;
  readonly originalRequest: string;
  readonly targetProjectPath?: string;
  readonly strength: TaskStrength;
  readonly state: TaskState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly crossReviewEnabled: boolean;
  readonly automaticFixesEnabled: boolean;
  readonly feasibility?: FeasibilityResult;
  readonly taskContract?: TaskContract;
  readonly analysis?: TaskAnalysisSummary;
  readonly analysisFailure?: TaskAnalysisFailure;
  readonly executionFailure?: TaskExecutionFailure;
  readonly pause?: PauseInfo;
  readonly cancellation?: CancellationInfo;
  readonly originTaskId?: TaskId;
  readonly prerequisiteDraftIds: readonly TaskId[];
  readonly events: readonly TaskEvent[];
}

export interface CreateTaskInput {
  readonly title?: string;
  readonly originalRequest: string;
  readonly targetProjectPath?: string;
  readonly strength?: TaskStrength;
  readonly crossReviewEnabled?: boolean;
  readonly automaticFixesEnabled?: boolean;
}

export interface TaskContractPatch {
  readonly understoodExplicitRequirements?: readonly string[];
  readonly inferredRequirements?: readonly string[];
  readonly prerequisites?: readonly string[];
  readonly implementationScope?: readonly string[];
  readonly nonGoals?: readonly string[];
  readonly acceptanceCriteriaDetails?: readonly AcceptanceCriterion[];
  readonly testRequirementDetails?: readonly PlannedTestRequirement[];
}

export interface DraftTaskPatch {
  title?: string | null;
  originalRequest?: string;
  targetProjectPath?: string | null;
  strength?: TaskStrength;
  crossReviewEnabled?: boolean;
  automaticFixesEnabled?: boolean;
}

export interface PrerequisiteDraftResult {
  readonly parentTask: Task;
  readonly prerequisiteDraft: Task;
}
