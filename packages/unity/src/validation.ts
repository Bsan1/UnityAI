import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { UnityIntegrationError } from "./errors.js";
import { UNITY_BRIDGE_PROTOCOL_VERSION } from "./types.js";
import type { UnityBridgeSessionDescriptor } from "./types.js";

const asRecord = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnityIntegrationError(
      "UNITY_PROJECT_METADATA_INVALID",
      `${name} must be an object.`,
    );
  }
  return value as Record<string, unknown>;
};

const string = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UnityIntegrationError(
      "UNITY_PROJECT_METADATA_INVALID",
      `${name} must be a non-empty string.`,
    );
  }
  return value;
};

const integer = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value)) {
    throw new UnityIntegrationError(
      "UNITY_PROJECT_METADATA_INVALID",
      `${name} must be an integer.`,
    );
  }
  return value as number;
};

const pathKey = (value: string): string =>
  process.platform === "win32"
    ? value.toLocaleLowerCase("en-US")
    : value;

export const canonicalPathsEqual = async (
  left: string,
  right: string,
): Promise<boolean> => {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    realpath(resolve(left)),
    realpath(resolve(right)),
  ]);
  return pathKey(canonicalLeft) === pathKey(canonicalRight);
};

export const parseUnityBridgeSessionDescriptor = async (
  value: unknown,
  expectedProjectRoot: string,
): Promise<UnityBridgeSessionDescriptor> => {
  const input = asRecord(value, "bridge session descriptor");
  if (input.protocolVersion !== UNITY_BRIDGE_PROTOCOL_VERSION) {
    throw new UnityIntegrationError(
      "UNITY_BRIDGE_PROTOCOL_MISMATCH",
      `Bridge protocol ${String(input.protocolVersion)} is not supported; expected ${UNITY_BRIDGE_PROTOCOL_VERSION}.`,
    );
  }
  const projectRoot = string(input.projectRoot, "descriptor.projectRoot");
  let matches = false;
  try {
    matches = await canonicalPathsEqual(projectRoot, expectedProjectRoot);
  } catch {
    matches = false;
  }
  if (!matches) {
    throw new UnityIntegrationError(
      "UNITY_BRIDGE_NOT_CONNECTED",
      "Bridge session belongs to a different Unity project.",
      { expectedProjectRoot, descriptorProjectRoot: projectRoot },
    );
  }
  if (input.host !== "127.0.0.1") {
    throw new UnityIntegrationError(
      "UNITY_BRIDGE_NOT_CONNECTED",
      "Bridge session host must be the numeric IPv4 loopback address 127.0.0.1.",
    );
  }
  const port = integer(input.port, "descriptor.port");
  if (port < 1 || port > 65_535) {
    throw new UnityIntegrationError(
      "UNITY_PROJECT_METADATA_INVALID",
      "descriptor.port must be between 1 and 65535.",
    );
  }
  const editorProcessId = integer(
    input.editorProcessId,
    "descriptor.editorProcessId",
  );
  if (editorProcessId < 1) {
    throw new UnityIntegrationError(
      "UNITY_PROJECT_METADATA_INVALID",
      "descriptor.editorProcessId must be positive.",
    );
  }
  const startedAt = string(input.startedAt, "descriptor.startedAt");
  if (Number.isNaN(Date.parse(startedAt))) {
    throw new UnityIntegrationError(
      "UNITY_PROJECT_METADATA_INVALID",
      "descriptor.startedAt must be an ISO timestamp.",
    );
  }
  const sessionToken = string(input.sessionToken, "descriptor.sessionToken");
  if (sessionToken.length < 32 || sessionToken.length > 256) {
    throw new UnityIntegrationError(
      "UNITY_PROJECT_METADATA_INVALID",
      "descriptor.sessionToken length is invalid.",
    );
  }
  return {
    protocolVersion: UNITY_BRIDGE_PROTOCOL_VERSION,
    bridgeVersion: string(input.bridgeVersion, "descriptor.bridgeVersion"),
    projectRoot,
    unityVersion: string(input.unityVersion, "descriptor.unityVersion"),
    editorProcessId,
    host: "127.0.0.1",
    port,
    sessionToken,
    startedAt,
  };
};
