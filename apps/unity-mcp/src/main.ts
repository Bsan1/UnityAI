#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { UnityBridgeClient } from "@unityai/unity";

import { createUnityMcpServer } from "./server.js";

const projectPathArgument = (): string => {
  const index = process.argv.indexOf("--projectPath");
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new Error("Usage: unityai-unity-mcp --projectPath <managed-unity-worktree>");
  }
  return value;
};

const server = createUnityMcpServer(new UnityBridgeClient(projectPathArgument()));
const transport = new StdioServerTransport();
await server.connect(transport);
