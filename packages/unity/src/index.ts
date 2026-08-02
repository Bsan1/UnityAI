export { UnityBridgeClient } from "./bridgeClient.js";
export type { UnityBridgeClientOptions } from "./bridgeClient.js";
export { UnityEditorResolver } from "./editorResolver.js";
export type { UnityEditorResolverOptions } from "./editorResolver.js";
export { UNITY_ERROR_CODES, UnityIntegrationError } from "./errors.js";
export type { UnityErrorCode } from "./errors.js";
export { UnityProjectAdapter } from "./projectAdapter.js";
export {
  UNITY_BRIDGE_METHODS,
  UNITY_BRIDGE_PACKAGE_NAME,
  UNITY_BRIDGE_PROTOCOL_VERSION,
  UNITY_BRIDGE_VERSION,
} from "./types.js";
export type {
  UnityBridgeMethod,
  UnityBridgeParams,
  UnityBridgePing,
  UnityBridgeResponse,
  UnityBridgeSessionDescriptor,
  UnityComponentSnapshot,
  UnityConsoleEntry,
  UnityConsoleResult,
  UnityEditorResolution,
  UnityEditorResolutionMethod,
  UnityEditorStatus,
  UnityHierarchyObject,
  UnityInputHandling,
  UnityObjectSnapshot,
  UnityPackageDependency,
  UnityProjectMetadata,
  UnitySceneHierarchy,
  UnitySceneSummary,
  UnitySerializedPropertySnapshot,
  UnityTransformSnapshot,
} from "./types.js";
export {
  canonicalPathsEqual,
  parseUnityBridgeSessionDescriptor,
} from "./validation.js";
