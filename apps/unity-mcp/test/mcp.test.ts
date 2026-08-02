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
    "unity_reload_play_scene",
    "unity_input_capabilities",
    "unity_input_bindings",
    "unity_key_press",
    "unity_key_down",
    "unity_key_up",
    "unity_mouse_move",
    "unity_mouse_click",
    "unity_mouse_button_down",
    "unity_mouse_button_up",
    "unity_mouse_scroll",
    "unity_gamepad_button",
    "unity_gamepad_stick",
    "unity_gamepad_trigger",
    "unity_input_action",
    "unity_release_all_inputs",
    "unity_wait_frames",
    "unity_game_view_screenshot",
    "unity_runtime_probe",
  ]);
  assert.equal(UNITY_MCP_TOOL_NAMES.some((name) => /csharp|shell|file|arbitrary|rpc|method|desktop/u.test(name)), false);
});

test("Unity MCP tools map directly to the shared bridge client without independent transport logic", async () => {
  const calls: Array<{ readonly method: string; readonly input?: unknown }> = [];
  const fake = {
    ping: async () => { calls.push({ method: "ping" }); return { command: "ping" }; },
    editorStatus: async () => { calls.push({ method: "status" }); return { command: "status" }; },
    requestCompilation: async () => { calls.push({ method: "compile" }); return { requested: true }; },
    enterPlayMode: async () => { calls.push({ method: "enter" }); return { requested: true }; },
    exitPlayMode: async () => { calls.push({ method: "exit" }); return { requested: true }; },
    waitForPlayModeState: async (expected: boolean) => {
      calls.push({ method: "wait-play-state", input: expected });
      return { isPlaying: expected };
    },
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
    "wait-play-state",
    "exit",
    "wait-play-state",
    "pause",
    "console",
    "scene-summary",
    "hierarchy",
    "object",
  ]);
  assert.deepEqual(calls[4]?.input, true);
  assert.deepEqual(calls[6]?.input, false);
  assert.deepEqual(calls[7]?.input, true);
  assert.deepEqual(calls[8]?.input, { limit: 10 });
  assert.deepEqual(calls[10]?.input, { maxDepth: 3, maxObjects: 20 });
  assert.deepEqual(calls[11]?.input, { instanceId: 42, maxProperties: 50 });
  assert.ok(createUnityMcpServer(fake));
});

test("M8 MCP gameplay tools map to virtual input, frame, screenshot, and bounded probe client methods", async () => {
  const calls: Array<{ readonly method: string; readonly input?: unknown }> = [];
  const fake = {
    reloadScene: async () => { calls.push({ method: "reload" }); return { requested: true }; },
    inputCapabilities: async () => { calls.push({ method: "capabilities" }); return { inputSystemAvailable: true }; },
    inputBindings: async (input: unknown) => { calls.push({ method: "bindings", input }); return { bindings: [] }; },
    pressInputControl: async (input: unknown) => { calls.push({ method: "press", input }); return { frames: 1 }; },
    setInputControl: async (input: unknown) => { calls.push({ method: "control", input }); return { frameCount: 1 }; },
    inputAction: async (input: unknown) => { calls.push({ method: "action", input }); return { controls: ["<Keyboard>/space"] }; },
    releaseAllInputs: async () => { calls.push({ method: "release" }); return { removedDevices: 3 }; },
    waitFrames: async (frames: number) => { calls.push({ method: "wait", input: frames }); return { frames }; },
    gameViewScreenshot: async (input: unknown) => {
      calls.push({ method: "screenshot", input });
      return {
        evidenceId: "SHOT-1",
        relativePath: "Library/UnityAI/screenshots/SHOT-1.png",
        mimeType: "image/png",
        width: 320,
        height: 180,
        byteCount: 3,
        capturedAt: new Date().toISOString(),
        data: "YWJj",
      };
    },
    runtimeProbe: async (input: unknown) => { calls.push({ method: "probe", input }); return { value: "true" }; },
  } as unknown as UnityBridgeClient;
  const handlers = createUnityMcpToolHandlers(fake);
  await handlers.unity_reload_play_scene();
  await handlers.unity_input_capabilities();
  await handlers.unity_input_bindings({ action: "Dash" });
  await handlers.unity_key_press({ key: "space", frames: 2 });
  await handlers.unity_key_down({ key: "w" });
  await handlers.unity_key_up({ key: "w" });
  await handlers.unity_mouse_move({ x: 2, y: -1 });
  await handlers.unity_mouse_click({ button: "leftButton" });
  await handlers.unity_mouse_button_down({ button: "rightButton" });
  await handlers.unity_mouse_button_up({ button: "rightButton" });
  await handlers.unity_mouse_scroll({ y: 120 });
  await handlers.unity_gamepad_button({ button: "buttonSouth" });
  await handlers.unity_gamepad_stick({ stick: "leftStick", x: 1, y: 0 });
  await handlers.unity_gamepad_trigger({ trigger: "rightTrigger", value: 0.5 });
  await handlers.unity_input_action({ action: "Dash", holdFrames: 1 });
  await handlers.unity_release_all_inputs();
  await handlers.unity_wait_frames({ frames: 3 });
  const screenshot = await handlers.unity_game_view_screenshot({ maxWidth: 640, maxHeight: 360 });
  await handlers.unity_runtime_probe({ hierarchyPath: "Scene:/Player", componentType: "PlayerMover", propertyPath: "isDashing" });
  assert.equal(screenshot.mimeType, "image/png");
  assert.equal(calls.filter((entry) => entry.method === "press").length, 3);
  assert.equal(calls.filter((entry) => entry.method === "control").length, 8);
  assert.deepEqual(calls.find((entry) => entry.method === "action")?.input, { action: "Dash", holdFrames: 1 });
  assert.equal(calls.at(-1)?.method, "probe");
});
