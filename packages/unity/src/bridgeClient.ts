import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { join, resolve } from "node:path";

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
  UnityObjectSnapshot,
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
