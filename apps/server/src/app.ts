import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { TaskDomainError, applicationInfo } from "@unityai/core";
import type { HealthResponse } from "@unityai/shared";

import { ServerError } from "./errors.js";
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

const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  service: TaskService,
): Promise<void> => {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = requestUrl.pathname;

  if (request.method === "GET" && path === "/health") {
    sendJson(response, 200, healthResponse);
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
      error: { code: error.code, message: error.message },
    });
    return;
  }

  console.error(error);
  sendJson(response, 500, {
    error: { code: "INTERNAL_ERROR", message: "Unexpected server error." },
  });
};

export const createUnityAiServer = (service: TaskService): Server =>
  createServer((request, response) => {
    void handleRequest(request, response, service).catch((error: unknown) => {
      handleError(response, error);
    });
  });
