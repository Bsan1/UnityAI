import { createServer } from "node:http";

import { applicationInfo } from "@unityai/core";
import type { HealthResponse } from "@unityai/shared";

const host = "127.0.0.1";
const defaultPort = 3000;

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

const healthResponse: HealthResponse = {
  status: "ok",
  app: applicationInfo.name,
  version: applicationInfo.version,
  milestone: applicationInfo.milestone,
};

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${host}`);

  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    response.writeHead(200);
    response.end(JSON.stringify(healthResponse));
    return;
  }

  response.writeHead(404);
  response.end(JSON.stringify({ error: "Not found" }));
});
const port = resolvePort(process.env.UNITYAI_PORT);

server.listen(port, host, () => {
  console.log(`${applicationInfo.name} server listening at http://${host}:${port}`);
});
