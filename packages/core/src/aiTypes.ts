import type { TaskStrength } from "./taskTypes.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export const AGENT_PERMISSIONS = ["READ_ONLY", "WORKTREE_WRITE"] as const;
export type AgentPermission = (typeof AGENT_PERMISSIONS)[number];

export const AGENT_TOOL_POLICIES = [
  "READ_ONLY_TOOLS",
  "WORKTREE_TOOLS",
] as const;
export type AgentToolPolicy = (typeof AGENT_TOOL_POLICIES)[number];

export interface AgentContextPolicy {
  readonly includeRepositoryInstructions: boolean;
  readonly maximumInputCharacters: number;
}

export interface AgentDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly role: string;
  readonly instructions: string;
  readonly permission: AgentPermission;
  readonly toolPolicy: AgentToolPolicy;
  readonly contextPolicy: AgentContextPolicy;
  readonly expectedOutputSchema?: JsonObject;
}

export const REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelCapabilities {
  readonly structuredOutput: boolean;
}

export interface ModelDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly providerModelName: string;
  readonly supportedReasoningEfforts: readonly ReasoningEffort[];
  readonly capabilities: ModelCapabilities;
}

export const MODEL_ROUTING_WORK = [
  "INTERPRETER",
  "FEASIBILITY",
  "IMPLEMENTATION",
  "QA_REASONING",
  "CROSS_REVIEW",
] as const;
export type ModelRoutingWork = (typeof MODEL_ROUTING_WORK)[number];
export type ModelRoutingStrength = TaskStrength | "ALL";

export interface ModelRoutingEntry {
  readonly work: ModelRoutingWork;
  readonly taskStrength: ModelRoutingStrength;
  readonly modelId: string;
  readonly effort?: ReasoningEffort;
}

export interface ModelConfiguration {
  readonly schemaVersion: 1;
  readonly models: readonly ModelDefinition[];
  readonly routing: readonly ModelRoutingEntry[];
  readonly fixWork: "SAME_AS_IMPLEMENTATION";
  readonly runtimeEscalation: false;
}

export interface ProviderConfiguration {
  readonly id: string;
  readonly displayName: string;
  readonly executable: string;
  readonly enabled: boolean;
}

export interface AIProviderConfiguration {
  readonly schemaVersion: 1;
  readonly defaultTimeoutMs: number;
  readonly maximumPersistedLogBytes: number;
  readonly providers: readonly ProviderConfiguration[];
}
