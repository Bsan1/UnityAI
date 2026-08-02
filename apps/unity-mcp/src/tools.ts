import type { UnityBridgeClient } from "@unityai/unity";

export const UNITY_MCP_TOOL_NAMES = [
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
] as const;

export type UnityMcpToolName = (typeof UNITY_MCP_TOOL_NAMES)[number];

export interface UnityMcpToolHandlers {
  readonly unity_ping: () => Promise<unknown>;
  readonly unity_editor_status: () => Promise<unknown>;
  readonly unity_request_compilation: () => Promise<unknown>;
  readonly unity_enter_play_mode: () => Promise<unknown>;
  readonly unity_exit_play_mode: () => Promise<unknown>;
  readonly unity_set_play_mode_paused: (input: { readonly paused: boolean }) => Promise<unknown>;
  readonly unity_console: (input: { readonly limit?: number; readonly offset?: number }) => Promise<unknown>;
  readonly unity_scene_summary: () => Promise<unknown>;
  readonly unity_scene_hierarchy: (input: {
    readonly offset?: number;
    readonly maxDepth?: number;
    readonly maxObjects?: number;
  }) => Promise<unknown>;
  readonly unity_object_snapshot: (input: {
    readonly instanceId?: number;
    readonly hierarchyPath?: string;
    readonly maxProperties?: number;
  }) => Promise<unknown>;
}

export const createUnityMcpToolHandlers = (
  client: UnityBridgeClient,
): UnityMcpToolHandlers => ({
  unity_ping: () => client.ping(),
  unity_editor_status: () => client.editorStatus(),
  unity_request_compilation: () => client.requestCompilation(),
  unity_enter_play_mode: () => client.enterPlayMode(),
  unity_exit_play_mode: () => client.exitPlayMode(),
  unity_set_play_mode_paused: (input) => client.setPlayModePaused(input.paused),
  unity_console: (input) => client.console(input),
  unity_scene_summary: () => client.sceneSummary(),
  unity_scene_hierarchy: (input) => client.sceneHierarchy(input),
  unity_object_snapshot: (input) => client.objectSnapshot(input),
});
