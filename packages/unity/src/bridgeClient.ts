import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";

import { UnityIntegrationError } from "./errors.js";
import {
  UNITY_BRIDGE_PROTOCOL_VERSION,
} from "./types.js";
import type {
  UnityBridgeMethod,
  UnityBridgeParams,
  UnityBridgePing,
  UnityBridgeResponse,
  UnityBridgeSessionDescriptor,
  UnityConsoleResult,
  UnityEditorStatus,
  UnityGameViewScreenshot,
  UnityGameViewScreenshotMetadata,
  UnityInputActionResolution,
  UnityInputBindings,
  UnityInputCapabilities,
  UnityInputCommandResult,
  UnityObjectSnapshot,
  UnityReleaseInputsResult,
  UnityRuntimeProbeResult,
  UnitySceneHierarchy,
  UnitySceneSummary,
} from "./types.js";
import { parseUnityBridgeSessionDescriptor } from "./validation.js";

export interface UnityBridgeClientOptions {
  readonly descriptorPath?: string;
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
}

const missingFile = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

const errorForBridgeResponse = (
  code: string,
  message: string,
): UnityIntegrationError => {
  if (code === "AUTH_FAILED") {
    return new UnityIntegrationError("UNITY_BRIDGE_AUTH_FAILED", message);
  }
  if (code === "PROTOCOL_MISMATCH") {
    return new UnityIntegrationError("UNITY_BRIDGE_PROTOCOL_MISMATCH", message);
  }
  if (code === "INPUT_NOT_ACTIVE") {
    return new UnityIntegrationError("INPUT_NOT_ACTIVE", message);
  }
  if (code === "INPUT_SYSTEM_UNAVAILABLE") {
    return new UnityIntegrationError("INPUT_SYSTEM_UNAVAILABLE", message);
  }
  if (code === "INPUT_BINDING_UNSUPPORTED") {
    return new UnityIntegrationError("INPUT_BINDING_UNSUPPORTED", message);
  }
  if (code === "SCREENSHOT_CAPTURE_FAILED") {
    return new UnityIntegrationError("SCREENSHOT_CAPTURE_FAILED", message);
  }
  if (code === "RUNTIME_PROBE_INVALID") {
    return new UnityIntegrationError("RUNTIME_PROBE_INVALID", message);
  }
  return new UnityIntegrationError("UNITY_COMMAND_FAILED", message, {
    bridgeCode: code,
  });
};

export class UnityBridgeClient {
  readonly expectedProjectRoot: string;
  readonly descriptorPath: string;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;

  constructor(expectedProjectRoot: string, options: UnityBridgeClientOptions = {}) {
    this.expectedProjectRoot = resolve(expectedProjectRoot);
    this.descriptorPath = options.descriptorPath ?? join(
      this.expectedProjectRoot,
      "Library",
      "UnityAI",
      "bridge-session.json",
    );
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maximumResponseBytes = options.maximumResponseBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new UnityIntegrationError(
        "UNITY_PROJECT_METADATA_INVALID",
        "Bridge timeout must be a positive integer.",
      );
    }
    if (
      !Number.isSafeInteger(this.maximumResponseBytes) ||
      this.maximumResponseBytes < 1_024
    ) {
      throw new UnityIntegrationError(
        "UNITY_PROJECT_METADATA_INVALID",
        "Bridge response limit must be at least 1024 bytes.",
      );
    }
  }

  async descriptor(): Promise<UnityBridgeSessionDescriptor> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.descriptorPath, "utf8")) as unknown;
    } catch (error: unknown) {
      if (missingFile(error)) {
        throw new UnityIntegrationError(
          "UNITY_BRIDGE_NOT_CONNECTED",
          "Unity bridge session descriptor was not found.",
        );
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new UnityIntegrationError(
        "UNITY_PROJECT_METADATA_INVALID",
        `Unity bridge session descriptor is invalid: ${message}`,
      );
    }
    return parseUnityBridgeSessionDescriptor(value, this.expectedProjectRoot);
  }

  async request<T>(
    method: UnityBridgeMethod,
    params: UnityBridgeParams = {},
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted === true) {
      throw new UnityIntegrationError(
        "UNITY_BRIDGE_CANCELLED",
        `Unity command ${method} was cancelled.`,
      );
    }
    const descriptor = await this.descriptor();
    const id = randomUUID();
    const request = `${JSON.stringify({
      id,
      token: descriptor.sessionToken,
      protocolVersion: UNITY_BRIDGE_PROTOCOL_VERSION,
      method,
      params,
    })}\n`;
    const responseText = await this.exchange(
      descriptor,
      request,
      method,
      signal,
    );
    let response: UnityBridgeResponse<T>;
    try {
      response = JSON.parse(responseText) as UnityBridgeResponse<T>;
    } catch {
      throw new UnityIntegrationError(
        "UNITY_COMMAND_FAILED",
        `Unity bridge returned invalid JSON for ${method}.`,
      );
    }
    if (response.id !== id || typeof response.ok !== "boolean") {
      throw new UnityIntegrationError(
        "UNITY_COMMAND_FAILED",
        `Unity bridge returned a mismatched response for ${method}.`,
      );
    }
    if (!response.ok) {
      throw errorForBridgeResponse(
        response.error?.code ?? "UNKNOWN",
        response.error?.message ?? `Unity command ${method} failed.`,
      );
    }
    if (response.result === undefined) {
      throw new UnityIntegrationError(
        "UNITY_COMMAND_FAILED",
        `Unity bridge returned no result for ${method}.`,
      );
    }
    return response.result;
  }

  ping(signal?: AbortSignal): Promise<UnityBridgePing> {
    return this.request("bridge.ping", {}, signal);
  }

  editorStatus(signal?: AbortSignal): Promise<UnityEditorStatus> {
    return this.request("editor.status", {}, signal);
  }

  async waitForPlayModeState(
    expected: boolean,
    input: {
      readonly timeoutMs?: number;
      readonly stableForMs?: number;
    } = {},
    signal?: AbortSignal,
  ): Promise<UnityEditorStatus> {
    const timeoutMs = input.timeoutMs ?? 120_000;
    const stableForMs = input.stableForMs ?? 1_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new UnityIntegrationError(
        "UNITY_PROJECT_METADATA_INVALID",
        "Play Mode wait timeout must be a positive integer.",
      );
    }
    if (!Number.isSafeInteger(stableForMs) || stableForMs < 0 || stableForMs > timeoutMs) {
      throw new UnityIntegrationError(
        "UNITY_PROJECT_METADATA_INVALID",
        "Play Mode stability window must be a non-negative integer within the wait timeout.",
      );
    }
    const deadline = Date.now() + timeoutMs;
    let stableSince: number | undefined;
    let latest: UnityEditorStatus | undefined;
    while (Date.now() < deadline) {
      if (signal?.aborted === true) {
        throw new UnityIntegrationError(
          "UNITY_BRIDGE_CANCELLED",
          "Play Mode state wait was cancelled.",
        );
      }
      try {
        latest = await this.editorStatus(signal);
        if (
          latest.isPlaying === expected &&
          !latest.isCompiling &&
          !latest.isUpdating
        ) {
          stableSince ??= Date.now();
          if (Date.now() - stableSince >= stableForMs) {
            return latest;
          }
        } else {
          stableSince = undefined;
        }
      } catch (error: unknown) {
        if (
          !(error instanceof UnityIntegrationError) ||
          (error.code !== "UNITY_BRIDGE_NOT_CONNECTED" &&
            error.code !== "UNITY_BRIDGE_TIMEOUT")
        ) {
          throw error;
        }
        // Entering/exiting Play Mode may reload the AppDomain after the first
        // matching status. A command against that retiring bridge can time out;
        // wait for the replacement bridge and a stable state instead.
        stableSince = undefined;
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    throw new UnityIntegrationError(
      "UNITY_BRIDGE_TIMEOUT",
      `Unity did not remain in ${expected ? "Play" : "Edit"} Mode for ${stableForMs} ms within the wait timeout.`,
      { latest },
    );
  }

  requestCompilation(signal?: AbortSignal): Promise<{
    readonly requested: boolean;
    readonly requestId?: string;
  }> {
    return this.request("editor.requestCompilation", {}, signal);
  }

  enterPlayMode(signal?: AbortSignal): Promise<{ readonly requested: boolean }> {
    return this.request("play.enter", {}, signal);
  }

  exitPlayMode(signal?: AbortSignal): Promise<{ readonly requested: boolean }> {
    return this.request("play.exit", {}, signal);
  }

  setPlayModePaused(
    paused: boolean,
    signal?: AbortSignal,
  ): Promise<{ readonly paused: boolean }> {
    return this.request("play.setPaused", { paused }, signal);
  }

  console(
    input: { readonly limit?: number; readonly offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<UnityConsoleResult> {
    return this.request("console.get", input, signal);
  }

  sceneSummary(signal?: AbortSignal): Promise<UnitySceneSummary> {
    return this.request("scene.summary", {}, signal);
  }

  sceneHierarchy(
    input: {
      readonly offset?: number;
      readonly maxDepth?: number;
      readonly maxObjects?: number;
    } = {},
    signal?: AbortSignal,
  ): Promise<UnitySceneHierarchy> {
    return this.request("scene.hierarchy", input, signal);
  }

  objectSnapshot(
    input: {
      readonly instanceId?: number;
      readonly hierarchyPath?: string;
      readonly maxProperties?: number;
    },
    signal?: AbortSignal,
  ): Promise<UnityObjectSnapshot> {
    return this.request("object.snapshot", input, signal);
  }

  reloadScene(signal?: AbortSignal): Promise<{ readonly requested: boolean }> {
    return this.request("play.reloadScene", {}, signal);
  }

  inputCapabilities(signal?: AbortSignal): Promise<UnityInputCapabilities> {
    return this.request("input.capabilities", {}, signal);
  }

  inputBindings(
    input: {
      readonly action?: string;
      readonly actionMap?: string;
      readonly maxBindings?: number;
    } = {},
    signal?: AbortSignal,
  ): Promise<UnityInputBindings> {
    return this.request("input.bindings", input, signal);
  }

  resolveInputAction(
    input: { readonly action: string; readonly actionMap?: string },
    signal?: AbortSignal,
  ): Promise<UnityInputActionResolution> {
    return this.request("input.resolveAction", input, signal);
  }

  setInputControl(
    input: {
      readonly device: "KEYBOARD" | "MOUSE" | "GAMEPAD";
      readonly control: string;
      readonly value: readonly number[];
    },
    signal?: AbortSignal,
  ): Promise<UnityInputCommandResult> {
    return this.request("input.control", input, signal);
  }

  async pressInputControl(
    input: {
      readonly device: "KEYBOARD" | "MOUSE" | "GAMEPAD";
      readonly control: string;
      readonly frames?: number;
    },
    signal?: AbortSignal,
  ): Promise<{
    readonly down: UnityInputCommandResult;
    readonly up: UnityInputCommandResult;
    readonly frames: number;
  }> {
    const frames = input.frames ?? 1;
    const down = await this.setInputControl({ ...input, value: [1] }, signal);
    let up: UnityInputCommandResult | undefined;
    try {
      await this.waitFrames(frames, signal);
    } finally {
      up = await this.setInputControl({ ...input, value: [0] });
    }
    if (up === undefined) {
      throw new UnityIntegrationError("UNITY_COMMAND_FAILED", "Input release returned no result.");
    }
    return { down, up, frames };
  }

  async waitFrames(frames: number, signal?: AbortSignal): Promise<{
    readonly startFrame: number;
    readonly endFrame: number;
    readonly frames: number;
  }> {
    if (!Number.isSafeInteger(frames) || frames < 1 || frames > 3_600) {
      throw new UnityIntegrationError(
        "UNITY_PROJECT_METADATA_INVALID",
        "Frame wait must be an integer between 1 and 3600.",
      );
    }
    const initial = await this.editorStatus(signal);
    if (!initial.isPlaying || initial.isPaused) {
      throw new UnityIntegrationError(
        "INPUT_NOT_ACTIVE",
        "Frame waits require unpaused Play Mode.",
      );
    }
    if (initial.frameCount === undefined) {
      throw new UnityIntegrationError(
        "UNITY_COMMAND_FAILED",
        "Unity bridge did not report a Play Mode frame counter.",
      );
    }
    const target = initial.frameCount + frames;
    const deadline = Date.now() + Math.max(this.timeoutMs, frames * 250);
    let status = initial;
    while ((status.frameCount ?? -1) < target) {
      if (signal?.aborted === true) {
        throw new UnityIntegrationError(
          "UNITY_BRIDGE_CANCELLED",
          "Unity frame wait was cancelled.",
        );
      }
      if (Date.now() >= deadline) {
        throw new UnityIntegrationError(
          "UNITY_BRIDGE_TIMEOUT",
          `Unity did not advance ${frames} frame(s) before the timeout.`,
        );
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 16));
      status = await this.editorStatus(signal);
      if (!status.isPlaying || status.isPaused) {
        throw new UnityIntegrationError(
          "INPUT_NOT_ACTIVE",
          "Play Mode stopped or paused during the frame wait.",
        );
      }
    }
    if (status.frameCount === undefined) {
      throw new UnityIntegrationError("UNITY_COMMAND_FAILED", "Unity frame counter disappeared during the wait.");
    }
    return { startFrame: initial.frameCount, endFrame: status.frameCount, frames };
  }

  releaseAllInputs(signal?: AbortSignal): Promise<UnityReleaseInputsResult> {
    return this.request("input.releaseAll", {}, signal);
  }

  async inputAction(
    input: {
      readonly action: string;
      readonly actionMap?: string;
      readonly value?: readonly number[];
      readonly holdFrames?: number;
    },
    signal?: AbortSignal,
  ): Promise<{
    readonly resolution: UnityInputActionResolution;
    readonly controls: readonly string[];
    readonly frames: number;
  }> {
    const resolution = await this.resolveInputAction(input, signal);
    const selected = this.controlsForSemanticValue(resolution, input.value ?? [1]);
    if (selected.length === 0) {
      throw new UnityIntegrationError(
        "INPUT_BINDING_UNSUPPORTED",
        `Action ${input.action} has no safe virtual-device mapping for the requested value.`,
      );
    }
    const parsed = selected.map((entry) => this.parseControlPath(entry.path));
    try {
      for (const control of parsed) {
        await this.setInputControl({ ...control, value: [1] }, signal);
      }
      await this.waitFrames(input.holdFrames ?? 1, signal);
    } finally {
      for (const control of parsed) {
        await this.setInputControl({ ...control, value: [0] }).catch(() => undefined);
      }
    }
    return {
      resolution,
      controls: selected.map((entry) => entry.path),
      frames: input.holdFrames ?? 1,
    };
  }

  async gameViewScreenshot(
    input: { readonly maxWidth?: number; readonly maxHeight?: number } = {},
    signal?: AbortSignal,
  ): Promise<UnityGameViewScreenshot> {
    const metadata = await this.request<UnityGameViewScreenshotMetadata>(
      "gameView.screenshot",
      input,
      signal,
    );
    const screenshotsRoot = resolve(this.expectedProjectRoot, "Library", "UnityAI", "screenshots");
    const screenshotPath = resolve(this.expectedProjectRoot, metadata.relativePath);
    const fromRoot = relative(screenshotsRoot, screenshotPath);
    if (fromRoot.length === 0 || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new UnityIntegrationError(
        "SCREENSHOT_CAPTURE_FAILED",
        "Unity screenshot path escaped the controlled Library/UnityAI/screenshots directory.",
      );
    }
    const bytes = await readFile(screenshotPath);
    if (bytes.length !== metadata.byteCount || bytes.length > 2_500_000) {
      throw new UnityIntegrationError(
        "SCREENSHOT_CAPTURE_FAILED",
        "Unity screenshot size did not match its bounded metadata.",
      );
    }
    return { ...metadata, data: bytes.toString("base64") };
  }

  runtimeProbe(
    input: {
      readonly instanceId?: number;
      readonly hierarchyPath?: string;
      readonly componentType: string;
      readonly propertyPath: string;
    },
    signal?: AbortSignal,
  ): Promise<UnityRuntimeProbeResult> {
    return this.request("runtime.probe", input, signal);
  }

  private controlsForSemanticValue(
    resolution: UnityInputActionResolution,
    value: readonly number[],
  ): readonly { readonly role: string; readonly path: string }[] {
    if (resolution.mode === "BUTTON") {
      return resolution.controls.slice(0, 1);
    }
    if (resolution.mode === "AXIS_1D") {
      const role = (value[0] ?? 0) < 0 ? "negative" : "positive";
      return resolution.controls.filter((entry) => entry.role.toLowerCase() === role).slice(0, 1);
    }
    const x = value[0] ?? 0;
    const y = value[1] ?? 0;
    const roles = new Set<string>();
    if (x < 0) roles.add("left");
    if (x > 0) roles.add("right");
    if (y < 0) roles.add("down");
    if (y > 0) roles.add("up");
    return resolution.controls.filter((entry) => roles.has(entry.role.toLowerCase()));
  }

  private parseControlPath(path: string): {
    readonly device: "KEYBOARD" | "MOUSE" | "GAMEPAD";
    readonly control: string;
  } {
    const match = /^<(Keyboard|Mouse|Gamepad)>\/(.+)$/iu.exec(path);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new UnityIntegrationError(
        "INPUT_BINDING_UNSUPPORTED",
        `Binding ${path} is not a supported keyboard, mouse, or gamepad control path.`,
      );
    }
    return {
      device: match[1].toUpperCase() as "KEYBOARD" | "MOUSE" | "GAMEPAD",
      control: match[2],
    };
  }

  private exchange(
    descriptor: UnityBridgeSessionDescriptor,
    request: string,
    method: UnityBridgeMethod,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      let socket: Socket | undefined;
      let settled = false;
      let receivedBytes = 0;
      const chunks: Buffer[] = [];

      const finish = (error?: UnityIntegrationError, value?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket?.destroy();
        if (error !== undefined) {
          rejectPromise(error);
        } else {
          resolvePromise(value ?? "");
        }
      };
      const abort = (): void => finish(
        new UnityIntegrationError(
          "UNITY_BRIDGE_CANCELLED",
          `Unity command ${method} was cancelled.`,
        ),
      );
      const timer = setTimeout(() => finish(
        new UnityIntegrationError(
          "UNITY_BRIDGE_TIMEOUT",
          `Unity command ${method} timed out after ${this.timeoutMs} ms.`,
        ),
      ), this.timeoutMs);

      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) {
        abort();
        return;
      }
      socket = createConnection({
        host: descriptor.host,
        port: descriptor.port,
      });
      socket.setNoDelay(true);
      socket.once("connect", () => socket?.write(request, "utf8"));
      socket.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > this.maximumResponseBytes) {
          finish(new UnityIntegrationError(
            "UNITY_BRIDGE_RESPONSE_TOO_LARGE",
            `Unity bridge response exceeded ${this.maximumResponseBytes} bytes.`,
          ));
          return;
        }
        chunks.push(chunk);
        const combined = Buffer.concat(chunks);
        const newline = combined.indexOf(0x0a);
        if (newline >= 0) {
          finish(undefined, combined.subarray(0, newline).toString("utf8"));
        }
      });
      socket.once("error", (error: Error) => finish(
        new UnityIntegrationError(
          "UNITY_BRIDGE_NOT_CONNECTED",
          `Could not connect to the Unity bridge: ${error.message}`,
        ),
      ));
      socket.once("end", () => {
        if (!settled) {
          finish(new UnityIntegrationError(
            "UNITY_BRIDGE_NOT_CONNECTED",
            `Unity bridge closed before replying to ${method}.`,
          ));
        }
      });
    });
  }
}
