import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { applicationInfo } from "@unityai/core";

import { createUnityAiServer } from "./app.js";
import { bootstrapAIService } from "./aiBootstrap.js";
import { loadTaskSettings } from "./config.js";
import { GitCommandRunner } from "./gitCommandRunner.js";
import { GitEnvironmentStore } from "./gitEnvironmentStore.js";
import { GitSafetyService } from "./gitSafetyService.js";
import { TaskService } from "./taskService.js";
import { TaskStore } from "./taskStore.js";

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
const settings = await loadTaskSettings(configPath);
const store = new TaskStore(runtimeRoot);
await store.initialize();
const service = new TaskService(store, settings);
const gitEnvironmentStore = new GitEnvironmentStore(runtimeRoot);
await gitEnvironmentStore.initialize();
const gitRunner = new GitCommandRunner((operation) => {
  console.info(`[git] ${operation}`);
});
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
const server = createUnityAiServer(service, gitService, aiService);
const port = resolvePort(process.env.UNITYAI_PORT);

server.listen(port, host, () => {
  console.log(`${applicationInfo.name} server listening at http://${host}:${port}`);
});
