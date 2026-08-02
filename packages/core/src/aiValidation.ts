import { TaskDomainError } from "./errors.js";
import {
  AGENT_PERMISSIONS,
  AGENT_TOOL_POLICIES,
  MODEL_ROUTING_WORK,
  REASONING_EFFORTS,
} from "./aiTypes.js";
import type {
  AIProviderConfiguration,
  AgentDefinition,
  AgentPermission,
  AgentToolPolicy,
  JsonObject,
  JsonValue,
  ModelCapabilities,
  ModelConfiguration,
  ModelDefinition,
  ModelRoutingEntry,
  ModelRoutingStrength,
  ModelRoutingWork,
  ProviderConfiguration,
  ReasoningEffort,
} from "./aiTypes.js";
import { TASK_STRENGTHS } from "./taskTypes.js";

type JsonRecord = Record<string, unknown>;

const identifierPattern = /^[a-z][a-z0-9-]{1,63}$/;
const permissionSet = new Set<string>(AGENT_PERMISSIONS);
const toolPolicySet = new Set<string>(AGENT_TOOL_POLICIES);
const effortSet = new Set<string>(REASONING_EFFORTS);
const routingWorkSet = new Set<string>(MODEL_ROUTING_WORK);
const routingStrengthSet = new Set<string>(["ALL", ...TASK_STRENGTHS]);

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

const readIdentifier = (value: unknown, path: string): string => {
  const identifier = readString(value, path);
  if (!identifierPattern.test(identifier)) {
    return invalid(`${path} must be a lowercase kebab-case identifier.`);
  }
  return identifier;
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

const parseJsonValue = (value: unknown, path: string): JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      parseJsonValue(item, `${path}[${index}]`),
    );
  }
  const record = readRecord(value, path);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      parseJsonValue(item, `${path}.${key}`),
    ]),
  );
};

const parseJsonObject = (value: unknown, path: string): JsonObject => {
  const parsed = parseJsonValue(value, path);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalid(`${path} must be a JSON object.`);
  }
  return parsed as JsonObject;
};

const parseReasoningEffort = (
  value: unknown,
  path: string,
): ReasoningEffort => {
  if (typeof value !== "string" || !effortSet.has(value)) {
    return invalid(`${path} is not a supported reasoning-effort value.`);
  }
  return value as ReasoningEffort;
};

export const parseAgentDefinition = (value: unknown): AgentDefinition => {
  const record = readRecord(value, "agent definition");
  if (record.schemaVersion !== 1) {
    return invalid("agent definition.schemaVersion must be 1.");
  }
  const permissionValue = record.permission;
  if (
    typeof permissionValue !== "string" ||
    !permissionSet.has(permissionValue)
  ) {
    return invalid("agent definition.permission is not recognized.");
  }
  const permission = permissionValue as AgentPermission;
  const toolPolicyValue = record.toolPolicy;
  if (
    typeof toolPolicyValue !== "string" ||
    !toolPolicySet.has(toolPolicyValue)
  ) {
    return invalid("agent definition.toolPolicy is not recognized.");
  }
  const toolPolicy = toolPolicyValue as AgentToolPolicy;
  if (
    (permission === "READ_ONLY" && toolPolicy !== "READ_ONLY_TOOLS") ||
    (permission === "WORKTREE_WRITE" && toolPolicy !== "WORKTREE_TOOLS")
  ) {
    return invalid(
      "Agent permission and tool policy must describe the same access level.",
    );
  }

  const context = readRecord(
    record.contextPolicy,
    "agent definition.contextPolicy",
  );
  if (typeof context.includeRepositoryInstructions !== "boolean") {
    return invalid(
      "agent definition.contextPolicy.includeRepositoryInstructions must be a boolean.",
    );
  }

  const expectedOutputSchema =
    record.expectedOutputSchema === undefined
      ? undefined
      : parseJsonObject(
          record.expectedOutputSchema,
          "agent definition.expectedOutputSchema",
        );

  return {
    schemaVersion: 1,
    id: readIdentifier(record.id, "agent definition.id"),
    displayName: readString(
      record.displayName,
      "agent definition.displayName",
    ),
    role: readString(record.role, "agent definition.role"),
    instructions: readString(
      record.instructions,
      "agent definition.instructions",
    ),
    permission,
    toolPolicy,
    contextPolicy: {
      includeRepositoryInstructions: context.includeRepositoryInstructions,
      maximumInputCharacters: readInteger(
        context.maximumInputCharacters,
        "agent definition.contextPolicy.maximumInputCharacters",
        1,
        1_000_000,
      ),
    },
    ...(expectedOutputSchema === undefined ? {} : { expectedOutputSchema }),
  };
};

const parseModelCapabilities = (value: unknown): ModelCapabilities => {
  const record = readRecord(value, "model.capabilities");
  if (typeof record.structuredOutput !== "boolean") {
    return invalid("model.capabilities.structuredOutput must be a boolean.");
  }
  return { structuredOutput: record.structuredOutput };
};

const parseModel = (value: unknown, index: number): ModelDefinition => {
  const path = `model configuration.models[${index}]`;
  const record = readRecord(value, path);
  if (!Array.isArray(record.supportedReasoningEfforts)) {
    return invalid(`${path}.supportedReasoningEfforts must be an array.`);
  }
  const supportedReasoningEfforts = record.supportedReasoningEfforts.map(
    (effort, effortIndex) =>
      parseReasoningEffort(
        effort,
        `${path}.supportedReasoningEfforts[${effortIndex}]`,
      ),
  );
  if (
    supportedReasoningEfforts.length === 0 ||
    new Set(supportedReasoningEfforts).size !== supportedReasoningEfforts.length
  ) {
    return invalid(
      `${path}.supportedReasoningEfforts must be non-empty and unique.`,
    );
  }
  return {
    id: readIdentifier(record.id, `${path}.id`),
    displayName: readString(record.displayName, `${path}.displayName`),
    providerId: readIdentifier(record.providerId, `${path}.providerId`),
    providerModelName: readString(
      record.providerModelName,
      `${path}.providerModelName`,
    ),
    supportedReasoningEfforts,
    capabilities: parseModelCapabilities(record.capabilities),
  };
};

const parseRoutingEntry = (
  value: unknown,
  index: number,
): ModelRoutingEntry => {
  const path = `model configuration.routing[${index}]`;
  const record = readRecord(value, path);
  if (typeof record.work !== "string" || !routingWorkSet.has(record.work)) {
    return invalid(`${path}.work is not recognized.`);
  }
  if (
    typeof record.taskStrength !== "string" ||
    !routingStrengthSet.has(record.taskStrength)
  ) {
    return invalid(`${path}.taskStrength is not recognized.`);
  }
  return {
    work: record.work as ModelRoutingWork,
    taskStrength: record.taskStrength as ModelRoutingStrength,
    modelId: readIdentifier(record.modelId, `${path}.modelId`),
    ...(record.effort === undefined
      ? {}
      : { effort: parseReasoningEffort(record.effort, `${path}.effort`) }),
  };
};

export const parseModelConfiguration = (value: unknown): ModelConfiguration => {
  const record = readRecord(value, "model configuration");
  if (record.schemaVersion !== 1) {
    return invalid("model configuration.schemaVersion must be 1.");
  }
  if (!Array.isArray(record.models) || !Array.isArray(record.routing)) {
    return invalid("model configuration models and routing must be arrays.");
  }
  const models = record.models.map(parseModel);
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    return invalid("Model IDs must be unique.");
  }
  const modelsById = new Map(models.map((model) => [model.id, model]));
  const routing = record.routing.map(parseRoutingEntry);
  const routingKeys = routing.map(
    (entry) => `${entry.work}:${entry.taskStrength}`,
  );
  if (new Set(routingKeys).size !== routingKeys.length) {
    return invalid("Model routing work/strength entries must be unique.");
  }
  for (const entry of routing) {
    const model = modelsById.get(entry.modelId);
    if (model === undefined) {
      return invalid(`Routing references unknown model ${entry.modelId}.`);
    }
    if (
      entry.effort !== undefined &&
      !model.supportedReasoningEfforts.includes(entry.effort)
    ) {
      return invalid(
        `Routing effort ${entry.effort} is unsupported by ${entry.modelId}.`,
      );
    }
  }
  if (record.fixWork !== "SAME_AS_IMPLEMENTATION") {
    return invalid(
      "model configuration.fixWork must be SAME_AS_IMPLEMENTATION.",
    );
  }
  if (record.runtimeEscalation !== false) {
    return invalid("model configuration.runtimeEscalation must be false.");
  }
  return {
    schemaVersion: 1,
    models,
    routing,
    fixWork: "SAME_AS_IMPLEMENTATION",
    runtimeEscalation: false,
  };
};

const parseProvider = (
  value: unknown,
  index: number,
): ProviderConfiguration => {
  const path = `provider configuration.providers[${index}]`;
  const record = readRecord(value, path);
  if (typeof record.enabled !== "boolean") {
    return invalid(`${path}.enabled must be a boolean.`);
  }
  return {
    id: readIdentifier(record.id, `${path}.id`),
    displayName: readString(record.displayName, `${path}.displayName`),
    executable: readString(record.executable, `${path}.executable`),
    enabled: record.enabled,
  };
};

export const parseAIProviderConfiguration = (
  value: unknown,
): AIProviderConfiguration => {
  const record = readRecord(value, "provider configuration");
  if (record.schemaVersion !== 1) {
    return invalid("provider configuration.schemaVersion must be 1.");
  }
  if (!Array.isArray(record.providers)) {
    return invalid("provider configuration.providers must be an array.");
  }
  const providers = record.providers.map(parseProvider);
  if (
    new Set(providers.map((provider) => provider.id)).size !== providers.length
  ) {
    return invalid("Provider IDs must be unique.");
  }
  return {
    schemaVersion: 1,
    defaultTimeoutMs: readInteger(
      record.defaultTimeoutMs,
      "provider configuration.defaultTimeoutMs",
      1_000,
      3_600_000,
    ),
    maximumPersistedLogBytes: readInteger(
      record.maximumPersistedLogBytes,
      "provider configuration.maximumPersistedLogBytes",
      1_024,
      10_485_760,
    ),
    providers,
  };
};

export { parseReasoningEffort };
