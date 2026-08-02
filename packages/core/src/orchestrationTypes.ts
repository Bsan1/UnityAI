import type { ReasoningEffort } from "./aiTypes.js";

export const ORCHESTRATION_PHASES = [
  "GIT_PREPARATION",
  "IMPLEMENTATION",
  "CHECKPOINT",
  "REVIEW",
  "INTERRUPTION",
] as const;

export type OrchestrationPhase = (typeof ORCHESTRATION_PHASES)[number];

export interface TaskExecutionFailure {
  readonly phase: OrchestrationPhase;
  readonly code: string;
  readonly message: string;
  readonly occurredAt: string;
  readonly runId?: string;
}

export interface ImplementationAgentOutput {
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly implementationNotes: readonly string[];
  readonly sanityChecks: readonly string[];
  readonly warnings: readonly string[];
}

export interface ImplementationResult extends ImplementationAgentOutput {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort: ReasoningEffort;
  readonly status: "SUCCEEDED";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly checkpointId?: string;
  readonly checkpointCommit?: string;
}

export const REVIEW_STATUSES = ["PASS", "FINDINGS"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_SEVERITIES = ["info", "warning", "blocking"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export interface ReviewFinding {
  readonly id: string;
  readonly severity: ReviewSeverity;
  readonly title: string;
  readonly description: string;
  readonly evidence: string;
  readonly relatedFiles: readonly string[];
}

export interface ReviewAgentOutput {
  readonly status: ReviewStatus;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly qaFocus: readonly string[];
}

export interface ReviewResult extends ReviewAgentOutput {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort: ReasoningEffort;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface TaskOrchestrationArtifacts {
  readonly implementation?: ImplementationResult;
  readonly review?: ReviewResult;
  readonly failure?: TaskExecutionFailure;
}
