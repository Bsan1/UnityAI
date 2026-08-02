import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { UnityBridgeClient, UnityGameViewScreenshot } from "@unityai/unity";
import { z } from "zod";

import { createUnityMcpToolHandlers } from "./tools.js";

const result = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(typeof value === "object" && value !== null && !Array.isArray(value)
    ? { structuredContent: value as Record<string, unknown> }
    : {}),
});

const imageResult = (value: UnityGameViewScreenshot): CallToolResult => {
  const { data, ...metadata } = value;
  return {
    content: [
      { type: "text", text: JSON.stringify(metadata) },
      { type: "image", data, mimeType: "image/png" },
    ],
    structuredContent: metadata,
  };
};

export const createUnityMcpServer = (client: UnityBridgeClient): McpServer => {
  const handlers = createUnityMcpToolHandlers(client);
  const server = new McpServer(
    { name: "unityai-unity", version: "0.2.0" },
    {
      instructions:
        "Use only explicit Unity Editor, QA-owned virtual input, screenshot, and bounded probe tools. Input travels through real Input System bindings. This server cannot execute C#, invoke gameplay methods, run shell commands, expose filesystems, perform arbitrary reflection, or control the desktop.",
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
  server.registerTool(
    "unity_reload_play_scene",
    {
      description: "Reload only the active loaded scene during Play Mode to reset a gameplay scenario.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async () => result(await handlers.unity_reload_play_scene()),
  );
  server.registerTool(
    "unity_input_capabilities",
    {
      description: "Inspect available input backends and UnityAI-owned virtual devices.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => result(await handlers.unity_input_capabilities()),
  );
  server.registerTool(
    "unity_input_bindings",
    {
      description: "Inspect a bounded set of loaded Input System action maps, actions, and real bindings.",
      inputSchema: z.object({
        action: z.string().min(1).max(256).optional(),
        actionMap: z.string().min(1).max(256).optional(),
        maxBindings: z.number().int().min(1).max(1000).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => result(await handlers.unity_input_bindings({
      ...(input.action === undefined ? {} : { action: input.action }),
      ...(input.actionMap === undefined ? {} : { actionMap: input.actionMap }),
      ...(input.maxBindings === undefined ? {} : { maxBindings: input.maxBindings }),
    })),
  );
  server.registerTool(
    "unity_key_press",
    {
      description: "Press and release one key on a UnityAI-owned virtual keyboard through the Input System.",
      inputSchema: z.object({ key: z.string().min(1).max(128), frames: z.number().int().min(1).max(3600).optional() }),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => result(await handlers.unity_key_press({
      key: input.key,
      ...(input.frames === undefined ? {} : { frames: input.frames }),
    })),
  );
  server.registerTool(
    "unity_key_down",
    {
      description: "Hold one key on a UnityAI-owned virtual keyboard until explicitly released.",
      inputSchema: z.object({ key: z.string().min(1).max(128) }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input) => result(await handlers.unity_key_down(input)),
  );
  server.registerTool(
    "unity_key_up",
    {
      description: "Release one key on a UnityAI-owned virtual keyboard.",
      inputSchema: z.object({ key: z.string().min(1).max(128) }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input) => result(await handlers.unity_key_up(input)),
  );
  server.registerTool(
    "unity_mouse_move",
    {
      description: "Queue bounded virtual mouse delta or position input.",
      inputSchema: z.object({
        x: z.number().finite().min(-100000).max(100000),
        y: z.number().finite().min(-100000).max(100000),
        mode: z.enum(["DELTA", "POSITION"]).optional(),
      }),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => result(await handlers.unity_mouse_move({
      x: input.x,
      y: input.y,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    })),
  );
  const mouseButtonSchema = z.enum(["leftButton", "rightButton", "middleButton"]);
  server.registerTool(
    "unity_mouse_click",
    {
      description: "Press and release one button on a UnityAI-owned virtual mouse.",
      inputSchema: z.object({ button: mouseButtonSchema, frames: z.number().int().min(1).max(3600).optional() }),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => result(await handlers.unity_mouse_click({
      button: input.button,
      ...(input.frames === undefined ? {} : { frames: input.frames }),
    })),
  );
  server.registerTool(
    "unity_mouse_button_down",
    {
      description: "Hold one button on a UnityAI-owned virtual mouse.",
      inputSchema: z.object({ button: mouseButtonSchema }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input) => result(await handlers.unity_mouse_button_down(input)),
  );
  server.registerTool(
    "unity_mouse_button_up",
    {
      description: "Release one button on a UnityAI-owned virtual mouse.",
      inputSchema: z.object({ button: mouseButtonSchema }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input) => result(await handlers.unity_mouse_button_up(input)),
  );
  server.registerTool(
    "unity_mouse_scroll",
    {
      description: "Queue bounded scroll input on a UnityAI-owned virtual mouse.",
      inputSchema: z.object({ x: z.number().finite().min(-100000).max(100000).optional(), y: z.number().finite().min(-100000).max(100000) }),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => result(await handlers.unity_mouse_scroll({
      ...(input.x === undefined ? {} : { x: input.x }),
      y: input.y,
    })),
  );
  server.registerTool(
    "unity_gamepad_button",
    {
      description: "Press, hold, or release a named button on a UnityAI-owned virtual gamepad.",
      inputSchema: z.object({
        button: z.string().min(1).max(128),
        pressed: z.boolean().optional(),
        frames: z.number().int().min(1).max(3600).optional(),
      }),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => result(await handlers.unity_gamepad_button({
      button: input.button,
      ...(input.pressed === undefined ? {} : { pressed: input.pressed }),
      ...(input.frames === undefined ? {} : { frames: input.frames }),
    })),
  );
  server.registerTool(
    "unity_gamepad_stick",
    {
      description: "Set a bounded two-axis value on a UnityAI-owned virtual gamepad stick.",
      inputSchema: z.object({
        stick: z.enum(["leftStick", "rightStick"]),
        x: z.number().finite().min(-1).max(1),
        y: z.number().finite().min(-1).max(1),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input) => result(await handlers.unity_gamepad_stick(input)),
  );
  server.registerTool(
    "unity_gamepad_trigger",
    {
      description: "Set a bounded value on a UnityAI-owned virtual gamepad trigger.",
      inputSchema: z.object({ trigger: z.enum(["leftTrigger", "rightTrigger"]), value: z.number().finite().min(0).max(1) }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input) => result(await handlers.unity_gamepad_trigger(input)),
  );
  server.registerTool(
    "unity_input_action",
    {
      description: "Resolve a common semantic Input System action to its real binding, then drive virtual controls without invoking callbacks directly.",
      inputSchema: z.object({
        action: z.string().min(1).max(256),
        actionMap: z.string().min(1).max(256).optional(),
        value: z.array(z.number().finite().min(-1).max(1)).min(1).max(2).optional(),
        holdFrames: z.number().int().min(1).max(3600).optional(),
      }),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => result(await handlers.unity_input_action({
      action: input.action,
      ...(input.actionMap === undefined ? {} : { actionMap: input.actionMap }),
      ...(input.value === undefined ? {} : { value: input.value }),
      ...(input.holdFrames === undefined ? {} : { holdFrames: input.holdFrames }),
    })),
  );
  server.registerTool(
    "unity_release_all_inputs",
    {
      description: "Release all held QA controls and remove only UnityAI-owned virtual devices.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async () => result(await handlers.unity_release_all_inputs()),
  );
  server.registerTool(
    "unity_wait_frames",
    {
      description: "Wait for a bounded number of unpaused Unity Play Mode frames.",
      inputSchema: z.object({ frames: z.number().int().min(1).max(3600) }),
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async (input) => result(await handlers.unity_wait_frames(input)),
  );
  server.registerTool(
    "unity_game_view_screenshot",
    {
      description: "Capture one bounded on-demand Game View PNG as image evidence under Library/UnityAI.",
      inputSchema: z.object({
        maxWidth: z.number().int().min(64).max(1280).optional(),
        maxHeight: z.number().int().min(64).max(720).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async (input) => imageResult(await handlers.unity_game_view_screenshot({
      ...(input.maxWidth === undefined ? {} : { maxWidth: input.maxWidth }),
      ...(input.maxHeight === undefined ? {} : { maxHeight: input.maxHeight }),
    })),
  );
  server.registerTool(
    "unity_runtime_probe",
    {
      description: "Read one allowlisted primitive serialized runtime value or Transform value without mutation or method invocation.",
      inputSchema: z.object({
        instanceId: z.number().int().optional(),
        hierarchyPath: z.string().min(1).max(2048).optional(),
        componentType: z.string().min(1).max(512),
        propertyPath: z.string().min(1).max(512),
      }).refine(
        (value) => value.instanceId !== undefined || value.hierarchyPath !== undefined,
        { message: "instanceId or hierarchyPath is required" },
      ),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => result(await handlers.unity_runtime_probe({
      ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
      ...(input.hierarchyPath === undefined ? {} : { hierarchyPath: input.hierarchyPath }),
      componentType: input.componentType,
      propertyPath: input.propertyPath,
    })),
  );
  return server;
};
