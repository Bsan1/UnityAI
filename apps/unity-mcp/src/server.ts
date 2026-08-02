import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { UnityBridgeClient } from "@unityai/unity";
import { z } from "zod";

import { createUnityMcpToolHandlers } from "./tools.js";

const result = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(typeof value === "object" && value !== null && !Array.isArray(value)
    ? { structuredContent: value as Record<string, unknown> }
    : {}),
});

export const createUnityMcpServer = (client: UnityBridgeClient): McpServer => {
  const handlers = createUnityMcpToolHandlers(client);
  const server = new McpServer(
    { name: "unityai-unity", version: "0.1.0" },
    {
      instructions:
        "Use only the explicit Unity Editor query/control tools. This server cannot execute C#, shell commands, arbitrary RPC, or filesystem operations.",
    },
  );

  server.registerTool(
    "unity_ping",
    {
      description: "Verify the authenticated Unity Editor bridge session.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => result(await handlers.unity_ping()),
  );
  server.registerTool(
    "unity_editor_status",
    {
      description: "Read bounded Unity Editor compile, Play Mode, scene, and platform state.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => result(await handlers.unity_editor_status()),
  );
  server.registerTool(
    "unity_request_compilation",
    {
      description: "Ask Unity to perform a supported script compilation pass.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async () => result(await handlers.unity_request_compilation()),
  );
  server.registerTool(
    "unity_enter_play_mode",
    {
      description: "Ask the connected Unity Editor to enter Play Mode.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async () => result(await handlers.unity_enter_play_mode()),
  );
  server.registerTool(
    "unity_exit_play_mode",
    {
      description: "Ask the connected Unity Editor to exit Play Mode.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async () => result(await handlers.unity_exit_play_mode()),
  );
  server.registerTool(
    "unity_set_play_mode_paused",
    {
      description: "Pause or unpause the connected Unity Editor Play Mode session.",
      inputSchema: z.object({ paused: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ paused }) => result(
      await handlers.unity_set_play_mode_paused({ paused }),
    ),
  );
  server.registerTool(
    "unity_console",
    {
      description: "Read a bounded partial Unity log snapshot captured by the bridge.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => result(await handlers.unity_console({
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.offset === undefined ? {} : { offset: input.offset }),
    })),
  );
  server.registerTool(
    "unity_scene_summary",
    {
      description: "Read a concise summary of loaded Unity scenes.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => result(await handlers.unity_scene_summary()),
  );
  server.registerTool(
    "unity_scene_hierarchy",
    {
      description: "Read a bounded, paged Unity scene hierarchy snapshot.",
      inputSchema: z.object({
        offset: z.number().int().min(0).optional(),
        maxDepth: z.number().int().min(1).max(12).optional(),
        maxObjects: z.number().int().min(1).max(1000).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => result(await handlers.unity_scene_hierarchy({
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
      ...(input.maxObjects === undefined ? {} : { maxObjects: input.maxObjects }),
    })),
  );
  server.registerTool(
    "unity_object_snapshot",
    {
      description: "Read a bounded primitive-property snapshot for one Unity scene object.",
      inputSchema: z.object({
        instanceId: z.number().int().optional(),
        hierarchyPath: z.string().min(1).max(2048).optional(),
        maxProperties: z.number().int().min(1).max(200).optional(),
      }).refine(
        (value) => value.instanceId !== undefined || value.hierarchyPath !== undefined,
        { message: "instanceId or hierarchyPath is required" },
      ),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => result(await handlers.unity_object_snapshot({
      ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
      ...(input.hierarchyPath === undefined ? {} : { hierarchyPath: input.hierarchyPath }),
      ...(input.maxProperties === undefined ? {} : { maxProperties: input.maxProperties }),
    })),
  );
  return server;
};
