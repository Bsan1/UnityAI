import type { UnityBridgeClient, UnityGameViewScreenshot } from "@unityai/unity";

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
] as const;

export type UnityMcpToolName = (typeof UNITY_MCP_TOOL_NAMES)[number];

type KeyInput = { readonly key: string; readonly frames?: number };
type MouseButtonInput = { readonly button: "leftButton" | "rightButton" | "middleButton" };

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
  readonly unity_reload_play_scene: () => Promise<unknown>;
  readonly unity_input_capabilities: () => Promise<unknown>;
  readonly unity_input_bindings: (input: {
    readonly action?: string;
    readonly actionMap?: string;
    readonly maxBindings?: number;
  }) => Promise<unknown>;
  readonly unity_key_press: (input: KeyInput) => Promise<unknown>;
  readonly unity_key_down: (input: { readonly key: string }) => Promise<unknown>;
  readonly unity_key_up: (input: { readonly key: string }) => Promise<unknown>;
  readonly unity_mouse_move: (input: {
    readonly x: number;
    readonly y: number;
    readonly mode?: "DELTA" | "POSITION";
  }) => Promise<unknown>;
  readonly unity_mouse_click: (input: MouseButtonInput & { readonly frames?: number }) => Promise<unknown>;
  readonly unity_mouse_button_down: (input: MouseButtonInput) => Promise<unknown>;
  readonly unity_mouse_button_up: (input: MouseButtonInput) => Promise<unknown>;
  readonly unity_mouse_scroll: (input: { readonly x?: number; readonly y: number }) => Promise<unknown>;
  readonly unity_gamepad_button: (input: {
    readonly button: string;
    readonly pressed?: boolean;
    readonly frames?: number;
  }) => Promise<unknown>;
  readonly unity_gamepad_stick: (input: {
    readonly stick: "leftStick" | "rightStick";
    readonly x: number;
    readonly y: number;
  }) => Promise<unknown>;
  readonly unity_gamepad_trigger: (input: {
    readonly trigger: "leftTrigger" | "rightTrigger";
    readonly value: number;
  }) => Promise<unknown>;
  readonly unity_input_action: (input: {
    readonly action: string;
    readonly actionMap?: string;
    readonly value?: readonly number[];
    readonly holdFrames?: number;
  }) => Promise<unknown>;
  readonly unity_release_all_inputs: () => Promise<unknown>;
  readonly unity_wait_frames: (input: { readonly frames: number }) => Promise<unknown>;
  readonly unity_game_view_screenshot: (input: {
    readonly maxWidth?: number;
    readonly maxHeight?: number;
  }) => Promise<UnityGameViewScreenshot>;
  readonly unity_runtime_probe: (input: {
    readonly instanceId?: number;
    readonly hierarchyPath?: string;
    readonly componentType: string;
    readonly propertyPath: string;
  }) => Promise<unknown>;
}

export const createUnityMcpToolHandlers = (
  client: UnityBridgeClient,
): UnityMcpToolHandlers => {
  const transitionPlayMode = async (expected: boolean): Promise<unknown> => {
    const requested = expected
      ? await client.enterPlayMode()
      : await client.exitPlayMode();
    const candidate = client as UnityBridgeClient & {
      readonly waitForPlayModeState?: (
        expectedState: boolean,
        input?: { readonly timeoutMs?: number; readonly stableForMs?: number },
      ) => Promise<unknown>;
    };
    if (typeof candidate.waitForPlayModeState === "function") {
      const status = await candidate.waitForPlayModeState(expected);
      return { ...requested, status };
    }
    return requested;
  };
  return {
  unity_ping: () => client.ping(),
  unity_editor_status: () => client.editorStatus(),
  unity_request_compilation: () => client.requestCompilation(),
  unity_enter_play_mode: () => transitionPlayMode(true),
  unity_exit_play_mode: () => transitionPlayMode(false),
  unity_set_play_mode_paused: (input) => client.setPlayModePaused(input.paused),
  unity_console: (input) => client.console(input),
  unity_scene_summary: () => client.sceneSummary(),
  unity_scene_hierarchy: (input) => client.sceneHierarchy(input),
  unity_object_snapshot: (input) => client.objectSnapshot(input),
  unity_reload_play_scene: () => client.reloadScene(),
  unity_input_capabilities: () => client.inputCapabilities(),
  unity_input_bindings: (input) => client.inputBindings(input),
  unity_key_press: (input) => client.pressInputControl({
    device: "KEYBOARD",
    control: input.key,
    ...(input.frames === undefined ? {} : { frames: input.frames }),
  }),
  unity_key_down: (input) => client.setInputControl({ device: "KEYBOARD", control: input.key, value: [1] }),
  unity_key_up: (input) => client.setInputControl({ device: "KEYBOARD", control: input.key, value: [0] }),
  unity_mouse_move: (input) => client.setInputControl({
    device: "MOUSE",
    control: input.mode === "POSITION" ? "position" : "delta",
    value: [input.x, input.y],
  }),
  unity_mouse_click: (input) => client.pressInputControl({
    device: "MOUSE",
    control: input.button,
    ...(input.frames === undefined ? {} : { frames: input.frames }),
  }),
  unity_mouse_button_down: (input) => client.setInputControl({ device: "MOUSE", control: input.button, value: [1] }),
  unity_mouse_button_up: (input) => client.setInputControl({ device: "MOUSE", control: input.button, value: [0] }),
  unity_mouse_scroll: (input) => client.setInputControl({ device: "MOUSE", control: "scroll", value: [input.x ?? 0, input.y] }),
  unity_gamepad_button: (input) => input.pressed === undefined
    ? client.pressInputControl({
        device: "GAMEPAD",
        control: input.button,
        ...(input.frames === undefined ? {} : { frames: input.frames }),
      })
    : client.setInputControl({ device: "GAMEPAD", control: input.button, value: [input.pressed ? 1 : 0] }),
  unity_gamepad_stick: (input) => client.setInputControl({ device: "GAMEPAD", control: input.stick, value: [input.x, input.y] }),
  unity_gamepad_trigger: (input) => client.setInputControl({ device: "GAMEPAD", control: input.trigger, value: [input.value] }),
  unity_input_action: (input) => client.inputAction(input),
  unity_release_all_inputs: () => client.releaseAllInputs(),
  unity_wait_frames: (input) => client.waitFrames(input.frames),
  unity_game_view_screenshot: (input) => client.gameViewScreenshot(input),
  unity_runtime_probe: (input) => client.runtimeProbe(input),
  };
};
