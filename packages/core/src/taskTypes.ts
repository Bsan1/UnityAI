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
  "TESTING",
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
  "TASK_PAUSED",
  "TASK_RESUMED",
  "TASK_CANCELLED",
  "RECHECK_REQUESTED",
  "PREREQUISITE_DRAFT_CREATED",
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
  readonly understoodExplicitRequirements: readonly string[];
  readonly inferredRequirements: readonly string[];
  readonly prerequisites: readonly string[];
  readonly implementationScope: readonly string[];
  readonly nonGoals?: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly testRequirements: readonly string[];
}

export interface TaskContract {
  readonly understoodExplicitRequirements: readonly string[];
  readonly inferredRequirements: readonly string[];
  readonly prerequisites: readonly string[];
  readonly implementationScope: readonly string[];
  readonly nonGoals: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly testRequirements: readonly string[];
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
  readonly strength: TaskStrength;
  readonly crossReviewEnabled?: boolean;
  readonly automaticFixesEnabled?: boolean;
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
