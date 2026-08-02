import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { TaskDomainError, applicationInfo } from "@unityai/core";
import { UnityIntegrationError } from "@unityai/unity";
import type { HealthResponse } from "@unityai/shared";

import type { AIService } from "./aiService.js";
import type { AnalysisService } from "./analysisService.js";
import { ServerError } from "./errors.js";
import type { GitSafetyService } from "./gitSafetyService.js";
import type { ImplementationOrchestrator } from "./implementationOrchestrator.js";
import type { ProjectRegistry } from "./projectRegistry.js";
import type { SettingsStore } from "./settingsStore.js";
import type { TaskService } from "./taskService.js";
import type { WorkflowService } from "./workflowService.js";
import type { UnityEnvironmentService } from "./unityEnvironmentService.js";

export interface M5ServerServices {
  readonly projects: ProjectRegistry;
  readonly settings: SettingsStore;
  readonly workflow: WorkflowService;
  readonly orchestrator: ImplementationOrchestrator;
  readonly unity?: UnityEnvironmentService;
}

const maximumBodyBytes = 1_048_576;

const healthResponse: HealthResponse = {
  status: "ok",
  app: applicationInfo.name,
  version: applicationInfo.version,
  milestone: applicationInfo.milestone,
};

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const rawChunk of request as AsyncIterable<unknown>) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk as Uint8Array);
    length += chunk.length;
    if (length > maximumBodyBytes) {
      throw new ServerError(
        "REQUEST_TOO_LARGE",
        "Request body exceeds 1 MiB.",
        413,
      );
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ServerError("INVALID_JSON", "Request body is not valid JSON.", 400);
  }
};

const handleTaskAction = async (
  request: IncomingMessage,
  response: ServerResponse,
  service: TaskService,
  id: string,
  action: string,
  analysisService: AnalysisService | undefined,
  m5: M5ServerServices | undefined,
): Promise<boolean> => {
  if (request.method === "PATCH" && action === "draft") {
    const task = await service.editDraft(id, await readJsonBody(request));
    sendJson(response, 200, { task });
    return true;
  }

  if (
    request.method === "GET" &&
    action === "analysis" &&
    analysisService !== undefined
  ) {
    sendJson(response, 200, await analysisService.getAnalysis(id));
    return true;
  }

  if (request.method === "GET" && action === "progress" && m5 !== undefined) {
    sendJson(response, 200, { progress: await m5.workflow.getProgress(id) });
    return true;
  }

  if (request.method === "GET" && action === "details" && m5 !== undefined) {
    sendJson(response, 200, await m5.workflow.getDetails(id));
    return true;
  }

  if (request.method === "GET" && action === "events" && m5 !== undefined) {
    const progress = await m5.workflow.getProgress(id);
    sendJson(response, 200, { events: progress.events });
    return true;
  }

  if (
    request.method === "PATCH" &&
    action === "contract" &&
    analysisService !== undefined
  ) {
    sendJson(
      response,
      200,
      await analysisService.editContract(id, await readJsonBody(request)),
    );
    return true;
  }

  if (request.method !== "POST") {
    return false;
  }

  switch (action) {
    case "submit": {
      const task = await service.submitDraft(id);
      sendJson(response, 200, { task });
      return true;
    }
    case "analyze": {
      if (analysisService === undefined) {
        const task = await service.analyze(id);
        sendJson(response, 200, { task });
        return true;
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      const abortOnPrematureClose = (): void => {
        if (!response.writableEnded) {
          controller.abort();
        }
      };
      request.once("aborted", abort);
      response.once("close", abortOnPrematureClose);
      try {
        sendJson(
          response,
          200,
          await analysisService.analyze(id, controller.signal),
        );
      } finally {
        request.off("aborted", abort);
        response.off("close", abortOnPrematureClose);
      }
      return true;
    }
    case "feasibility": {
      const task = await service.storeFeasibility(
        id,
        await readJsonBody(request),
      );
      sendJson(response, 200, { task });
      return true;
    }
    case "contract": {
      const task = await service.storeContract(id, await readJsonBody(request));
      sendJson(response, 200, { task });
      return true;
    }
    case "approve": {
      const result = analysisService === undefined
        ? { task: await service.approve(id) }
        : await analysisService.approve(id);
      sendJson(response, 200, result);
      return true;
    }
    case "pause": {
      m5?.orchestrator.abort(id);
      const task = await service.pause(id, await readJsonBody(request));
      sendJson(response, 200, { task });
      return true;
    }
    case "resume": {
      const task = await service.resume(id);
      sendJson(response, 200, { task });
      return true;
    }
    case "recheck": {
      if (analysisService === undefined) {
        const task = await service.recheck(id);
        sendJson(response, 200, { task });
        return true;
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      const abortOnPrematureClose = (): void => {
        if (!response.writableEnded) {
          controller.abort();
        }
      };
      request.once("aborted", abort);
      response.once("close", abortOnPrematureClose);
      try {
        sendJson(
          response,
          200,
          await analysisService.recheck(id, controller.signal),
        );
      } finally {
        request.off("aborted", abort);
        response.off("close", abortOnPrematureClose);
      }
      return true;
    }
    case "cancel": {
      m5?.orchestrator.abort(id);
      const task = await service.cancel(id, await readJsonBody(request));
      sendJson(response, 200, { task });
      return true;
    }
    case "prerequisite-draft": {
      const result = await service.createPrerequisiteDraft(
        id,
        await readJsonBody(request),
      );
      sendJson(response, 201, result);
      return true;
    }
    case "start-implementation": {
      if (m5 === undefined) {
        return false;
      }
      sendJson(response, 202, {
        run: await m5.orchestrator.start(id),
      });
      return true;
    }
    default:
      return false;
  }
};

const handleGitRoute = async (
  request: IncomingMessage,
  response: ServerResponse,
  gitService: GitSafetyService,
  id: string,
  action: string | undefined,
): Promise<boolean> => {
  if (action === undefined && request.method === "GET") {
    sendJson(response, 200, await gitService.getEnvironmentWithStatus(id));
    return true;
  }

  if (action === "inspect" && request.method === "POST") {
    sendJson(response, 200, { inspection: await gitService.inspect(id) });
    return true;
  }
  if (action === "prepare" && request.method === "POST") {
    sendJson(response, 200, { environment: await gitService.prepare(id) });
    return true;
  }
  if (action === "status" && request.method === "GET") {
    sendJson(response, 200, { status: await gitService.status(id) });
    return true;
  }
  if (action === "diff" && request.method === "GET") {
    sendJson(response, 200, { diff: await gitService.diff(id) });
    return true;
  }
  if (action === "checkpoint" && request.method === "POST") {
    sendJson(
      response,
      200,
      await gitService.checkpoint(id, await readJsonBody(request)),
    );
    return true;
  }
  if (action === "rollback" && request.method === "POST") {
    sendJson(
      response,
      200,
      await gitService.rollback(id, await readJsonBody(request)),
    );
    return true;
  }
  if (action === "finalize" && request.method === "POST") {
    sendJson(response, 200, {
      environment: await gitService.finalize(id, await readJsonBody(request)),
    });
    return true;
  }
  if (action === "cleanup" && request.method === "POST") {
    sendJson(response, 200, {
      environment: await gitService.cleanup(id, await readJsonBody(request)),
    });
    return true;
  }

  return false;
};

const handleAIRoute = async (
  request: IncomingMessage,
  response: ServerResponse,
  aiService: AIService,
  path: string,
): Promise<boolean> => {
  if (request.method === "GET" && path === "/ai/providers") {
    sendJson(response, 200, {
      providers: await aiService.providerAvailability(),
    });
    return true;
  }
  if (request.method === "GET" && path === "/ai/models") {
    sendJson(response, 200, aiService.getModelConfiguration());
    return true;
  }
  if (request.method === "GET" && path === "/ai/agents") {
    sendJson(response, 200, { agents: aiService.listAgents() });
    return true;
  }
  if (request.method === "POST" && path === "/ai/execute") {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const abortOnPrematureClose = (): void => {
      if (!response.writableEnded) {
        controller.abort();
      }
    };
    request.once("aborted", abort);
    response.once("close", abortOnPrematureClose);
    try {
      const execution = await aiService.execute(
        await readJsonBody(request),
        controller.signal,
      );
      sendJson(response, 200, { execution });
    } finally {
      request.off("aborted", abort);
      response.off("close", abortOnPrematureClose);
    }
    return true;
  }
  return false;
};

const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  service: TaskService,
  gitService: GitSafetyService,
  aiService: AIService | undefined,
  analysisService: AnalysisService | undefined,
  m5: M5ServerServices | undefined,
): Promise<void> => {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = requestUrl.pathname;

  if (request.method === "GET" && path === "/health") {
    sendJson(response, 200, healthResponse);
    return;
  }

  if (
    aiService !== undefined &&
    (await handleAIRoute(request, response, aiService, path))
  ) {
    return;
  }

  if (path === "/settings" && m5 !== undefined) {
    if (request.method === "GET") {
      sendJson(response, 200, { settings: m5.workflow.getSettings() });
      return;
    }
    if (request.method === "PATCH") {
      sendJson(response, 200, {
        settings: await m5.workflow.updateSettings(await readJsonBody(request)),
      });
      return;
    }
  }

  if (path === "/projects" && m5 !== undefined) {
    if (request.method === "GET") {
      sendJson(response, 200, { projects: m5.projects.list() });
      return;
    }
    if (request.method === "POST") {
      sendJson(response, 201, {
        project: await m5.projects.create(await readJsonBody(request)),
      });
      return;
    }
  }

  const projectUnityRoute = /^\/projects\/(PROJECT-\d{4,})\/unity$/.exec(path);
  if (
    projectUnityRoute !== null &&
    request.method === "GET" &&
    m5?.unity !== undefined
  ) {
    const projectId = projectUnityRoute[1];
    if (projectId !== undefined) {
      sendJson(response, 200, await m5.unity.inspectProject(projectId));
      return;
    }
  }

  const projectRoute = /^\/projects\/(PROJECT-\d{4,})$/.exec(path);
  if (projectRoute !== null && m5 !== undefined) {
    const projectId = projectRoute[1];
    if (projectId !== undefined && request.method === "GET") {
      sendJson(response, 200, { project: m5.projects.get(projectId) });
      return;
    }
    if (projectId !== undefined && request.method === "PATCH") {
      sendJson(response, 200, {
        project: await m5.projects.update(projectId, await readJsonBody(request)),
      });
      return;
    }
    if (projectId !== undefined && request.method === "DELETE") {
      sendJson(response, 200, {
        project: await m5.projects.remove(projectId),
        removedRegistryOnly: true,
      });
      return;
    }
  }

  if (path === "/tasks") {
    if (request.method === "GET") {
      sendJson(response, 200, { tasks: await service.list() });
      return;
    }
    if (request.method === "POST") {
      const body = await readJsonBody(request);
      const task = m5 === undefined
        ? await service.create(body)
        : await m5.workflow.createTask(body);
      sendJson(response, 201, { task });
      return;
    }
  }

  const gitRoute = /^\/tasks\/(TASK-\d{4,})\/git(?:\/([a-z-]+))?$/.exec(path);
  if (gitRoute !== null) {
    const id = gitRoute[1];
    if (
      id !== undefined &&
      (await handleGitRoute(request, response, gitService, id, gitRoute[2]))
    ) {
      return;
    }
  }

  const unityRoute = /^\/tasks\/(TASK-\d{4,})\/unity(?:\/(editor|bridge)(?:\/([a-z-]+))?)?$/.exec(path);
  if (unityRoute !== null && m5?.unity !== undefined) {
    const id = unityRoute[1];
    const area = unityRoute[2];
    const action = unityRoute[3];
    if (id !== undefined && area === undefined && request.method === "GET") {
      sendJson(response, 200, await m5.unity.status(id));
      return;
    }
    if (id !== undefined && area === undefined && request.method === "POST") {
      sendJson(response, 200, { environment: await m5.unity.prepare(id) });
      return;
    }
    if (id !== undefined && area === "editor" && action === "status" && request.method === "GET") {
      sendJson(response, 200, await m5.unity.status(id));
      return;
    }
    if (id !== undefined && area === "editor" && action === "start" && request.method === "POST") {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      request.once("aborted", abort);
      try {
        sendJson(response, 200, await m5.unity.startEditor(id, controller.signal));
      } finally {
        request.off("aborted", abort);
      }
      return;
    }
    if (id !== undefined && area === "editor" && action === "stop" && request.method === "POST") {
      sendJson(response, 200, await m5.unity.stopEditor(id));
      return;
    }
    if (id !== undefined && area === "editor" && action === "wait-idle" && request.method === "POST") {
      const body = await readJsonBody(request);
      const input = typeof body === "object" && body !== null && !Array.isArray(body)
        ? body as { readonly timeoutMs?: number }
        : {};
      sendJson(response, 200, {
        editorStatus: await m5.unity.waitForIdle(id, input),
      });
      return;
    }
    if (id !== undefined && area === "bridge" && action === "remove" && request.method === "POST") {
      sendJson(response, 200, await m5.unity.removeBridge(id));
      return;
    }
  }

  const taskRoute = /^\/tasks\/(TASK-\d{4,})(?:\/([a-z-]+))?$/.exec(path);
  if (taskRoute !== null) {
    const id = taskRoute[1];
    const action = taskRoute[2];
    if (id !== undefined && action === undefined && request.method === "GET") {
      sendJson(response, 200, { task: await service.get(id) });
      return;
    }
    if (
      id !== undefined &&
      action !== undefined &&
      (await handleTaskAction(
        request,
        response,
        service,
        id,
        action,
        analysisService,
        m5,
      ))
    ) {
      return;
    }
  }

  sendJson(response, 404, {
    error: { code: "NOT_FOUND", message: "Route not found." },
  });
};

const handleError = (response: ServerResponse, error: unknown): void => {
  if (error instanceof TaskDomainError) {
    sendJson(response, error.code === "INVALID_TRANSITION" ? 409 : 400, {
      error: { code: error.code, message: error.message },
    });
    return;
  }

  if (error instanceof ServerError) {
    sendJson(response, error.statusCode, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }

  if (error instanceof UnityIntegrationError) {
    const statusCode =
      error.code === "UNITY_BRIDGE_NOT_INSTALLED" ||
      error.code === "UNITY_BRIDGE_NOT_CONNECTED"
        ? 404
        : error.code === "UNITY_BRIDGE_CONFLICT" ||
            error.code === "UNITY_BRIDGE_OWNERSHIP_MISMATCH" ||
            error.code === "EDITOR_NOT_OWNED"
          ? 409
          : error.code === "UNITY_BRIDGE_TIMEOUT"
            ? 504
            : error.code === "UNITY_EDITOR_START_FAILED" ||
                error.code === "UNITY_EDITOR_EXITED" ||
                error.code === "UNITY_COMMAND_FAILED"
              ? 502
              : 422;
    sendJson(response, statusCode, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }

  console.error(error);
  sendJson(response, 500, {
    error: { code: "INTERNAL_ERROR", message: "Unexpected server error." },
  });
};

export const createUnityAiServer = (
  service: TaskService,
  gitService: GitSafetyService,
  aiService?: AIService,
  analysisService?: AnalysisService,
  m5?: M5ServerServices,
): Server =>
  createServer((request, response) => {
    void handleRequest(
      request,
      response,
      service,
      gitService,
      aiService,
      analysisService,
      m5,
    ).catch(
      (error: unknown) => {
        handleError(response, error);
      },
    );
  });
