import type { JsonValue, ReasoningEffort } from "./aiTypes.js";
import type { ModelPlan, TestCategory } from "./analysisTypes.js";
import type { TaskId } from "./taskTypes.js";

export const QA_EXECUTABLE_CATEGORIES = [
  "STATIC",
  "STRUCTURAL",
  "RUNTIME",
  "GAMEPLAY",
] as const;

export type QAExecutableCategory = (typeof QA_EXECUTABLE_CATEGORIES)[number];

export const QA_TEST_STATUSES = ["PASS", "FAIL", "BLOCKED", "NOT_RUN"] as const;
export type QATestStatus = (typeof QA_TEST_STATUSES)[number];

export const QA_SESSION_STATUSES = [
  "RUNNING",
  "PASS",
  "FAIL",
  "INCOMPLETE_GAMEPLAY",
  "TECHNICAL_FAILURE",
] as const;
export type QASessionStatus = (typeof QA_SESSION_STATUSES)[number];

export const QA_EVIDENCE_KINDS = [
  "COMPILER",
  "CONSOLE",
  "GIT_DIFF",
  "FILE",
  "SCENE",
  "HIERARCHY",
  "OBJECT",
  "EDITOR_STATE",
  "PLAY_MODE",
  "INPUT",
  "SCREENSHOT",
  "PROBE",
  "MCP",
  "REVIEW",
] as const;
export type QAEvidenceKind = (typeof QA_EVIDENCE_KINDS)[number];

export const QA_FINDING_SEVERITIES = ["info", "warning", "blocking"] as const;
export type QAFindingSeverity = (typeof QA_FINDING_SEVERITIES)[number];

export const QA_FINDING_SOURCES = [
  "STATIC",
  "STRUCTURAL",
  "RUNTIME",
  "GAMEPLAY",
  "REVIEW",
] as const;
export type QAFindingSource = (typeof QA_FINDING_SOURCES)[number];

export interface QAPlannedTest {
  readonly id: string;
  readonly category: TestCategory;
  readonly description: string;
  readonly required: true;
  readonly source: "BASELINE" | "CONTRACT";
}

export interface QAEvidenceInput {
  readonly kind: QAEvidenceKind;
  readonly summary: string;
  readonly reference?: string;
  readonly details?: JsonValue;
}

export interface QAEvidence extends QAEvidenceInput {
  readonly id: string;
  readonly capturedAt: string;
}

export interface QAAgentTestResult {
  readonly testId: string;
  readonly category: QAExecutableCategory;
  readonly status: QATestStatus;
  readonly summary: string;
  readonly expected: string;
  readonly observed: string;
  readonly evidence: readonly QAEvidenceInput[];
  readonly likelyArea: readonly string[];
  readonly blockingReason?: string;
}

export interface QATestResult {
  readonly testId: string;
  readonly category: TestCategory;
  readonly status: QATestStatus;
  readonly summary: string;
  readonly expected: string;
  readonly observed: string;
  readonly evidence: readonly string[];
  readonly likelyArea: readonly string[];
  readonly blockingReason?: string;
}

export interface QAAgentFinding {
  readonly id: string;
  readonly severity: QAFindingSeverity;
  readonly title: string;
  readonly description: string;
  readonly relatedAcceptanceCriteria: readonly string[];
  readonly relatedTests: readonly string[];
  readonly reproduction: readonly string[];
  readonly expected: string;
  readonly observed: string;
  readonly evidence: readonly QAEvidenceInput[];
  readonly suspectedArea: readonly string[];
  readonly source: QAFindingSource;
}

export interface QAFinding extends Omit<QAAgentFinding, "evidence"> {
  readonly evidence: readonly string[];
}

export interface QAAgentOutput {
  readonly summary: string;
  readonly results: readonly QAAgentTestResult[];
  readonly findings: readonly QAAgentFinding[];
}

export interface QASessionSummary {
  readonly text: string;
  readonly passed: number;
  readonly failed: number;
  readonly blocked: number;
  readonly notRun: number;
  readonly gameplayPending: number;
}

export const QA_TECHNICAL_PHASES = [
  "PREFLIGHT",
  "STATIC",
  "STRUCTURAL",
  "RUNTIME",
  "GAMEPLAY",
  "AGENT",
  "MCP",
  "FIX",
  "FINALIZATION",
  "INTERRUPTION",
] as const;
export type QATechnicalPhase = (typeof QA_TECHNICAL_PHASES)[number];

export interface QATechnicalFailure {
  readonly phase: QATechnicalPhase;
  readonly code: string;
  readonly message: string;
  readonly occurredAt: string;
  readonly runId?: string;
}

export interface QAUnityEnvironmentSummary {
  readonly projectWorktreePath: string;
  readonly unityVersion: string;
  readonly editorExecutablePath: string;
  readonly bridgeVersion?: string;
}

export interface QASession {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly taskId: TaskId;
  readonly cycleNumber: number;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status: QASessionStatus;
  readonly plannedTests: readonly QAPlannedTest[];
  readonly results: readonly QATestResult[];
  readonly findings: readonly QAFinding[];
  readonly blockedTests: readonly string[];
  readonly evidence: readonly QAEvidence[];
  readonly unityEnvironment?: QAUnityEnvironmentSummary;
  readonly qaAgentRunId?: string;
  readonly summary: QASessionSummary;
  readonly technicalFailure?: QATechnicalFailure;
}

export interface QAReport {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly taskId: TaskId;
  readonly cycleNumber: number;
  readonly outcome: Exclude<QASessionStatus, "RUNNING">;
  readonly summary: QASessionSummary;
  readonly results: readonly QATestResult[];
  readonly findings: readonly QAFinding[];
  readonly blockedTests: readonly string[];
  readonly generatedAt: string;
  readonly manualFixAvailable: boolean;
}

export interface FixAgentOutput {
  readonly summary: string;
  readonly fixedFindingIds: readonly string[];
  readonly changedFiles: readonly string[];
  readonly fixNotes: readonly string[];
  readonly sanityChecks: readonly string[];
  readonly warnings: readonly string[];
}

export interface FixResult extends FixAgentOutput {
  readonly schemaVersion: 1;
  readonly fixId: string;
  readonly taskId: TaskId;
  readonly sourceSessionId: string;
  readonly automatic: boolean;
  readonly runId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort: ReasoningEffort;
  readonly route: ModelPlan & { readonly effort: ReasoningEffort };
  readonly status: "SUCCEEDED";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly checkpointId: string;
  readonly checkpointCommit: string;
}

export interface TaskQAArtifacts {
  readonly sessions: readonly QASession[];
  readonly reports: readonly QAReport[];
  readonly fixes: readonly FixResult[];
  readonly latestSession?: QASession;
  readonly latestReport?: QAReport;
  readonly latestFailure?: QATechnicalFailure;
}
