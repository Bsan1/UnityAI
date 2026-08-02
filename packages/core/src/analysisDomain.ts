import type {
  AcceptanceCriterion,
  AcceptanceCriterionDraft,
  AnalysisFeasibilityResult,
  ExecutionRoutingSnapshot,
  ModelPlan,
  PlannedTestRequirement,
  TaskInterpretationResult,
  TestRequirementDraft,
} from "./analysisTypes.js";
import {
  parseAnalysisFeasibilityResult,
  parseExecutionRoutingSnapshot,
  parseTaskInterpretationResult,
} from "./analysisValidation.js";
import type {
  ModelConfiguration,
  ModelDefinition,
  ModelRoutingEntry,
  ModelRoutingWork,
} from "./aiTypes.js";
import { TaskDomainError } from "./errors.js";
import type {
  TaskContractInput,
  TaskStrength,
} from "./taskTypes.js";

const rank: Readonly<Record<TaskStrength, number>> = {
  LIGHT: 0,
  STANDARD: 1,
  STRONG: 2,
};

const stronger = (left: TaskStrength, right: TaskStrength): TaskStrength =>
  rank[left] >= rank[right] ? left : right;

export const classifyPreliminaryStrength = (
  value: TaskInterpretationResult,
): TaskStrength => {
  const interpretation = parseTaskInterpretationResult(value);
  const risk = interpretation.riskSignals;
  if (
    risk.newReusableCoreSystem ||
    risk.networkingOrMultiplayer ||
    risk.persistenceOrSaveArchitecture ||
    risk.potentiallyDestructiveDataChange ||
    risk.majorFrameworkOrSystemReplacement ||
    risk.highRegressionRisk ||
    risk.estimatedSystemsAffected >= 4
  ) {
    return "STRONG";
  }
  if (
    risk.multiSystemIntegration ||
    risk.editorTooling ||
    risk.likelyArchitectureImpact ||
    risk.estimatedSystemsAffected >= 2 ||
    interpretation.ambiguities.some((ambiguity) => ambiguity.blocking)
  ) {
    return "STANDARD";
  }
  return "LIGHT";
};

export const classifyFinalStrength = (
  interpretationValue: TaskInterpretationResult,
  feasibilityValue: AnalysisFeasibilityResult,
): TaskStrength => {
  const interpretation = parseTaskInterpretationResult(interpretationValue);
  const feasibility = parseAnalysisFeasibilityResult(feasibilityValue);
  const preliminary = classifyPreliminaryStrength(interpretation);
  const risk = interpretation.riskSignals;
  if (
    preliminary === "STRONG" ||
    feasibility.architectureImpact === "high" ||
    feasibility.regressionRisk === "high" ||
    feasibility.ambiguity === "high" ||
    feasibility.createsReusableCoreSystem ||
    feasibility.systemsAffected.length >= 4 ||
    (feasibility.implementationComplexity === "high" &&
      feasibility.systemsAffected.length >= 3) ||
    risk.networkingOrMultiplayer ||
    risk.persistenceOrSaveArchitecture ||
    risk.majorFrameworkOrSystemReplacement
  ) {
    return "STRONG";
  }
  if (
    preliminary === "STANDARD" ||
    feasibility.architectureImpact === "medium" ||
    feasibility.implementationComplexity !== "low" ||
    feasibility.regressionRisk === "medium" ||
    feasibility.ambiguity === "medium" ||
    feasibility.systemsAffected.length >= 2
  ) {
    return "STANDARD";
  }
  return stronger(preliminary, "LIGHT");
};

const routeFor = (
  configuration: ModelConfiguration,
  work: ModelRoutingWork,
  strength: TaskStrength,
): ModelRoutingEntry => {
  const route = configuration.routing.find(
    (entry) =>
      entry.work === work &&
      (entry.taskStrength === strength || entry.taskStrength === "ALL"),
  );
  if (route === undefined) {
    throw new TaskDomainError(
      "VALIDATION_ERROR",
      `No configured ${work} route exists for ${strength}.`,
    );
  }
  return route;
};

const modelFor = (
  configuration: ModelConfiguration,
  route: ModelRoutingEntry,
): ModelDefinition => {
  const model = configuration.models.find((candidate) => candidate.id === route.modelId);
  if (model === undefined) {
    throw new TaskDomainError(
      "VALIDATION_ERROR",
      `Route ${route.work}/${route.taskStrength} references missing model ${route.modelId}.`,
    );
  }
  return model;
};

export const resolveConfiguredModelPlan = (
  configuration: ModelConfiguration,
  work: ModelRoutingWork,
  strength: TaskStrength,
  requireEffort = true,
): ModelPlan => {
  const route = routeFor(configuration, work, strength);
  const model = modelFor(configuration, route);
  if (requireEffort && route.effort === undefined) {
    throw new TaskDomainError(
      "VALIDATION_ERROR",
      `Configured ${work} route for ${strength} must specify reasoning effort.`,
    );
  }
  return {
    providerId: model.providerId,
    modelId: model.id,
    providerModelName: model.providerModelName,
    ...(route.effort === undefined ? {} : { effort: route.effort }),
  };
};

export const buildExecutionRoutingSnapshot = (
  configuration: ModelConfiguration,
  strength: TaskStrength,
  crossReviewEnabled: boolean,
  automaticFixesEnabled: boolean,
  timestamp = new Date().toISOString(),
): ExecutionRoutingSnapshot => {
  const implementation = resolveConfiguredModelPlan(
    configuration,
    "IMPLEMENTATION",
    strength,
  ) as ExecutionRoutingSnapshot["implementation"];
  const qa = resolveConfiguredModelPlan(
    configuration,
    "QA_REASONING",
    strength,
  ) as ExecutionRoutingSnapshot["qa"];
  const review = crossReviewEnabled
    ? {
        enabled: true as const,
        plan: resolveConfiguredModelPlan(
          configuration,
          "CROSS_REVIEW",
          strength,
          false,
        ),
      }
    : { enabled: false as const };
  return parseExecutionRoutingSnapshot({
    schemaVersion: 1,
    taskStrength: strength,
    implementation,
    qa,
    fix: { enabled: automaticFixesEnabled, plan: { ...implementation } },
    review,
    runtimeEscalation: false,
    createdAt: timestamp,
  });
};

const normalizedKey = (value: string): string =>
  value.trim().replace(/\s+/gu, " ").replace(/[.!?]+$/u, "").toLocaleLowerCase("en-US");

const dedupeStrings = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = normalizedKey(trimmed);
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
};

const defaultEvidence = (description: string): readonly string[] =>
  /player|runtime|place|dash|cooldown|gold|resource|input|overlap|spawn|consume/iu.test(description)
    ? [
        "Exercise the behavior in a representative runtime scenario.",
        "Record the resulting runtime and object/component state.",
      ]
    : ["Retain the relevant compiler, static-check, or structural-check output."];

const buildCriteria = (
  drafts: readonly AcceptanceCriterionDraft[],
): readonly AcceptanceCriterion[] => {
  const seen = new Set<string>();
  const result: AcceptanceCriterion[] = [];
  for (const draft of drafts) {
    const description = draft.description.trim();
    const key = normalizedKey(description);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const evidence = dedupeStrings(draft.evidenceExpectation);
    result.push({
      id: `AC-${String(result.length + 1).padStart(3, "0")}`,
      description,
      evidenceExpectation: evidence.length === 0 ? defaultEvidence(description) : evidence,
    });
  }
  return result;
};

const buildTests = (
  drafts: readonly TestRequirementDraft[],
): readonly PlannedTestRequirement[] => {
  const seen = new Set<string>();
  const result: PlannedTestRequirement[] = [];
  for (const draft of drafts) {
    const key = `${draft.category}:${normalizedKey(draft.description)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      id: `TEST-${String(result.length + 1).padStart(3, "0")}`,
      category: draft.category,
      description: draft.description.trim(),
    });
  }
  return result;
};

export const buildDeterministicTaskContract = (
  interpretationValue: TaskInterpretationResult,
  feasibilityValue: AnalysisFeasibilityResult,
  strength: TaskStrength,
  routingValue: ExecutionRoutingSnapshot,
): TaskContractInput => {
  const interpretation = parseTaskInterpretationResult(interpretationValue);
  const feasibility = parseAnalysisFeasibilityResult(feasibilityValue);
  const routing = parseExecutionRoutingSnapshot(routingValue);
  if (feasibility.status !== "READY") {
    throw new TaskDomainError(
      "VALIDATION_ERROR",
      "A Task Contract may be built only for READY feasibility.",
    );
  }
  if (routing.taskStrength !== strength) {
    throw new TaskDomainError(
      "VALIDATION_ERROR",
      "Task Contract strength must match its routing snapshot.",
    );
  }
  const criteria = buildCriteria([
    ...interpretation.acceptanceCriteriaDraft,
    ...feasibility.acceptanceCriteriaAdditions,
  ]);
  const tests = buildTests([
    ...interpretation.testRequirementsDraft,
    ...feasibility.testRequirementAdditions,
  ]);
  const explicitRequirements = dedupeStrings([
    ...interpretation.explicitRequirements,
    ...interpretation.constraints,
  ]);
  const prerequisites = dedupeStrings([
    ...feasibility.missingCapabilities,
    ...feasibility.autoFixableDependencies,
  ]);
  return {
    originalTaskSummary: interpretation.summary,
    understoodExplicitRequirements: explicitRequirements,
    inferredRequirements: dedupeStrings(interpretation.inferredRequirements),
    prerequisites,
    implementationScope: dedupeStrings(feasibility.proposedImplementationScope),
    nonGoals: dedupeStrings([
      ...interpretation.explicitNonGoals,
      ...feasibility.proposedNonGoals,
    ]),
    acceptanceCriteria: criteria.map((criterion) => criterion.description),
    testRequirements: tests.map((test) => `${test.category}: ${test.description}`),
    taskStrength: strength,
    executionPlan: routing,
    acceptanceCriteriaDetails: criteria,
    testRequirementDetails: tests,
  };
};
