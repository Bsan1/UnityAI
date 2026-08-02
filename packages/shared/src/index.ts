import type {
  GitTaskEnvironment,
  ImplementationResult,
  ReviewResult,
  Task,
  TaskAnalysisArtifacts,
  TaskEvent,
  TaskExecutionFailure,
  TaskSettings,
  TaskQAArtifacts,
  QATechnicalFailure,
} from "@unityai/core";
import type {
  UnityEditorStatus,
  UnityProjectMetadata,
} from "@unityai/unity";

export type {
  UnityEditorStatus,
  UnityProjectMetadata,
} from "@unityai/unity";

export type {
  AcceptanceCriterion,
  AnalysisFeasibilityResult,
  ExecutionRoutingSnapshot,
  FeasibilityArtifact,
  GitTaskEnvironment,
  ImplementationResult,
  InterpretationArtifact,
  PlannedTestRequirement,
  ReviewFinding,
  ReviewResult,
  Task,
  TaskAnalysisArtifacts,
  TaskContract,
  TaskEvent,
  TaskExecutionFailure,
  TaskSettings,
  TaskState,
  TaskQAArtifacts,
  FixResult,
  QAEvidence,
  QAFinding,
  QAPlannedTest,
  QAReport,
  QASession,
  QATechnicalFailure,
  QATestResult,
} from "@unityai/core";

export interface HealthResponse {
  readonly status: "ok";
  readonly app: string;
  readonly version: string;
  readonly milestone: string;
}

export interface ProjectRecord {
  readonly id: string;
  readonly displayName: string;
  readonly path: string;
  readonly unityEditorPath?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt?: string;
}

export interface UnityProjectInspectionResponse {
  readonly projectId: string;
  readonly metadata: UnityProjectMetadata;
  readonly editor:
    | {
        readonly found: true;
        readonly requestedVersion: string;
        readonly executablePath: string;
        readonly resolutionMethod: string;
      }
    | {
        readonly found: false;
        readonly requestedVersion: string;
        readonly error: { readonly code: string; readonly message: string };
      };
}

export interface UnityTaskEnvironmentView {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly projectWorktreePath: string;
  readonly unityVersion: string;
  readonly editorExecutablePath: string;
  readonly editorResolutionMethod: string;
  readonly bridge: {
    readonly installed: boolean;
    readonly packagePath?: string;
    readonly packageVersion?: string;
    readonly sourceFingerprint?: string;
    readonly installedAt?: string;
    readonly removedAt?: string;
  };
  readonly editorLaunch?: {
    readonly processId: number;
    readonly launchId: string;
    readonly launchedAt: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UnityTaskStatusResponse {
  readonly environment?: UnityTaskEnvironmentView;
  readonly bridge: "NOT_INSTALLED" | "INSTALLED" | "CONNECTED" | "STALE";
  readonly editor: "STOPPED" | "RUNNING" | "DISCONNECTED";
  readonly ownedEditor: boolean;
  readonly editorStatus?: UnityEditorStatus;
  readonly diagnostic?: { readonly code: string; readonly message: string };
}

export type ProgressStepStatus =
  | "COMPLETE"
  | "CURRENT"
  | "PENDING"
  | "SKIPPED"
  | "FAILED";

export interface ProgressStep {
  readonly id: string;
  readonly label: string;
  readonly status: ProgressStepStatus;
}

export interface TaskProgress {
  readonly taskId: string;
  readonly state: Task["state"];
  readonly active: boolean;
  readonly steps: readonly ProgressStep[];
  readonly events: readonly TaskEvent[];
  readonly failure?: TaskExecutionFailure;
  readonly qaFailure?: QATechnicalFailure;
  readonly qaCycle?: number;
  readonly qaSummary?: {
    readonly passed: number;
    readonly failed: number;
    readonly blocked: number;
    readonly gameplayPending: number;
  };
  readonly reviewFindingCount: number;
}

export interface GitStatusResponse {
  readonly branch: string;
  readonly headCommit: string;
  readonly isClean: boolean;
  readonly changedFiles: readonly string[];
  readonly stagedFiles: readonly string[];
  readonly unstagedFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
}

export interface GitDiffResponse {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly changedFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly summary: string;
  readonly diff: string;
}

export interface OrchestrationGitSnapshot {
  readonly schemaVersion: 1;
  readonly branch: string;
  readonly headCommit: string;
  readonly isClean: boolean;
  readonly changedFiles: readonly string[];
  readonly stagedFiles: readonly string[];
  readonly unstagedFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly diffSummary: string;
  readonly recordedAt: string;
}

export interface TaskDetailsResponse {
  readonly task: Task;
  readonly project?: ProjectRecord;
  readonly analysis?: TaskAnalysisArtifacts;
  readonly git: {
    readonly environment?: GitTaskEnvironment;
    readonly status?: GitStatusResponse;
    readonly diff?: GitDiffResponse;
  };
  readonly orchestration: {
    readonly implementation?: ImplementationResult;
    readonly review?: ReviewResult;
    readonly gitSnapshot?: OrchestrationGitSnapshot;
    readonly failure?: TaskExecutionFailure;
  };
  readonly qa: TaskQAArtifacts;
  readonly progress: TaskProgress;
  readonly blockedActions: readonly string[];
}

export interface ApiErrorPayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export interface GlobalSettings extends TaskSettings {}
