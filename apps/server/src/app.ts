import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { TaskDomainError, applicationInfo } from "@unityai/core";
import type { HealthResponse } from "@unityai/shared";

import type { AIService } from "./aiService.js";
import { ServerError } from "./errors.js";
import type { GitSafetyService } from "./gitSafetyService.js";
import type { TaskService } from "./taskService.js";

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
): Promise<boolean> => {
  if (request.method === "PATCH" && action === "draft") {
    const task = await service.editDraft(id, await readJsonBody(request));
    sendJson(response, 200, { task });
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
      const task = await service.analyze(id);
      sendJson(response, 200, { task });
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
      const task = await service.approve(id);
      sendJson(response, 200, { task });
      return true;
    }
    case "pause": {
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
      const task = await service.recheck(id);
      sendJson(response, 200, { task });
      return true;
    }
    case "cancel": {
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

  if (path === "/tasks") {
    if (request.method === "GET") {
      sendJson(response, 200, { tasks: await service.list() });
      return;
    }
    if (request.method === "POST") {
      const task = await service.create(await readJsonBody(request));
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
      (await handleTaskAction(request, response, service, id, action))
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

  console.error(error);
  sendJson(response, 500, {
    error: { code: "INTERNAL_ERROR", message: "Unexpected server error." },
  });
};

export const createUnityAiServer = (
  service: TaskService,
  gitService: GitSafetyService,
  aiService?: AIService,
): Server =>
  createServer((request, response) => {
    void handleRequest(request, response, service, gitService, aiService).catch(
      (error: unknown) => {
        handleError(response, error);
      },
    );
  });
