import { TaskDomainError } from "./errors.js";
import {
  ANALYSIS_PHASES,
  IMPACT_LEVELS,
  TEST_CATEGORIES,
} from "./analysisTypes.js";
import type {
  AcceptanceCriterion,
  AcceptanceCriterionDraft,
  AnalysisFailureArtifact,
  AnalysisFeasibilityResult,
  AnalysisPhase,
  Ambiguity,
  ExecutionRoutingSnapshot,
  FeasibilityArtifact,
  FeasibilityEvidence,
  ImpactLevel,
  InterpretationArtifact,
  InterpreterRiskSignals,
  ModelPlan,
  PlannedTestRequirement,
  SuggestedPrerequisite,
  TaskAnalysisFailure,
  TaskAnalysisSummary,
  TaskInterpretationResult,
  TestCategory,
  TestRequirementDraft,
} from "./analysisTypes.js";
import { REASONING_EFFORTS } from "./aiTypes.js";
import type { ReasoningEffort } from "./aiTypes.js";
import { FEASIBILITY_STATUSES, TASK_STRENGTHS } from "./taskTypes.js";
import type { FeasibilityStatus, TaskStrength } from "./taskTypes.js";

type JsonRecord = Record<string, unknown>;

const impactSet = new Set<string>(IMPACT_LEVELS);
const categorySet = new Set<string>(TEST_CATEGORIES);
const strengthSet = new Set<string>(TASK_STRENGTHS);
const feasibilityStatusSet = new Set<string>(FEASIBILITY_STATUSES);
const effortSet = new Set<string>(REASONING_EFFORTS);
const analysisPhaseSet = new Set<string>(ANALYSIS_PHASES);

const invalid = (message: string): never => {
  throw new TaskDomainError("VALIDATION_ERROR", message);
};

const readRecord = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${path} must be an object.`);
  }
  return value as JsonRecord;
};

const readString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`${path} must be a non-empty string.`);
  }
  return value.trim();
};

const readBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    return invalid(`${path} must be a boolean.`);
  }
  return value;
};

const readTimestamp = (value: unknown, path: string): string => {
  const timestamp = readString(value, path);
  if (Number.isNaN(Date.parse(timestamp))) {
    return invalid(`${path} must be a valid timestamp.`);
  }
  return timestamp;
};

const readInteger = (
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid(`${path} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
};

const readStringArray = (value: unknown, path: string): readonly string[] => {
  if (!Array.isArray(value)) {
    return invalid(`${path} must be an array.`);
  }
  return value.map((entry, index) => readString(entry, `${path}[${index}]`));
};

const readStringArrayField = (
  record: JsonRecord,
  field: string,
  path: string,
): readonly string[] => readStringArray(record[field], `${path}.${field}`);

const readStrength = (value: unknown, path: string): TaskStrength => {
  if (typeof value !== "string" || !strengthSet.has(value)) {
    return invalid(`${path} must be LIGHT, STANDARD, or STRONG.`);
  }
  return value as TaskStrength;
};

const readImpact = (value: unknown, path: string): ImpactLevel => {
  if (typeof value !== "string" || !impactSet.has(value)) {
    return invalid(`${path} must be low, medium, or high.`);
  }
  return value as ImpactLevel;
};

const readCategory = (value: unknown, path: string): TestCategory => {
  if (typeof value !== "string" || !categorySet.has(value)) {
    return invalid(`${path} is not a recognized test category.`);
  }
  return value as TestCategory;
};

const readEffort = (value: unknown, path: string): ReasoningEffort => {
  if (typeof value !== "string" || !effortSet.has(value)) {
    return invalid(`${path} is not a recognized reasoning effort.`);
  }
  return value as ReasoningEffort;
};

const parseAmbiguity = (value: unknown, path: string): Ambiguity => {
  const record = readRecord(value, path);
  return {
    description: readString(record.description, `${path}.description`),
    blocking: readBoolean(record.blocking, `${path}.blocking`),
  };
};

export const parseAcceptanceCriterionDraft = (
  value: unknown,
  path = "acceptance criterion draft",
): AcceptanceCriterionDraft => {
  const record = readRecord(value, path);
  return {
    description: readString(record.description, `${path}.description`),
    evidenceExpectation: readStringArray(
      record.evidenceExpectation,
      `${path}.evidenceExpectation`,
    ),
  };
};

export const parseTestRequirementDraft = (
  value: unknown,
  path = "test requirement draft",
): TestRequirementDraft => {
  const record = readRecord(value, path);
  return {
    category: readCategory(record.category, `${path}.category`),
    description: readString(record.description, `${path}.description`),
  };
};

export const parseTaskInterpretationResult = (
  value: unknown,
): TaskInterpretationResult => {
  const record = readRecord(value, "interpretation result");
  const ambiguities = record.ambiguities;
  const criteria = record.acceptanceCriteriaDraft;
  const tests = record.testRequirementsDraft;
  if (!Array.isArray(ambiguities) || !Array.isArray(criteria) || !Array.isArray(tests)) {
    return invalid("Interpretation ambiguity, criteria, and test fields must be arrays.");
  }
  const risk = readRecord(record.riskSignals, "interpretation result.riskSignals");
  const riskSignals: InterpreterRiskSignals = {
    newReusableCoreSystem: readBoolean(risk.newReusableCoreSystem, "interpretation result.riskSignals.newReusableCoreSystem"),
    multiSystemIntegration: readBoolean(risk.multiSystemIntegration, "interpretation result.riskSignals.multiSystemIntegration"),
    networkingOrMultiplayer: readBoolean(risk.networkingOrMultiplayer, "interpretation result.riskSignals.networkingOrMultiplayer"),
    persistenceOrSaveArchitecture: readBoolean(risk.persistenceOrSaveArchitecture, "interpretation result.riskSignals.persistenceOrSaveArchitecture"),
    editorTooling: readBoolean(risk.editorTooling, "interpretation result.riskSignals.editorTooling"),
    potentiallyDestructiveDataChange: readBoolean(risk.potentiallyDestructiveDataChange, "interpretation result.riskSignals.potentiallyDestructiveDataChange"),
    likelyArchitectureImpact: readBoolean(risk.likelyArchitectureImpact, "interpretation result.riskSignals.likelyArchitectureImpact"),
    majorFrameworkOrSystemReplacement: readBoolean(risk.majorFrameworkOrSystemReplacement, "interpretation result.riskSignals.majorFrameworkOrSystemReplacement"),
    highRegressionRisk: readBoolean(risk.highRegressionRisk, "interpretation result.riskSignals.highRegressionRisk"),
    estimatedSystemsAffected: readInteger(risk.estimatedSystemsAffected, "interpretation result.riskSignals.estimatedSystemsAffected", 0, 100),
  };
  return {
    title: readString(record.title, "interpretation result.title"),
    summary: readString(record.summary, "interpretation result.summary"),
    explicitRequirements: readStringArrayField(record, "explicitRequirements", "interpretation result"),
    inferredRequirements: readStringArrayField(record, "inferredRequirements", "interpretation result"),
    constraints: readStringArrayField(record, "constraints", "interpretation result"),
    explicitNonGoals: readStringArrayField(record, "explicitNonGoals", "interpretation result"),
    ambiguities: ambiguities.map((entry, index) => parseAmbiguity(entry, `interpretation result.ambiguities[${index}]`)),
    acceptanceCriteriaDraft: criteria.map((entry, index) => parseAcceptanceCriterionDraft(entry, `interpretation result.acceptanceCriteriaDraft[${index}]`)),
    testRequirementsDraft: tests.map((entry, index) => parseTestRequirementDraft(entry, `interpretation result.testRequirementsDraft[${index}]`)),
    riskSignals,
  };
};

const parseEvidence = (value: unknown, path: string): FeasibilityEvidence => {
  const record = readRecord(value, path);
  return {
    location: readString(record.location, `${path}.location`),
    observation: readString(record.observation, `${path}.observation`),
  };
};

const parseSuggestedPrerequisite = (
  value: unknown,
  path: string,
): SuggestedPrerequisite | null => {
  if (value === null) {
    return null;
  }
  const record = readRecord(value, path);
  return {
    title: readString(record.title, `${path}.title`),
    request: readString(record.request, `${path}.request`),
  };
};

export const parseAnalysisFeasibilityResult = (
  value: unknown,
): AnalysisFeasibilityResult => {
  const record = readRecord(value, "analysis feasibility result");
  if (
    typeof record.status !== "string" ||
    !feasibilityStatusSet.has(record.status)
  ) {
    return invalid("analysis feasibility result.status is not recognized.");
  }
  const evidence = record.evidence;
  const criteria = record.acceptanceCriteriaAdditions;
  const tests = record.testRequirementAdditions;
  if (!Array.isArray(evidence) || !Array.isArray(criteria) || !Array.isArray(tests)) {
    return invalid("Feasibility evidence, criteria, and test fields must be arrays.");
  }
  return {
    status: record.status as FeasibilityStatus,
    summary: readString(record.summary, "analysis feasibility result.summary"),
    evidence: evidence.map((entry, index) => parseEvidence(entry, `analysis feasibility result.evidence[${index}]`)),
    existingCapabilities: readStringArrayField(record, "existingCapabilities", "analysis feasibility result"),
    missingCapabilities: readStringArrayField(record, "missingCapabilities", "analysis feasibility result"),
    autoFixableDependencies: readStringArrayField(record, "autoFixableDependencies", "analysis feasibility result"),
    suggestedPrerequisite: parseSuggestedPrerequisite(record.suggestedPrerequisite, "analysis feasibility result.suggestedPrerequisite"),
    systemsAffected: readStringArrayField(record, "systemsAffected", "analysis feasibility result"),
    architectureImpact: readImpact(record.architectureImpact, "analysis feasibility result.architectureImpact"),
    implementationComplexity: readImpact(record.implementationComplexity, "analysis feasibility result.implementationComplexity"),
    regressionRisk: readImpact(record.regressionRisk, "analysis feasibility result.regressionRisk"),
    ambiguity: readImpact(record.ambiguity, "analysis feasibility result.ambiguity"),
    createsReusableCoreSystem: readBoolean(record.createsReusableCoreSystem, "analysis feasibility result.createsReusableCoreSystem"),
    proposedImplementationScope: readStringArrayField(record, "proposedImplementationScope", "analysis feasibility result"),
    proposedNonGoals: readStringArrayField(record, "proposedNonGoals", "analysis feasibility result"),
    acceptanceCriteriaAdditions: criteria.map((entry, index) => parseAcceptanceCriterionDraft(entry, `analysis feasibility result.acceptanceCriteriaAdditions[${index}]`)),
    testRequirementAdditions: tests.map((entry, index) => parseTestRequirementDraft(entry, `analysis feasibility result.testRequirementAdditions[${index}]`)),
  };
};

const parseModelPlan = (
  value: unknown,
  path: string,
  requireEffort: boolean,
): ModelPlan => {
  const record = readRecord(value, path);
  const effort = record.effort === undefined
    ? undefined
    : readEffort(record.effort, `${path}.effort`);
  if (requireEffort && effort === undefined) {
    return invalid(`${path}.effort is required.`);
  }
  return {
    providerId: readString(record.providerId, `${path}.providerId`),
    modelId: readString(record.modelId, `${path}.modelId`),
    providerModelName: readString(record.providerModelName, `${path}.providerModelName`),
    ...(effort === undefined ? {} : { effort }),
  };
};

export const parseExecutionRoutingSnapshot = (
  value: unknown,
): ExecutionRoutingSnapshot => {
  const record = readRecord(value, "routing snapshot");
  if (record.schemaVersion !== 1 || record.runtimeEscalation !== false) {
    return invalid("routing snapshot must use schemaVersion 1 and disable runtime escalation.");
  }
  const implementation = parseModelPlan(record.implementation, "routing snapshot.implementation", true);
  const qa = parseModelPlan(record.qa, "routing snapshot.qa", true);
  const fixRecord = readRecord(record.fix, "routing snapshot.fix");
  const reviewRecord = readRecord(record.review, "routing snapshot.review");
  const fixEnabled = readBoolean(fixRecord.enabled, "routing snapshot.fix.enabled");
  const fixPlan = parseModelPlan(fixRecord.plan, "routing snapshot.fix.plan", true);
  if (JSON.stringify(fixPlan) !== JSON.stringify(implementation)) {
    return invalid("routing snapshot.fix.plan must exactly match implementation.");
  }
  const reviewEnabled = readBoolean(reviewRecord.enabled, "routing snapshot.review.enabled");
  const review = reviewEnabled
    ? { enabled: true as const, plan: parseModelPlan(reviewRecord.plan, "routing snapshot.review.plan", false) }
    : { enabled: false as const };
  return {
    schemaVersion: 1,
    taskStrength: readStrength(record.taskStrength, "routing snapshot.taskStrength"),
    implementation: implementation as ExecutionRoutingSnapshot["implementation"],
    qa: qa as ExecutionRoutingSnapshot["qa"],
    fix: { enabled: fixEnabled, plan: fixPlan as ExecutionRoutingSnapshot["implementation"] },
    review,
    runtimeEscalation: false,
    createdAt: readTimestamp(record.createdAt, "routing snapshot.createdAt"),
  };
};

export const parseAcceptanceCriterion = (
  value: unknown,
  path = "acceptance criterion",
): AcceptanceCriterion => {
  const record = readRecord(value, path);
  const id = readString(record.id, `${path}.id`);
  if (!/^AC-\d{3,}$/.test(id)) {
    return invalid(`${path}.id must use the AC-001 format.`);
  }
  const evidenceExpectation = readStringArray(record.evidenceExpectation, `${path}.evidenceExpectation`);
  if (evidenceExpectation.length === 0) {
    return invalid(`${path}.evidenceExpectation must not be empty.`);
  }
  return {
    id,
    description: readString(record.description, `${path}.description`),
    evidenceExpectation,
  };
};

export const parsePlannedTestRequirement = (
  value: unknown,
  path = "planned test requirement",
): PlannedTestRequirement => {
  const record = readRecord(value, path);
  const id = readString(record.id, `${path}.id`);
  if (!/^TEST-\d{3,}$/.test(id)) {
    return invalid(`${path}.id must use the TEST-001 format.`);
  }
  return {
    id,
    category: readCategory(record.category, `${path}.category`),
    description: readString(record.description, `${path}.description`),
  };
};

export const parseTaskAnalysisSummary = (
  value: unknown,
): TaskAnalysisSummary => {
  const record = readRecord(value, "task.analysis");
  return {
    preliminaryStrength: readStrength(record.preliminaryStrength, "task.analysis.preliminaryStrength"),
    finalStrength: readStrength(record.finalStrength, "task.analysis.finalStrength"),
    interpretationRunId: readString(record.interpretationRunId, "task.analysis.interpretationRunId"),
    feasibilityRunId: readString(record.feasibilityRunId, "task.analysis.feasibilityRunId"),
    routingSnapshot: parseExecutionRoutingSnapshot(record.routingSnapshot),
    analyzedAt: readTimestamp(record.analyzedAt, "task.analysis.analyzedAt"),
    recheckCount: readInteger(record.recheckCount, "task.analysis.recheckCount", 0, 1_000_000),
  };
};

export const parseTaskAnalysisFailure = (
  value: unknown,
): TaskAnalysisFailure => {
  const record = readRecord(value, "task.analysisFailure");
  if (typeof record.phase !== "string" || !analysisPhaseSet.has(record.phase)) {
    return invalid("task.analysisFailure.phase is not recognized.");
  }
  const runId = record.runId === undefined ? undefined : readString(record.runId, "task.analysisFailure.runId");
  return {
    phase: record.phase as AnalysisPhase,
    code: readString(record.code, "task.analysisFailure.code"),
    message: readString(record.message, "task.analysisFailure.message"),
    occurredAt: readTimestamp(record.occurredAt, "task.analysisFailure.occurredAt"),
    ...(runId === undefined ? {} : { runId }),
  };
};

export const parseInterpretationArtifact = (
  value: unknown,
): InterpretationArtifact => {
  const record = readRecord(value, "interpretation artifact");
  if (record.schemaVersion !== 1) {
    return invalid("interpretation artifact.schemaVersion must be 1.");
  }
  return {
    schemaVersion: 1,
    runId: readString(record.runId, "interpretation artifact.runId"),
    recordedAt: readTimestamp(record.recordedAt, "interpretation artifact.recordedAt"),
    result: parseTaskInterpretationResult(record.result),
  };
};

export const parseFeasibilityArtifact = (
  value: unknown,
): FeasibilityArtifact => {
  const record = readRecord(value, "feasibility artifact");
  if (record.schemaVersion !== 1) {
    return invalid("feasibility artifact.schemaVersion must be 1.");
  }
  return {
    schemaVersion: 1,
    runId: readString(record.runId, "feasibility artifact.runId"),
    recordedAt: readTimestamp(record.recordedAt, "feasibility artifact.recordedAt"),
    preliminaryStrength: readStrength(record.preliminaryStrength, "feasibility artifact.preliminaryStrength"),
    result: parseAnalysisFeasibilityResult(record.result),
  };
};

export const parseAnalysisFailureArtifact = (
  value: unknown,
): AnalysisFailureArtifact => {
  const record = readRecord(value, "analysis failure artifact");
  if (record.schemaVersion !== 1) {
    return invalid("analysis failure artifact.schemaVersion must be 1.");
  }
  return { schemaVersion: 1, ...parseTaskAnalysisFailure(record) };
};
