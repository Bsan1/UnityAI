import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { applicationInfo } from "@unityai/core";

import { createUnityAiServer } from "./app.js";
import { bootstrapAIService } from "./aiBootstrap.js";
import { AnalysisArtifactStore } from "./analysisArtifactStore.js";
import { AnalysisService } from "./analysisService.js";
import { loadTaskSettings } from "./config.js";
import { GitCommandRunner } from "./gitCommandRunner.js";
import { GitEnvironmentStore } from "./gitEnvironmentStore.js";
import { GitSafetyService } from "./gitSafetyService.js";
import { ImplementationOrchestrator } from "./implementationOrchestrator.js";
import { OrchestrationArtifactStore } from "./orchestrationArtifactStore.js";
import { ProjectRegistry } from "./projectRegistry.js";
import { QAArtifactStore } from "./qaArtifactStore.js";
import { QAOrchestrator } from "./qaOrchestrator.js";
import { SettingsStore } from "./settingsStore.js";
import { TaskService } from "./taskService.js";
import { TaskStore } from "./taskStore.js";
import { WorkflowService } from "./workflowService.js";
import { UnityEnvironmentService } from "./unityEnvironmentService.js";
import { UnityEnvironmentStore } from "./unityEnvironmentStore.js";

const host = "127.0.0.1";
const defaultPort = 3000;
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

const resolvePort = (value: string | undefined): number => {
  if (value === undefined) {
    return defaultPort;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error("UNITYAI_PORT must be an integer between 1 and 65535.");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("UNITYAI_PORT must be an integer between 1 and 65535.");
  }
  return port;
};

const runtimeRoot =
  process.env.UNITYAI_RUNTIME_PATH ?? join(workspaceRoot, "runtime");
const configPath =
  process.env.UNITYAI_CONFIG_PATH ?? join(workspaceRoot, "config", "defaults.json");
const agentsDirectory =
  process.env.UNITYAI_AGENTS_PATH ?? join(workspaceRoot, "agents");
const modelsPath =
  process.env.UNITYAI_MODELS_CONFIG_PATH ??
  join(workspaceRoot, "config", "models.json");
const providersPath =
  process.env.UNITYAI_PROVIDERS_CONFIG_PATH ??
  join(workspaceRoot, "config", "providers.json");
const defaultSettings = await loadTaskSettings(configPath);
const settingsStore = new SettingsStore(runtimeRoot);
const settings = await settingsStore.initialize(defaultSettings);
const store = new TaskStore(runtimeRoot);
await store.initialize();
const service = new TaskService(store, settings);
const gitEnvironmentStore = new GitEnvironmentStore(runtimeRoot);
await gitEnvironmentStore.initialize();
const gitRunner = new GitCommandRunner((operation) => {
  console.info(`[git] ${operation}`);
});
const projectRegistry = new ProjectRegistry(runtimeRoot, gitRunner);
await projectRegistry.initialize();
const gitService = new GitSafetyService(
  service,
  gitEnvironmentStore,
  join(runtimeRoot, "worktrees"),
  gitRunner,
);
const aiService = await bootstrapAIService({
  agentsDirectory,
  modelsPath,
  providersPath,
  runtimeRoot,
});
const analysisArtifacts = new AnalysisArtifactStore(runtimeRoot);
await analysisArtifacts.initialize();
const analysisService = new AnalysisService(
  service,
  analysisArtifacts,
  aiService,
);
const orchestrationArtifacts = new OrchestrationArtifactStore(runtimeRoot);
await orchestrationArtifacts.initialize();
const implementationOrchestrator = new ImplementationOrchestrator(
  service,
  gitService,
  aiService,
  analysisArtifacts,
  orchestrationArtifacts,
);
await implementationOrchestrator.recoverInterruptedRuns();
const unityEnvironmentStore = new UnityEnvironmentStore(runtimeRoot);
await unityEnvironmentStore.initialize();
const unityEnvironmentService = new UnityEnvironmentService({
  tasks: service,
  git: gitService,
  projects: projectRegistry,
  store: unityEnvironmentStore,
  runtimeRoot,
  bridgeSourcePackagePath: join(
    workspaceRoot,
    "unity",
    "Packages",
    "com.unityai.editor-bridge",
  ),
});
const qaArtifacts = new QAArtifactStore(runtimeRoot);
await qaArtifacts.initialize();
const qaOrchestrator = new QAOrchestrator(
  {
    tasks: service,
    git: gitService,
    ai: aiService,
    unity: unityEnvironmentService,
    analysis: analysisArtifacts,
    orchestration: orchestrationArtifacts,
    artifacts: qaArtifacts,
  },
  {
    unityMcpEntrypoint: join(
      workspaceRoot,
      "apps",
      "unity-mcp",
      "dist",
      "main.js",
    ),
  },
);
await qaOrchestrator.recoverInterruptedRuns();
const workflowService = new WorkflowService({
  tasks: service,
  projects: projectRegistry,
  settings: settingsStore,
  analysis: analysisArtifacts,
  git: gitService,
  orchestration: implementationOrchestrator,
  orchestrationArtifacts,
  qa: qaOrchestrator,
});
const server = createUnityAiServer(
  service,
  gitService,
  aiService,
  analysisService,
  {
    projects: projectRegistry,
    settings: settingsStore,
    workflow: workflowService,
    orchestrator: implementationOrchestrator,
    unity: unityEnvironmentService,
    qa: qaOrchestrator,
  },
);
const port = resolvePort(process.env.UNITYAI_PORT);

server.listen(port, host, () => {
  console.log(`${applicationInfo.name} server listening at http://${host}:${port}`);
});
