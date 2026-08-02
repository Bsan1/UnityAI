import assert from "node:assert/strict";
import { test } from "node:test";

import type { UnityBridgeClient } from "@unityai/unity";

import {
  UNITY_MCP_TOOL_NAMES,
  createUnityMcpServer,
  createUnityMcpToolHandlers,
} from "../src/index.js";

test("Unity MCP exposes only the explicit bridge capability set", () => {
  assert.deepEqual(UNITY_MCP_TOOL_NAMES, [
    "unity_ping",
    "unity_editor_status",
    "unity_request_compilation",
    "unity_enter_play_mode",
    "unity_exit_play_mode",
    "unity_set_play_mode_paused",
    "unity_console",
    "unity_scene_summary",
    "unity_scene_hierarchy",
    "unity_object_snapshot",
  ]);
  assert.equal(UNITY_MCP_TOOL_NAMES.some((name) => /csharp|shell|file|arbitrary|rpc/u.test(name)), false);
});

test("Unity MCP tools map directly to the shared bridge client without independent transport logic", async () => {
  const calls: Array<{ readonly method: string; readonly input?: unknown }> = [];
  const fake = {
    ping: async () => { calls.push({ method: "ping" }); return { command: "ping" }; },
    editorStatus: async () => { calls.push({ method: "status" }); return { command: "status" }; },
    requestCompilation: async () => { calls.push({ method: "compile" }); return { requested: true }; },
    enterPlayMode: async () => { calls.push({ method: "enter" }); return { requested: true }; },
    exitPlayMode: async () => { calls.push({ method: "exit" }); return { requested: true }; },
    setPlayModePaused: async (paused: boolean) => { calls.push({ method: "pause", input: paused }); return { paused }; },
    console: async (input: unknown) => { calls.push({ method: "console", input }); return { entries: [] }; },
    sceneSummary: async () => { calls.push({ method: "scene-summary" }); return { scenes: [] }; },
    sceneHierarchy: async (input: unknown) => { calls.push({ method: "hierarchy", input }); return { objects: [] }; },
    objectSnapshot: async (input: unknown) => { calls.push({ method: "object", input }); return { name: "Camera" }; },
  } as unknown as UnityBridgeClient;
  const handlers = createUnityMcpToolHandlers(fake);
  await handlers.unity_ping();
  await handlers.unity_editor_status();
  await handlers.unity_request_compilation();
  await handlers.unity_enter_play_mode();
  await handlers.unity_exit_play_mode();
  await handlers.unity_set_play_mode_paused({ paused: true });
  await handlers.unity_console({ limit: 10 });
  await handlers.unity_scene_summary();
  await handlers.unity_scene_hierarchy({ maxDepth: 3, maxObjects: 20 });
  await handlers.unity_object_snapshot({ instanceId: 42, maxProperties: 50 });
  assert.deepEqual(calls.map((call) => call.method), [
    "ping",
    "status",
    "compile",
    "enter",
    "exit",
    "pause",
    "console",
    "scene-summary",
    "hierarchy",
    "object",
  ]);
  assert.deepEqual(calls[5]?.input, true);
  assert.deepEqual(calls[6]?.input, { limit: 10 });
  assert.deepEqual(calls[8]?.input, { maxDepth: 3, maxObjects: 20 });
  assert.deepEqual(calls[9]?.input, { instanceId: 42, maxProperties: 50 });
  assert.ok(createUnityMcpServer(fake));
});
