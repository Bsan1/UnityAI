export const UNITY_ERROR_CODES = [
  "NOT_A_UNITY_PROJECT",
  "UNITY_VERSION_UNKNOWN",
  "UNITY_PROJECT_METADATA_INVALID",
  "UNITY_MANIFEST_INVALID",
  "UNITY_EDITOR_NOT_FOUND",
  "UNITY_EDITOR_VERSION_MISMATCH",
  "UNITY_BRIDGE_CONFLICT",
  "UNITY_BRIDGE_NOT_INSTALLED",
  "UNITY_BRIDGE_OWNERSHIP_MISMATCH",
  "UNITY_BRIDGE_NOT_CONNECTED",
  "UNITY_BRIDGE_AUTH_FAILED",
  "UNITY_BRIDGE_PROTOCOL_MISMATCH",
  "UNITY_BRIDGE_TIMEOUT",
  "UNITY_BRIDGE_CANCELLED",
  "UNITY_BRIDGE_RESPONSE_TOO_LARGE",
  "UNITY_EDITOR_START_FAILED",
  "UNITY_EDITOR_EXITED",
  "EDITOR_NOT_OWNED",
  "INPUT_NOT_ACTIVE",
  "INPUT_SYSTEM_UNAVAILABLE",
  "INPUT_BINDING_UNSUPPORTED",
  "SCREENSHOT_CAPTURE_FAILED",
  "RUNTIME_PROBE_INVALID",
  "OS_INPUT_FOCUS_UNSAFE",
  "UNITY_COMMAND_FAILED",
] as const;

export type UnityErrorCode = (typeof UNITY_ERROR_CODES)[number];

export class UnityIntegrationError extends Error {
  readonly code: UnityErrorCode;
  readonly details?: unknown;

  constructor(code: UnityErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "UnityIntegrationError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
