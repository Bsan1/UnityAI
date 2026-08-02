import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TaskDomainError,
  parseAgentDefinition,
  parseModelConfiguration,
} from "../src/index.js";

const readOnlyAgent = {
  schemaVersion: 1,
  id: "development-reader",
  displayName: "Development Reader",
  role: "Read a selected project",
  instructions: "Inspect only the supplied context.",
  permission: "READ_ONLY",
  toolPolicy: "READ_ONLY_TOOLS",
  contextPolicy: {
    includeRepositoryInstructions: true,
    maximumInputCharacters: 1000,
  },
};

test("agent definitions validate without model or provider configuration", () => {
  const agent = parseAgentDefinition(readOnlyAgent);
  assert.equal(agent.id, "development-reader");
  assert.equal(agent.permission, "READ_ONLY");
  assert.equal("model" in agent, false);
  assert.equal("provider" in agent, false);
});

test("read-only and writable agent permission metadata remain distinct", () => {
  const reader = parseAgentDefinition(readOnlyAgent);
  const writer = parseAgentDefinition({
    ...readOnlyAgent,
    id: "development-writer",
    permission: "WORKTREE_WRITE",
    toolPolicy: "WORKTREE_TOOLS",
  });
  assert.notEqual(reader.permission, writer.permission);
  assert.throws(
    () =>
      parseAgentDefinition({
        ...readOnlyAgent,
        permission: "READ_ONLY",
        toolPolicy: "WORKTREE_TOOLS",
      }),
    (error: unknown) => error instanceof TaskDomainError,
  );
});

test("model routing validates references and never enables escalation", () => {
  const configuration = parseModelConfiguration({
    schemaVersion: 1,
    models: [
      {
        id: "test-model",
        displayName: "Test Model",
        providerId: "test-provider",
        providerModelName: "provider-model-name",
        supportedReasoningEfforts: ["medium"],
        capabilities: { structuredOutput: true },
      },
    ],
    routing: [
      {
        work: "INTERPRETER",
        taskStrength: "ALL",
        modelId: "test-model",
        effort: "medium",
      },
    ],
    fixWork: "SAME_AS_IMPLEMENTATION",
    runtimeEscalation: false,
  });
  assert.equal(configuration.routing[0]?.modelId, "test-model");
  assert.equal(configuration.runtimeEscalation, false);
  assert.equal(configuration.fixWork, "SAME_AS_IMPLEMENTATION");
});
