import type { ReasoningEffort } from "./aiTypes.js";
import type { TaskContract, TaskStrength } from "./taskTypes.js";

export const IMPACT_LEVELS = ["low", "medium", "high"] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

export const TEST_CATEGORIES = [
  "STATIC",
  "STRUCTURAL",
  "RUNTIME",
  "GAMEPLAY",
] as const;
export type TestCategory = (typeof TEST_CATEGORIES)[number];

export interface Ambiguity {
  readonly description: string;
  readonly blocking: boolean;
}

export interface AcceptanceCriterionDraft {
  readonly description: string;
  readonly evidenceExpectation: readonly string[];
}

export interface TestRequirementDraft {
  readonly category: TestCategory;
  readonly description: string;
}

export interface InterpreterRiskSignals {
  readonly newReusableCoreSystem: boolean;
  readonly multiSystemIntegration: boolean;
  readonly networkingOrMultiplayer: boolean;
  readonly persistenceOrSaveArchitecture: boolean;
  readonly editorTooling: boolean;
  readonly potentiallyDestructiveDataChange: boolean;
  readonly likelyArchitectureImpact: boolean;
  readonly majorFrameworkOrSystemReplacement: boolean;
  readonly highRegressionRisk: boolean;
  readonly estimatedSystemsAffected: number;
}

export interface TaskInterpretationResult {
  readonly title: string;
  readonly summary: string;
  readonly explicitRequirements: readonly string[];
  readonly inferredRequirements: readonly string[];
  readonly constraints: readonly string[];
  readonly explicitNonGoals: readonly string[];
  readonly ambiguities: readonly Ambiguity[];
  readonly acceptanceCriteriaDraft: readonly AcceptanceCriterionDraft[];
  readonly testRequirementsDraft: readonly TestRequirementDraft[];
  readonly riskSignals: InterpreterRiskSignals;
}

export interface FeasibilityEvidence {
  readonly location: string;
  readonly observation: string;
}

export interface SuggestedPrerequisite {
  readonly title: string;
  readonly request: string;
}

export interface AnalysisFeasibilityResult {
  readonly status:
    | "READY"
    | "AUTO_FIXABLE"
    | "BLOCKED_ARCHITECTURE"
    | "BLOCKED_USER";
  readonly summary: string;
  readonly evidence: readonly FeasibilityEvidence[];
  readonly existingCapabilities: readonly string[];
  readonly missingCapabilities: readonly string[];
  readonly autoFixableDependencies: readonly string[];
  readonly suggestedPrerequisite: SuggestedPrerequisite | null;
  readonly systemsAffected: readonly string[];
  readonly architectureImpact: ImpactLevel;
  readonly implementationComplexity: ImpactLevel;
  readonly regressionRisk: ImpactLevel;
  readonly ambiguity: ImpactLevel;
  readonly createsReusableCoreSystem: boolean;
  readonly proposedImplementationScope: readonly string[];
  readonly proposedNonGoals: readonly string[];
  readonly acceptanceCriteriaAdditions: readonly AcceptanceCriterionDraft[];
  readonly testRequirementAdditions: readonly TestRequirementDraft[];
}

export interface ModelPlan {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerModelName: string;
  readonly effort?: ReasoningEffort;
}

export interface ExecutionRoutingSnapshot {
  readonly schemaVersion: 1;
  readonly taskStrength: TaskStrength;
  readonly implementation: ModelPlan & { readonly effort: ReasoningEffort };
  readonly qa: ModelPlan & { readonly effort: ReasoningEffort };
  readonly fix: {
    readonly enabled: boolean;
    readonly plan: ModelPlan & { readonly effort: ReasoningEffort };
  };
  readonly review:
    | { readonly enabled: false }
    | { readonly enabled: true; readonly plan: ModelPlan };
  readonly runtimeEscalation: false;
  readonly createdAt: string;
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly evidenceExpectation: readonly string[];
}

export interface PlannedTestRequirement {
  readonly id: string;
  readonly category: TestCategory;
  readonly description: string;
}

export interface TaskAnalysisSummary {
  readonly preliminaryStrength: TaskStrength;
  readonly finalStrength: TaskStrength;
  readonly interpretationRunId: string;
  readonly feasibilityRunId: string;
  readonly routingSnapshot: ExecutionRoutingSnapshot;
  readonly analyzedAt: string;
  readonly recheckCount: number;
}

export const ANALYSIS_PHASES = [
  "INTERPRETATION",
  "FEASIBILITY",
  "PLANNING",
  "READ_ONLY_VERIFICATION",
] as const;
export type AnalysisPhase = (typeof ANALYSIS_PHASES)[number];

export interface TaskAnalysisFailure {
  readonly phase: AnalysisPhase;
  readonly code: string;
  readonly message: string;
  readonly occurredAt: string;
  readonly runId?: string;
}

export interface InterpretationArtifact {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly recordedAt: string;
  readonly result: TaskInterpretationResult;
}

export interface FeasibilityArtifact {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly recordedAt: string;
  readonly preliminaryStrength: TaskStrength;
  readonly result: AnalysisFeasibilityResult;
}

export interface AnalysisFailureArtifact extends TaskAnalysisFailure {
  readonly schemaVersion: 1;
}

export interface TaskAnalysisArtifacts {
  readonly interpretation?: InterpretationArtifact;
  readonly feasibility?: FeasibilityArtifact;
  readonly routing?: ExecutionRoutingSnapshot;
  readonly contract?: TaskContract;
  readonly failure?: AnalysisFailureArtifact;
}
