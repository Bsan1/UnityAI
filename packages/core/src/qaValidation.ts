import { TaskDomainError } from "./errors.js";
import { TEST_CATEGORIES } from "./analysisTypes.js";
import type { JsonValue } from "./aiTypes.js";
import {
  QA_EVIDENCE_KINDS,
  QA_EXECUTABLE_CATEGORIES,
  QA_FINDING_SEVERITIES,
  QA_FINDING_SOURCES,
  QA_SESSION_STATUSES,
  QA_TECHNICAL_PHASES,
  QA_TEST_STATUSES,
} from "./qaTypes.js";
import type {
  FixAgentOutput,
  FixResult,
  QAAgentFinding,
  QAAgentOutput,
  QAAgentTestResult,
  QAEvidence,
  QAEvidenceInput,
  QAFinding,
  QAPlannedTest,
  QAReport,
  QASession,
  QASessionSummary,
  QATechnicalFailure,
  QATestResult,
} from "./qaTypes.js";
import { parseReasoningEffort } from "./aiValidation.js";
import { parseTaskId } from "./taskValidation.js";

type RecordValue = Record<string, unknown>;

const invalid = (message: string): never => {
  throw new TaskDomainError("VALIDATION_ERROR", message);
};

const record = (value: unknown, path: string): RecordValue => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${path} must be an object.`);
  }
  return value as RecordValue;
};

const string = (value: unknown, path: string, maximum = 100_000): string => {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    return invalid(`${path} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
};

const timestamp = (value: unknown, path: string): string => {
  const result = string(value, path, 100);
  if (Number.isNaN(Date.parse(result))) {
    return invalid(`${path} must be a timestamp.`);
  }
  return result;
};

const integer = (value: unknown, path: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    return invalid(`${path} must be an integer of at least ${minimum}.`);
  }
  return Number(value);
};

const strings = (value: unknown, path: string): readonly string[] => {
  if (!Array.isArray(value)) {
    return invalid(`${path} must be an array.`);
  }
  return value.map((entry, index) => string(entry, `${path}[${index}]`, 20_000));
};

const enumeration = <T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T => {
  if (typeof value !== "string" || !values.includes(value as T)) {
    return invalid(`${path} is invalid.`);
  }
  return value as T;
};

const jsonValue = (value: unknown, path: string): JsonValue => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 262_144) {
      return invalid(`${path} exceeds the 256 KiB evidence limit.`);
    }
    return JSON.parse(serialized) as JsonValue;
  } catch {
    return invalid(`${path} must be JSON serializable.`);
  }
};

export const parseQAEvidenceInput = (
  value: unknown,
  path = "qa evidence",
): QAEvidenceInput => {
  const input = record(value, path);
  const reference = input.reference === undefined
    ? undefined
    : string(input.reference, `${path}.reference`, 20_000);
  return {
    kind: enumeration(input.kind, QA_EVIDENCE_KINDS, `${path}.kind`),
    summary: string(input.summary, `${path}.summary`, 20_000),
    ...(reference === undefined ? {} : { reference }),
    ...(input.details === undefined
      ? {}
      : { details: jsonValue(input.details, `${path}.details`) }),
  };
};

export const parseQAEvidence = (value: unknown, path = "qa evidence"): QAEvidence => {
  const input = record(value, path);
  const id = string(input.id, `${path}.id`, 100);
  if (!/^EVID-\d{4,}$/u.test(id)) {
    return invalid(`${path}.id must use the EVID-0001 format.`);
  }
  return {
    ...parseQAEvidenceInput(input, path),
    id,
    capturedAt: timestamp(input.capturedAt, `${path}.capturedAt`),
  };
};

export const parseQAPlannedTest = (
  value: unknown,
  path = "planned QA test",
): QAPlannedTest => {
  const input = record(value, path);
  if (input.required !== true) {
    return invalid(`${path}.required must be true.`);
  }
  return {
    id: string(input.id, `${path}.id`, 100),
    category: enumeration(input.category, TEST_CATEGORIES, `${path}.category`),
    description: string(input.description, `${path}.description`, 20_000),
    required: true,
    source: enumeration(input.source, ["BASELINE", "CONTRACT"] as const, `${path}.source`),
  };
};

export const parseQAAgentTestResult = (
  value: unknown,
  path = "QA agent test result",
): QAAgentTestResult => {
  const input = record(value, path);
  if (!Array.isArray(input.evidence)) {
    return invalid(`${path}.evidence must be an array.`);
  }
  const status = enumeration(input.status, QA_TEST_STATUSES, `${path}.status`);
  const blockingReason = input.blockingReason === undefined
    ? undefined
    : string(input.blockingReason, `${path}.blockingReason`, 20_000);
  if ((status === "PASS" || status === "FAIL") && input.evidence.length === 0) {
    return invalid(`${path} ${status} requires evidence.`);
  }
  if ((status === "BLOCKED" || status === "NOT_RUN") && blockingReason === undefined) {
    return invalid(`${path} ${status} requires a blocking reason.`);
  }
  return {
    testId: string(input.testId, `${path}.testId`, 100),
    category: enumeration(input.category, QA_EXECUTABLE_CATEGORIES, `${path}.category`),
    status,
    summary: string(input.summary, `${path}.summary`, 20_000),
    expected: string(input.expected, `${path}.expected`, 20_000),
    observed: string(input.observed, `${path}.observed`, 20_000),
    evidence: input.evidence.map((entry, index) =>
      parseQAEvidenceInput(entry, `${path}.evidence[${index}]`),
    ),
    likelyArea: strings(input.likelyArea, `${path}.likelyArea`),
    ...(blockingReason === undefined ? {} : { blockingReason }),
  };
};

const parseAgentFinding = (value: unknown, path: string): QAAgentFinding => {
  const input = record(value, path);
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    return invalid(`${path}.evidence must contain at least one item.`);
  }
  return {
    id: string(input.id, `${path}.id`, 100),
    severity: enumeration(input.severity, QA_FINDING_SEVERITIES, `${path}.severity`),
    title: string(input.title, `${path}.title`, 2_000),
    description: string(input.description, `${path}.description`, 20_000),
    relatedAcceptanceCriteria: strings(
      input.relatedAcceptanceCriteria,
      `${path}.relatedAcceptanceCriteria`,
    ),
    relatedTests: strings(input.relatedTests, `${path}.relatedTests`),
    reproduction: strings(input.reproduction, `${path}.reproduction`),
    expected: string(input.expected, `${path}.expected`, 20_000),
    observed: string(input.observed, `${path}.observed`, 20_000),
    evidence: input.evidence.map((entry, index) =>
      parseQAEvidenceInput(entry, `${path}.evidence[${index}]`),
    ),
    suspectedArea: strings(input.suspectedArea, `${path}.suspectedArea`),
    source: enumeration(input.source, QA_FINDING_SOURCES, `${path}.source`),
  };
};

export const parseQAAgentOutput = (value: unknown): QAAgentOutput => {
  const input = record(value, "QA agent output");
  if (!Array.isArray(input.results) || !Array.isArray(input.findings)) {
    return invalid("QA agent output results and findings must be arrays.");
  }
  const results = input.results.map((entry, index) =>
    parseQAAgentTestResult(entry, `QA agent output.results[${index}]`),
  );
  const resultIds = new Set(results.map((result) => result.testId));
  if (resultIds.size !== results.length) {
    return invalid("QA agent output cannot contain duplicate test IDs.");
  }
  const findings = input.findings.map((entry, index) =>
    parseAgentFinding(entry, `QA agent output.findings[${index}]`),
  );
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length) {
    return invalid("QA agent output cannot contain duplicate finding IDs.");
  }
  return {
    summary: string(input.summary, "QA agent output.summary", 20_000),
    results,
    findings,
  };
};

const parseTestResult = (value: unknown, path: string): QATestResult => {
  const input = record(value, path);
  const blockingReason = input.blockingReason === undefined
    ? undefined
    : string(input.blockingReason, `${path}.blockingReason`, 20_000);
  const status = enumeration(input.status, QA_TEST_STATUSES, `${path}.status`);
  const evidence = strings(input.evidence, `${path}.evidence`);
  if ((status === "PASS" || status === "FAIL") && evidence.length === 0) {
    return invalid(`${path} ${status} requires evidence.`);
  }
  if ((status === "BLOCKED" || status === "NOT_RUN") && blockingReason === undefined) {
    return invalid(`${path} ${status} requires a blocking reason.`);
  }
  return {
    testId: string(input.testId, `${path}.testId`, 100),
    category: enumeration(input.category, TEST_CATEGORIES, `${path}.category`),
    status,
    summary: string(input.summary, `${path}.summary`, 20_000),
    expected: string(input.expected, `${path}.expected`, 20_000),
    observed: string(input.observed, `${path}.observed`, 20_000),
    evidence,
    likelyArea: strings(input.likelyArea, `${path}.likelyArea`),
    ...(blockingReason === undefined ? {} : { blockingReason }),
  };
};

const parseFinding = (value: unknown, path: string): QAFinding => {
  const input = record(value, path);
  return {
    id: string(input.id, `${path}.id`, 100),
    severity: enumeration(input.severity, QA_FINDING_SEVERITIES, `${path}.severity`),
    title: string(input.title, `${path}.title`, 2_000),
    description: string(input.description, `${path}.description`, 20_000),
    relatedAcceptanceCriteria: strings(input.relatedAcceptanceCriteria, `${path}.relatedAcceptanceCriteria`),
    relatedTests: strings(input.relatedTests, `${path}.relatedTests`),
    reproduction: strings(input.reproduction, `${path}.reproduction`),
    expected: string(input.expected, `${path}.expected`, 20_000),
    observed: string(input.observed, `${path}.observed`, 20_000),
    evidence: strings(input.evidence, `${path}.evidence`),
    suspectedArea: strings(input.suspectedArea, `${path}.suspectedArea`),
    source: enumeration(input.source, QA_FINDING_SOURCES, `${path}.source`),
  };
};

const parseSummary = (value: unknown, path: string): QASessionSummary => {
  const input = record(value, path);
  return {
    text: string(input.text, `${path}.text`, 20_000),
    passed: integer(input.passed, `${path}.passed`),
    failed: integer(input.failed, `${path}.failed`),
    blocked: integer(input.blocked, `${path}.blocked`),
    notRun: integer(input.notRun, `${path}.notRun`),
    gameplayPending: integer(input.gameplayPending, `${path}.gameplayPending`),
  };
};

export const parseQATechnicalFailure = (value: unknown): QATechnicalFailure => {
  const input = record(value, "QA technical failure");
  const runId = input.runId === undefined ? undefined : string(input.runId, "QA technical failure.runId", 100);
  return {
    phase: enumeration(input.phase, QA_TECHNICAL_PHASES, "QA technical failure.phase"),
    code: string(input.code, "QA technical failure.code", 200),
    message: string(input.message, "QA technical failure.message", 20_000),
    occurredAt: timestamp(input.occurredAt, "QA technical failure.occurredAt"),
    ...(runId === undefined ? {} : { runId }),
  };
};

export const parseQASession = (value: unknown): QASession => {
  const input = record(value, "QA session");
  if (
    input.schemaVersion !== 1 ||
    !Array.isArray(input.plannedTests) ||
    !Array.isArray(input.results) ||
    !Array.isArray(input.findings) ||
    !Array.isArray(input.blockedTests) ||
    !Array.isArray(input.evidence)
  ) {
    return invalid("QA session schema or arrays are invalid.");
  }
  const completedAt = input.completedAt === undefined ? undefined : timestamp(input.completedAt, "QA session.completedAt");
  const unityEnvironment = input.unityEnvironment === undefined
    ? undefined
    : (() => {
        const environment = record(input.unityEnvironment, "QA session.unityEnvironment");
        const bridgeVersion = environment.bridgeVersion === undefined
          ? undefined
          : string(environment.bridgeVersion, "QA session.unityEnvironment.bridgeVersion", 100);
        return {
          projectWorktreePath: string(environment.projectWorktreePath, "QA session.unityEnvironment.projectWorktreePath", 20_000),
          unityVersion: string(environment.unityVersion, "QA session.unityEnvironment.unityVersion", 100),
          editorExecutablePath: string(environment.editorExecutablePath, "QA session.unityEnvironment.editorExecutablePath", 20_000),
          ...(bridgeVersion === undefined ? {} : { bridgeVersion }),
        };
      })();
  const qaAgentRunId = input.qaAgentRunId === undefined ? undefined : string(input.qaAgentRunId, "QA session.qaAgentRunId", 100);
  const technicalFailure = input.technicalFailure === undefined
    ? undefined
    : parseQATechnicalFailure(input.technicalFailure);
  const status = enumeration(input.status, QA_SESSION_STATUSES, "QA session.status");
  if (status === "RUNNING" && completedAt !== undefined) {
    return invalid("A running QA session cannot have completedAt.");
  }
  if (status !== "RUNNING" && completedAt === undefined) {
    return invalid("A completed QA session requires completedAt.");
  }
  if (status === "TECHNICAL_FAILURE" && technicalFailure === undefined) {
    return invalid("A technical QA session requires technicalFailure.");
  }
  const plannedTests = input.plannedTests.map((entry, index) => parseQAPlannedTest(entry, `QA session.plannedTests[${index}]`));
  const results = input.results.map((entry, index) => parseTestResult(entry, `QA session.results[${index}]`));
  const findings = input.findings.map((entry, index) => parseFinding(entry, `QA session.findings[${index}]`));
  const evidence = input.evidence.map((entry, index) => parseQAEvidence(entry, `QA session.evidence[${index}]`));
  const blockedTests = strings(input.blockedTests, "QA session.blockedTests");
  const summary = parseSummary(input.summary, "QA session.summary");
  const plannedIds = new Set(plannedTests.map((test) => test.id));
  const resultIds = new Set(results.map((result) => result.testId));
  const evidenceIds = new Set(evidence.map((entry) => entry.id));
  if (plannedIds.size !== plannedTests.length || resultIds.size !== results.length) {
    return invalid("QA session planned tests and results require unique test IDs.");
  }
  if (evidenceIds.size !== evidence.length || new Set(findings.map((finding) => finding.id)).size !== findings.length) {
    return invalid("QA session evidence and findings require unique IDs.");
  }
  if (results.some((result) => {
    const planned = plannedTests.find((test) => test.id === result.testId);
    return planned === undefined || planned.category !== result.category;
  })) {
    return invalid("QA session results must match a planned test and category.");
  }
  if (
    results.some((result) => result.evidence.some((id) => !evidenceIds.has(id))) ||
    findings.some((finding) => finding.evidence.some((id) => !evidenceIds.has(id)))
  ) {
    return invalid("QA session result and finding evidence references must exist in the session.");
  }
  if (
    blockedTests.some((id) => !results.some((result) => result.testId === id && result.status === "BLOCKED")) ||
    results.some((result) => result.status === "BLOCKED" && !blockedTests.includes(result.testId))
  ) {
    return invalid("QA session blockedTests must exactly reference blocked results.");
  }
  const computedCounts = {
    passed: results.filter((result) => result.status === "PASS").length,
    failed: results.filter((result) => result.status === "FAIL").length,
    blocked: results.filter((result) => result.status === "BLOCKED").length,
    notRun: results.filter((result) => result.status === "NOT_RUN").length,
    gameplayPending: results.filter((result) => result.category === "GAMEPLAY" && result.status === "NOT_RUN").length,
  };
  if (
    summary.passed !== computedCounts.passed ||
    summary.failed !== computedCounts.failed ||
    summary.blocked !== computedCounts.blocked ||
    summary.notRun !== computedCounts.notRun ||
    summary.gameplayPending !== computedCounts.gameplayPending
  ) {
    return invalid("QA session summary counts do not match its results.");
  }
  if (status !== "RUNNING" && status !== "TECHNICAL_FAILURE" && resultIds.size !== plannedIds.size) {
    return invalid("A completed QA cycle must contain one result for every planned test.");
  }
  if (status === "PASS" && results.some((result) => result.status !== "PASS")) {
    return invalid("A passing QA session cannot contain non-passing results.");
  }
  if (
    status === "INCOMPLETE_GAMEPLAY" &&
    (
      computedCounts.gameplayPending === 0 ||
      results.some((result) => result.category !== "GAMEPLAY" && result.status !== "PASS") ||
      results.some((result) => result.category === "GAMEPLAY" && (
        result.status !== "NOT_RUN" || result.blockingReason !== "REQUIRES_M8_GAMEPLAY_QA"
      ))
    )
  ) {
    return invalid("INCOMPLETE_GAMEPLAY requires passed M7 tests and pending M8 gameplay tests.");
  }
  return {
    schemaVersion: 1,
    sessionId: string(input.sessionId, "QA session.sessionId", 100),
    taskId: parseTaskId(input.taskId),
    cycleNumber: integer(input.cycleNumber, "QA session.cycleNumber", 1),
    startedAt: timestamp(input.startedAt, "QA session.startedAt"),
    ...(completedAt === undefined ? {} : { completedAt }),
    status,
    plannedTests,
    results,
    findings,
    blockedTests,
    evidence,
    ...(unityEnvironment === undefined ? {} : { unityEnvironment }),
    ...(qaAgentRunId === undefined ? {} : { qaAgentRunId }),
    summary,
    ...(technicalFailure === undefined ? {} : { technicalFailure }),
  };
};

export const parseQAReport = (value: unknown): QAReport => {
  const input = record(value, "QA report");
  if (input.schemaVersion !== 1 || !Array.isArray(input.results) || !Array.isArray(input.findings) || !Array.isArray(input.blockedTests)) {
    return invalid("QA report schema or arrays are invalid.");
  }
  const outcome = enumeration(
    input.outcome,
    QA_SESSION_STATUSES.filter((status) => status !== "RUNNING"),
    "QA report.outcome",
  ) as QAReport["outcome"];
  if (typeof input.manualFixAvailable !== "boolean") {
    return invalid("QA report.manualFixAvailable must be a boolean.");
  }
  return {
    schemaVersion: 1,
    sessionId: string(input.sessionId, "QA report.sessionId", 100),
    taskId: parseTaskId(input.taskId),
    cycleNumber: integer(input.cycleNumber, "QA report.cycleNumber", 1),
    outcome,
    summary: parseSummary(input.summary, "QA report.summary"),
    results: input.results.map((entry, index) => parseTestResult(entry, `QA report.results[${index}]`)),
    findings: input.findings.map((entry, index) => parseFinding(entry, `QA report.findings[${index}]`)),
    blockedTests: strings(input.blockedTests, "QA report.blockedTests"),
    generatedAt: timestamp(input.generatedAt, "QA report.generatedAt"),
    manualFixAvailable: input.manualFixAvailable,
  };
};

export const parseFixAgentOutput = (value: unknown): FixAgentOutput => {
  const input = record(value, "Fix agent output");
  return {
    summary: string(input.summary, "Fix agent output.summary", 20_000),
    fixedFindingIds: strings(input.fixedFindingIds, "Fix agent output.fixedFindingIds"),
    changedFiles: strings(input.changedFiles, "Fix agent output.changedFiles"),
    fixNotes: strings(input.fixNotes, "Fix agent output.fixNotes"),
    sanityChecks: strings(input.sanityChecks, "Fix agent output.sanityChecks"),
    warnings: strings(input.warnings, "Fix agent output.warnings"),
  };
};

export const parseFixResult = (value: unknown): FixResult => {
  const input = record(value, "Fix result");
  if (input.schemaVersion !== 1 || input.status !== "SUCCEEDED" || input.automatic === undefined || typeof input.automatic !== "boolean") {
    return invalid("Fix result schema, status, or automatic flag is invalid.");
  }
  const route = record(input.route, "Fix result.route");
  const effort = parseReasoningEffort(input.effort, "Fix result.effort");
  const routeEffort = parseReasoningEffort(route.effort, "Fix result.route.effort");
  const fixId = string(input.fixId, "Fix result.fixId", 100);
  const providerId = string(input.providerId, "Fix result.providerId", 200);
  const modelId = string(input.modelId, "Fix result.modelId", 200);
  const routeProviderId = string(route.providerId, "Fix result.route.providerId", 200);
  const routeModelId = string(route.modelId, "Fix result.route.modelId", 200);
  if (!/^FIX-\d{3,}$/u.test(fixId)) {
    return invalid("Fix result.fixId must use the FIX-001 format.");
  }
  if (providerId !== routeProviderId || modelId !== routeModelId || effort !== routeEffort) {
    return invalid("Fix result execution identity must match its persisted route.");
  }
  return {
    schemaVersion: 1,
    ...parseFixAgentOutput(input),
    fixId,
    taskId: parseTaskId(input.taskId),
    sourceSessionId: string(input.sourceSessionId, "Fix result.sourceSessionId", 100),
    automatic: input.automatic,
    runId: string(input.runId, "Fix result.runId", 100),
    providerId,
    modelId,
    effort,
    route: {
      providerId: routeProviderId,
      modelId: routeModelId,
      providerModelName: string(route.providerModelName, "Fix result.route.providerModelName", 200),
      effort: routeEffort,
    },
    status: "SUCCEEDED",
    startedAt: timestamp(input.startedAt, "Fix result.startedAt"),
    finishedAt: timestamp(input.finishedAt, "Fix result.finishedAt"),
    checkpointId: string(input.checkpointId, "Fix result.checkpointId", 100),
    checkpointCommit: string(input.checkpointCommit, "Fix result.checkpointCommit", 200),
  };
};
