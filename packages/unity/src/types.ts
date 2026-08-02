export const UNITY_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const UNITY_BRIDGE_VERSION = "0.3.0" as const;
export const UNITY_BRIDGE_PACKAGE_NAME = "com.unityai.editor-bridge" as const;

export interface UnityPackageDependency {
  readonly name: string;
  readonly version: string;
  readonly lockedVersion?: string;
}

export type UnityInputHandling = "OLD" | "NEW" | "BOTH" | "UNKNOWN";

export interface UnityProjectMetadata {
  readonly schemaVersion: 1;
  readonly isUnityProject: true;
  readonly projectRoot: string;
  readonly unityVersion: string;
  readonly unityRevision?: string;
  readonly projectVersionFile: string;
  readonly manifestFile: string;
  readonly packageLockPresent: boolean;
  readonly packages: readonly UnityPackageDependency[];
  readonly inputSystem: {
    readonly packagePresent: boolean;
    readonly activeInputHandling: UnityInputHandling;
  };
  readonly scripting: {
    readonly backendConfiguration?: string;
    readonly apiCompatibilityConfiguration?: string;
  };
  readonly inspectedAt: string;
}

export type UnityEditorResolutionMethod =
  | "EXPLICIT_OVERRIDE"
  | "UNITY_HUB_EXACT_VERSION";

export interface UnityEditorResolution {
  readonly requestedVersion: string;
  readonly executablePath: string;
  readonly resolutionMethod: UnityEditorResolutionMethod;
}

export interface UnityBridgeSessionDescriptor {
  readonly protocolVersion: 1;
  readonly bridgeVersion: string;
  readonly projectRoot: string;
  readonly unityVersion: string;
  readonly editorProcessId: number;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly sessionToken: string;
  readonly startedAt: string;
}

export interface UnityBridgePing {
  readonly protocolVersion: number;
  readonly bridgeVersion: string;
  readonly unityVersion: string;
  readonly projectPath: string;
  readonly processId: number;
}

export interface UnityEditorStatus {
  readonly isPlaying: boolean;
  readonly isPaused: boolean;
  readonly isCompiling: boolean;
  readonly isUpdating: boolean;
  readonly activeScene: string;
  readonly activePlatform: string;
  readonly frameCount?: number;
  readonly lastCompilation?: UnityCompilationResult;
}

export type UnityVirtualInputDevice = "KEYBOARD" | "MOUSE" | "GAMEPAD";

export interface UnityInputCapabilities {
  readonly inputSystemAvailable: boolean;
  readonly legacyInputAvailable: boolean;
  readonly activeInputHandling: UnityInputHandling;
  readonly virtualDevicesSupported: readonly UnityVirtualInputDevice[];
  readonly qaOwnedDevices: readonly {
    readonly device: UnityVirtualInputDevice;
    readonly name: string;
    readonly deviceId: number;
  }[];
  readonly osFallback: "ORCHESTRATOR_ONLY";
}

export interface UnityInputBinding {
  readonly actionMap: string;
  readonly action: string;
  readonly enabled: boolean;
  readonly bindingName: string;
  readonly path: string;
  readonly effectivePath: string;
  readonly groups: string;
  readonly isComposite: boolean;
  readonly isPartOfComposite: boolean;
}

export interface UnityInputBindings {
  readonly complete: boolean;
  readonly count: number;
  readonly hasMore: boolean;
  readonly bindings: readonly UnityInputBinding[];
}

export interface UnityInputActionResolution {
  readonly action: string;
  readonly actionMap: string;
  readonly mode: "BUTTON" | "AXIS_1D" | "VECTOR_2D";
  readonly controls: readonly {
    readonly role: string;
    readonly path: string;
  }[];
}

export interface UnityInputCommandResult {
  readonly inputSource: "UNITY_INPUT_SYSTEM_VIRTUAL_DEVICE";
  readonly device: UnityVirtualInputDevice;
  readonly control: string;
  readonly value: readonly number[];
  readonly frameCount: number;
}

export interface UnityReleaseInputsResult {
  readonly releasedControls: number;
  readonly removedDevices: number;
  readonly frameCount: number;
}

export interface UnityGameViewScreenshotMetadata {
  readonly evidenceId: string;
  readonly relativePath: string;
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly byteCount: number;
  readonly capturedAt: string;
}

export interface UnityGameViewScreenshot extends UnityGameViewScreenshotMetadata {
  readonly data: string;
}

export type UnityRuntimeProbeValueType =
  | "Boolean"
  | "Integer"
  | "Float"
  | "String"
  | "Enum"
  | "Vector2"
  | "Vector3"
  | "Quaternion"
  | "Color"
  | "ObjectReference";

export interface UnityRuntimeProbeResult {
  readonly hierarchyPath: string;
  readonly componentType: string;
  readonly propertyPath: string;
  readonly valueType: UnityRuntimeProbeValueType;
  readonly value: string;
  readonly truncated: boolean;
}

export interface UnityCompilationMessage {
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface UnityCompilationResult {
  readonly requestId: string;
  readonly requestedAt: string;
  readonly completed: boolean;
  readonly completedAt: string;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly messagesTruncated: boolean;
  readonly messages: readonly UnityCompilationMessage[];
}

export interface UnityConsoleEntry {
  readonly severity: string;
  readonly message: string;
  readonly stackTrace: string;
  readonly timestamp: string;
  readonly sequence: number;
}

export interface UnityConsoleResult {
  readonly complete: boolean;
  readonly offset: number;
  readonly count: number;
  readonly totalAvailable: number;
  readonly entries: readonly UnityConsoleEntry[];
}

export interface UnityTransformSnapshot {
  readonly position: readonly number[];
  readonly localPosition: readonly number[];
  readonly rotationEuler: readonly number[];
  readonly localScale: readonly number[];
}

export interface UnityHierarchyObject {
  readonly instanceId: number;
  readonly hierarchyPath: string;
  readonly name: string;
  readonly activeSelf: boolean;
  readonly activeInHierarchy: boolean;
  readonly tag: string;
  readonly layer: number;
  readonly transform: UnityTransformSnapshot;
  readonly componentTypeNames: readonly string[];
}

export interface UnitySceneSummary {
  readonly activeScene: string;
  readonly scenes: readonly {
    readonly name: string;
    readonly path: string;
    readonly isLoaded: boolean;
    readonly isDirty: boolean;
    readonly rootCount: number;
  }[];
}

export interface UnitySceneHierarchy {
  readonly offset: number;
  readonly count: number;
  readonly maxDepth: number;
  readonly hasMore: boolean;
  readonly objects: readonly UnityHierarchyObject[];
}

export interface UnitySerializedPropertySnapshot {
  readonly path: string;
  readonly type: string;
  readonly value: string;
}

export interface UnityComponentSnapshot {
  readonly typeName: string;
  readonly properties: readonly UnitySerializedPropertySnapshot[];
}

export interface UnityObjectSnapshot extends UnityHierarchyObject {
  readonly components: readonly UnityComponentSnapshot[];
  readonly propertiesComplete: boolean;
}

export const UNITY_BRIDGE_METHODS = [
  "bridge.ping",
  "editor.status",
  "editor.requestCompilation",
  "play.enter",
  "play.exit",
  "play.setPaused",
  "console.get",
  "scene.summary",
  "scene.hierarchy",
  "object.snapshot",
  "play.reloadScene",
  "input.capabilities",
  "input.bindings",
  "input.resolveAction",
  "input.control",
  "input.releaseAll",
  "gameView.screenshot",
  "runtime.probe",
] as const;

export type UnityBridgeMethod = (typeof UNITY_BRIDGE_METHODS)[number];

export interface UnityBridgeParams {
  readonly paused?: boolean;
  readonly limit?: number;
  readonly offset?: number;
  readonly maxDepth?: number;
  readonly maxObjects?: number;
  readonly instanceId?: number;
  readonly hierarchyPath?: string;
  readonly maxProperties?: number;
  readonly action?: string;
  readonly actionMap?: string;
  readonly device?: UnityVirtualInputDevice;
  readonly control?: string;
  readonly value?: readonly number[];
  readonly maxBindings?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly componentType?: string;
  readonly propertyPath?: string;
}

export interface UnityBridgeResponse<T> {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: T;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}
