import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import {
  UNITY_BRIDGE_PROTOCOL_VERSION,
  UnityBridgeClient,
  UnityEditorResolver,
  UnityIntegrationError,
  UnityProjectAdapter,
  parseUnityBridgeSessionDescriptor,
} from "../src/index.js";

const roots = new Set<string>();

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "unityai-m6-unity-"));
  roots.add(root);
  return root;
};

afterEach(async () => {
  const values = [...roots];
  roots.clear();
  await Promise.all(values.map((root) => rm(root, { recursive: true, force: true })));
});

const createUnityProject = async (input: {
  readonly versionText?: string;
  readonly manifest?: unknown;
  readonly lock?: unknown;
  readonly projectSettings?: string;
} = {}): Promise<string> => {
  const root = await temporaryRoot();
  await Promise.all([
    mkdir(join(root, "Assets")),
    mkdir(join(root, "Packages")),
    mkdir(join(root, "ProjectSettings")),
  ]);
  await writeFile(
    join(root, "ProjectSettings", "ProjectVersion.txt"),
    input.versionText ??
      "m_EditorVersion: 6000.3.11f1\nm_EditorVersionWithRevision: 6000.3.11f1 (abc123)\n",
    "utf8",
  );
  await writeFile(
    join(root, "Packages", "manifest.json"),
    JSON.stringify(input.manifest ?? {
      dependencies: {
        "com.unity.inputsystem": "1.11.2",
        "com.unity.test-framework": "1.4.5",
      },
    }),
    "utf8",
  );
  if (input.lock !== null) {
    await writeFile(
      join(root, "Packages", "packages-lock.json"),
      JSON.stringify(input.lock ?? {
        dependencies: {
          "com.unity.inputsystem": { version: "1.11.2" },
        },
      }),
      "utf8",
    );
  }
  await writeFile(
    join(root, "ProjectSettings", "ProjectSettings.asset"),
    input.projectSettings ??
      "PlayerSettings:\n  activeInputHandler: 1\n  scriptingBackend: {}\n  apiCompatibilityLevelPerPlatform: {}\n",
    "utf8",
  );
  return root;
};

const unityError = (code: string) => (error: unknown): boolean =>
  error instanceof UnityIntegrationError && error.code === code;

test("Unity project adapter detects structure, version, packages, Input System, and safe settings", async () => {
  const root = await createUnityProject();
  const metadata = await new UnityProjectAdapter().inspect(root);
  assert.equal(metadata.isUnityProject, true);
  assert.equal(metadata.projectRoot, await import("node:fs/promises").then(({ realpath }) => realpath(root)));
  assert.equal(metadata.unityVersion, "6000.3.11f1");
  assert.equal(metadata.unityRevision, "abc123");
  assert.equal(metadata.inputSystem.packagePresent, true);
  assert.equal(metadata.inputSystem.activeInputHandling, "NEW");
  assert.equal(metadata.packageLockPresent, true);
  assert.deepEqual(
    metadata.packages.map((entry) => entry.name),
    ["com.unity.inputsystem", "com.unity.test-framework"],
  );
  assert.equal(metadata.packages[0]?.lockedVersion, "1.11.2");
});

test("Unity project adapter rejects non-projects, malformed versions, and invalid manifests clearly", async (t) => {
  await t.test("not a Unity project", async () => {
    const root = await temporaryRoot();
    await assert.rejects(() => new UnityProjectAdapter().inspect(root), unityError("NOT_A_UNITY_PROJECT"));
  });
  await t.test("unknown Unity version", async () => {
    const root = await createUnityProject({ versionText: "not-version-data\n" });
    await assert.rejects(() => new UnityProjectAdapter().inspect(root), unityError("UNITY_VERSION_UNKNOWN"));
  });
  await t.test("invalid manifest", async () => {
    const root = await createUnityProject({ manifest: { dependencies: { invalid: 42 } } });
    await assert.rejects(() => new UnityProjectAdapter().inspect(root), unityError("UNITY_MANIFEST_INVALID"));
  });
  await t.test("optional package lock", async () => {
    const root = await createUnityProject({ lock: null });
    const metadata = await new UnityProjectAdapter().inspect(root);
    assert.equal(metadata.packageLockPresent, false);
  });
});

test("Unity Editor resolver respects explicit override and exact Hub version matching", async () => {
  const root = await temporaryRoot();
  const exact = join(root, "6000.3.11f1", "Editor", "Unity.exe");
  const override = join(root, "custom", "Unity.exe");
  await mkdir(join(root, "6000.3.11f1", "Editor"), { recursive: true });
  await mkdir(join(root, "custom"), { recursive: true });
  await writeFile(exact, "fixture", "utf8");
  await writeFile(override, "fixture", "utf8");
  const resolver = new UnityEditorResolver({ platform: "win32", searchRoots: [root] });
  const explicit = await resolver.resolve("6000.3.11f1", override);
  assert.equal(explicit.resolutionMethod, "EXPLICIT_OVERRIDE");
  assert.equal(explicit.executablePath, resolve(override));
  const automatic = await resolver.resolve("6000.3.11f1");
  assert.equal(automatic.resolutionMethod, "UNITY_HUB_EXACT_VERSION");
  assert.equal(automatic.executablePath, resolve(exact));
  await assert.rejects(() => resolver.resolve("2022.3.1f1"), unityError("UNITY_EDITOR_NOT_FOUND"));
});

interface FakeBridge {
  readonly server: Server;
  readonly root: string;
  readonly descriptorPath: string;
  readonly token: string;
  readonly requests: Array<Record<string, unknown>>;
}

const startFakeBridge = async (options: {
  readonly token?: string;
  readonly descriptorToken?: string;
  readonly descriptorProject?: string;
  readonly protocolVersion?: number;
  readonly host?: string;
  readonly playing?: boolean;
  readonly reply?: (request: Record<string, unknown>, socket: Socket) => void;
} = {}): Promise<FakeBridge> => {
  const root = await createUnityProject();
  const token = options.token ?? "a".repeat(48);
  const requests: Array<Record<string, unknown>> = [];
  let frameCount = 10;
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", async (chunk: Buffer) => {
      chunks.push(chunk);
      const content = Buffer.concat(chunks);
      const newline = content.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      const request = JSON.parse(content.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
      requests.push(request);
      if (options.reply !== undefined) {
        options.reply(request, socket);
        return;
      }
      const id = String(request.id);
      if (request.token !== token) {
        socket.end(`${JSON.stringify({ id, ok: false, error: { code: "AUTH_FAILED", message: "bad token" } })}\n`);
        return;
      }
      const method = String(request.method);
      const results: Record<string, unknown> = {
        "bridge.ping": {
          protocolVersion: 1,
          bridgeVersion: "0.3.0",
          unityVersion: "6000.3.11f1",
          projectPath: root,
          processId: 1234,
        },
        "editor.status": {
          isPlaying: options.playing ?? false,
          isPaused: false,
          isCompiling: false,
          isUpdating: false,
          activeScene: "SampleScene",
          activePlatform: "StandaloneWindows64",
          frameCount: options.playing === true ? ++frameCount : frameCount,
          lastCompilation: {
            requestId: "compile-1",
            requestedAt: new Date().toISOString(),
            completed: true,
            completedAt: new Date().toISOString(),
            errorCount: 0,
            warningCount: 0,
            messagesTruncated: false,
            messages: [],
          },
        },
        "editor.requestCompilation": { requested: true, requestId: "compile-1" },
        "play.enter": { requested: true },
        "play.exit": { requested: true },
        "play.setPaused": { paused: true },
        "console.get": { complete: false, offset: 0, count: 0, totalAvailable: 0, entries: [] },
        "scene.summary": { activeScene: "SampleScene", scenes: [] },
        "scene.hierarchy": { offset: 0, count: 0, maxDepth: 6, hasMore: false, objects: [] },
        "object.snapshot": {
          instanceId: 1,
          hierarchyPath: "SampleScene:/Camera",
          name: "Camera",
          activeSelf: true,
          activeInHierarchy: true,
          tag: "MainCamera",
          layer: 0,
          transform: { position: [0, 0, 0], localPosition: [0, 0, 0], rotationEuler: [0, 0, 0], localScale: [1, 1, 1] },
          componentTypeNames: ["UnityEngine.Transform"],
          components: [],
          propertiesComplete: true,
        },
        "play.reloadScene": { requested: true },
        "input.capabilities": {
          inputSystemAvailable: true,
          legacyInputAvailable: false,
          activeInputHandling: "NEW",
          virtualDevicesSupported: ["KEYBOARD", "MOUSE", "GAMEPAD"],
          qaOwnedDevices: [],
          osFallback: "ORCHESTRATOR_ONLY",
        },
        "input.bindings": {
          complete: true,
          count: 1,
          hasMore: false,
          bindings: [{
            actionMap: "Player",
            action: "Dash",
            enabled: true,
            bindingName: "",
            path: "<Keyboard>/space",
            effectivePath: "<Keyboard>/space",
            groups: "Keyboard",
            isComposite: false,
            isPartOfComposite: false,
          }],
        },
        "input.resolveAction": {
          action: "Dash",
          actionMap: "Player",
          mode: "BUTTON",
          controls: [{ role: "button", path: "<Keyboard>/space" }],
        },
        "input.control": {
          inputSource: "UNITY_INPUT_SYSTEM_VIRTUAL_DEVICE",
          device: ((request.params as Record<string, unknown> | undefined)?.device ?? "KEYBOARD"),
          control: ((request.params as Record<string, unknown> | undefined)?.control ?? "space"),
          value: ((request.params as Record<string, unknown> | undefined)?.value ?? [1]),
          frameCount,
        },
        "input.releaseAll": { releasedControls: 1, removedDevices: 1, frameCount },
        "gameView.screenshot": {
          evidenceId: "SHOT-FAKE",
          relativePath: "Library/UnityAI/screenshots/SHOT-FAKE.png",
          mimeType: "image/png",
          width: 320,
          height: 180,
          byteCount: 3,
          capturedAt: new Date().toISOString(),
        },
        "runtime.probe": {
          hierarchyPath: "SampleScene:/Player",
          componentType: "PlayerMover",
          propertyPath: "isDashing",
          valueType: "Boolean",
          value: "true",
          truncated: false,
        },
      };
      if (method === "gameView.screenshot") {
        await mkdir(join(root, "Library", "UnityAI", "screenshots"), { recursive: true });
        await writeFile(join(root, "Library", "UnityAI", "screenshots", "SHOT-FAKE.png"), "png", "utf8");
      }
      const result = results[method];
      if (result === undefined) {
        socket.end(`${JSON.stringify({ id, ok: false, error: { code: "UNKNOWN_METHOD", message: "unknown" } })}\n`);
      } else {
        socket.end(`${JSON.stringify({ id, ok: true, result })}\n`);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected fake bridge TCP address.");
  }
  const descriptorPath = join(root, "Library", "UnityAI", "bridge-session.json");
  await mkdir(join(root, "Library", "UnityAI"), { recursive: true });
  await writeFile(descriptorPath, JSON.stringify({
    protocolVersion: options.protocolVersion ?? UNITY_BRIDGE_PROTOCOL_VERSION,
    bridgeVersion: "0.3.0",
    projectRoot: options.descriptorProject ?? root,
    unityVersion: "6000.3.11f1",
    editorProcessId: 1234,
    host: options.host ?? "127.0.0.1",
    port: address.port,
    sessionToken: options.descriptorToken ?? token,
    startedAt: new Date().toISOString(),
  }), "utf8");
  return { server, root, descriptorPath, token, requests };
};

const closeBridge = async (bridge: FakeBridge): Promise<void> => {
  bridge.server.close();
  await once(bridge.server, "close");
};

test("session descriptors enforce protocol, exact project identity, loopback, port, PID, and token schema", async (t) => {
  const rootA = await createUnityProject();
  const rootB = await createUnityProject();
  const base = {
    protocolVersion: 1,
    bridgeVersion: "0.1.0",
    projectRoot: rootA,
    unityVersion: "6000.3.11f1",
    editorProcessId: 123,
    host: "127.0.0.1",
    port: 4321,
    sessionToken: "z".repeat(48),
    startedAt: new Date().toISOString(),
  };
  assert.equal((await parseUnityBridgeSessionDescriptor(base, rootA)).projectRoot, rootA);
  await t.test("cross-project descriptor", async () => {
    await assert.rejects(() => parseUnityBridgeSessionDescriptor(base, rootB), unityError("UNITY_BRIDGE_NOT_CONNECTED"));
  });
  await t.test("non-loopback host", async () => {
    await assert.rejects(() => parseUnityBridgeSessionDescriptor({ ...base, host: "0.0.0.0" }, rootA), unityError("UNITY_BRIDGE_NOT_CONNECTED"));
  });
  await t.test("protocol mismatch", async () => {
    await assert.rejects(() => parseUnityBridgeSessionDescriptor({ ...base, protocolVersion: 2 }, rootA), unityError("UNITY_BRIDGE_PROTOCOL_MISMATCH"));
  });
});

test("bridge client authenticates and maps the focused command set with bounded parameters", async () => {
  const bridge = await startFakeBridge();
  try {
    const client = new UnityBridgeClient(bridge.root);
    assert.equal((await client.ping()).unityVersion, "6000.3.11f1");
    const editorStatus = await client.editorStatus();
    assert.equal(editorStatus.activeScene, "SampleScene");
    assert.equal(editorStatus.lastCompilation?.errorCount, 0);
    assert.equal((await client.requestCompilation()).requestId, "compile-1");
    assert.equal((await client.enterPlayMode()).requested, true);
    assert.equal((await client.exitPlayMode()).requested, true);
    assert.equal((await client.setPlayModePaused(true)).paused, true);
    assert.equal((await client.console({ limit: 20 })).complete, false);
    assert.equal((await client.sceneSummary()).activeScene, "SampleScene");
    assert.equal((await client.sceneHierarchy({ maxDepth: 4, maxObjects: 25 })).objects.length, 0);
    assert.equal((await client.objectSnapshot({ instanceId: 1, maxProperties: 50 })).name, "Camera");
    assert.deepEqual(
      bridge.requests.map((request) => request.method),
      [
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
      ],
    );
    assert.ok(bridge.requests.every((request) => request.token === bridge.token));
  } finally {
    await closeBridge(bridge);
  }
});

test("M8 bridge client drives explicit virtual input, semantic bindings, frame timing, screenshots, and bounded probes", async () => {
  const bridge = await startFakeBridge({ playing: true });
  try {
    const client = new UnityBridgeClient(bridge.root, { timeoutMs: 2_000 });
    assert.equal((await client.inputCapabilities()).inputSystemAvailable, true);
    assert.equal((await client.inputBindings({ action: "Dash" })).bindings[0]?.effectivePath, "<Keyboard>/space");
    assert.equal((await client.reloadScene()).requested, true);
    await client.setInputControl({ device: "KEYBOARD", control: "w", value: [1] });
    await client.setInputControl({ device: "MOUSE", control: "delta", value: [4, -2] });
    await client.setInputControl({ device: "MOUSE", control: "scroll", value: [0, 120] });
    await client.setInputControl({ device: "GAMEPAD", control: "buttonSouth", value: [1] });
    await client.setInputControl({ device: "GAMEPAD", control: "leftStick", value: [1, 0] });
    const keyPress = await client.pressInputControl({ device: "KEYBOARD", control: "space", frames: 2 });
    assert.equal(keyPress.frames, 2);
    const semantic = await client.inputAction({ action: "Dash", actionMap: "Player", holdFrames: 1 });
    assert.deepEqual(semantic.controls, ["<Keyboard>/space"]);
    const released = await client.releaseAllInputs();
    assert.equal(released.removedDevices, 1);
    const screenshot = await client.gameViewScreenshot({ maxWidth: 640, maxHeight: 360 });
    assert.equal(Buffer.from(screenshot.data, "base64").toString("utf8"), "png");
    assert.equal(screenshot.width, 320);
    const probe = await client.runtimeProbe({
      hierarchyPath: "SampleScene:/Player",
      componentType: "PlayerMover",
      propertyPath: "isDashing",
    });
    assert.equal(probe.value, "true");
    const methods = bridge.requests.map((request) => request.method);
    assert.ok(methods.includes("input.resolveAction"));
    assert.ok(methods.filter((method) => method === "input.control").length >= 9);
    assert.equal(methods.some((method) => /execute|method|reflection|shell|file/u.test(String(method))), false);
  } finally {
    await closeBridge(bridge);
  }
});

test("M8 bridge client rejects unsupported bindings and screenshot paths outside controlled Library evidence", async (t) => {
  await t.test("unsupported binding", async () => {
    const bridge = await startFakeBridge({
      playing: true,
      reply: (request, socket) => socket.end(`${JSON.stringify({
        id: request.id,
        ok: false,
        error: { code: "INPUT_BINDING_UNSUPPORTED", message: "unsupported composite" },
      })}\n`),
    });
    try {
      await assert.rejects(
        () => new UnityBridgeClient(bridge.root).resolveInputAction({ action: "Complex" }),
        unityError("INPUT_BINDING_UNSUPPORTED"),
      );
    } finally {
      await closeBridge(bridge);
    }
  });
  await t.test("screenshot path escape", async () => {
    const bridge = await startFakeBridge({
      playing: true,
      reply: (request, socket) => socket.end(`${JSON.stringify({
        id: request.id,
        ok: true,
        result: {
          evidenceId: "SHOT-BAD",
          relativePath: "Assets/SHOT-BAD.png",
          mimeType: "image/png",
          width: 1,
          height: 1,
          byteCount: 1,
          capturedAt: new Date().toISOString(),
        },
      })}\n`),
    });
    try {
      await assert.rejects(
        () => new UnityBridgeClient(bridge.root).gameViewScreenshot(),
        unityError("SCREENSHOT_CAPTURE_FAILED"),
      );
    } finally {
      await closeBridge(bridge);
    }
  });
});

test("bridge client normalizes authentication, unknown-command, timeout, cancellation, and oversized-response failures", async (t) => {
  await t.test("authentication", async () => {
    const bridge = await startFakeBridge({ descriptorToken: "b".repeat(48) });
    try {
      await assert.rejects(() => new UnityBridgeClient(bridge.root).ping(), unityError("UNITY_BRIDGE_AUTH_FAILED"));
    } finally {
      await closeBridge(bridge);
    }
  });
  await t.test("unknown method", async () => {
    const bridge = await startFakeBridge();
    try {
      await assert.rejects(
        () => new UnityBridgeClient(bridge.root).request("unknown" as never),
        unityError("UNITY_COMMAND_FAILED"),
      );
    } finally {
      await closeBridge(bridge);
    }
  });
  await t.test("timeout", async () => {
    const bridge = await startFakeBridge({ reply: () => undefined });
    try {
      await assert.rejects(
        () => new UnityBridgeClient(bridge.root, { timeoutMs: 30 }).ping(),
        unityError("UNITY_BRIDGE_TIMEOUT"),
      );
    } finally {
      await closeBridge(bridge);
    }
  });
  await t.test("connection closed during reload", async () => {
    const bridge = await startFakeBridge({ reply: (_request, socket) => socket.end() });
    try {
      await assert.rejects(
        () => new UnityBridgeClient(bridge.root).editorStatus(),
        unityError("UNITY_BRIDGE_NOT_CONNECTED"),
      );
    } finally {
      await closeBridge(bridge);
    }
  });
  await t.test("cancellation", async () => {
    const bridge = await startFakeBridge({ reply: () => undefined });
    try {
      const controller = new AbortController();
      const promise = new UnityBridgeClient(bridge.root, { timeoutMs: 5_000 }).ping(controller.signal);
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(() => promise, unityError("UNITY_BRIDGE_CANCELLED"));
    } finally {
      await closeBridge(bridge);
    }
  });
  await t.test("oversized response", async () => {
    const bridge = await startFakeBridge({
      reply: (request, socket) => socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { value: "x".repeat(4096) } })}\n`),
    });
    try {
      await assert.rejects(
        () => new UnityBridgeClient(bridge.root, { maximumResponseBytes: 1024 }).ping(),
        unityError("UNITY_BRIDGE_RESPONSE_TOO_LARGE"),
      );
    } finally {
      await closeBridge(bridge);
    }
  });
});

test("Unity package source layout remains Editor-only and contains explicit bounded commands", async () => {
  const packageRoot = join(process.cwd(), "unity", "Packages", "com.unityai.editor-bridge");
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
  const assembly = JSON.parse(await readFile(join(packageRoot, "Editor", "UnityAI.EditorBridge.asmdef"), "utf8")) as Record<string, unknown>;
  const bridgeSource = await readFile(join(packageRoot, "Editor", "BridgeCommands.cs"), "utf8");
  const inputSource = await readFile(join(packageRoot, "Editor", "InputQaController.cs"), "utf8");
  const visualSource = await readFile(join(packageRoot, "Editor", "VisualEvidence.cs"), "utf8");
  const compilationSource = await readFile(join(packageRoot, "Editor", "CompilationTracker.cs"), "utf8");
  assert.equal(packageJson.name, "com.unityai.editor-bridge");
  assert.equal(packageJson.version, "0.3.0");
  assert.deepEqual(assembly.includePlatforms, ["Editor"]);
  assert.doesNotMatch(bridgeSource, /execute_csharp|Process\.Start|File\.Write|MenuItem/u);
  assert.match(inputSource, /QueueStateEvent/u);
  assert.match(inputSource, /QueueDeltaStateEvent/u);
  assert.match(inputSource, /KeyboardState/u);
  assert.match(inputSource, /AddDevice/u);
  assert.match(inputSource, /RemoveDevice/u);
  assert.doesNotMatch(inputSource, /InvokeMember|GetMethod\(parameters|GetField\(parameters|SendMessage/u);
  assert.doesNotMatch(inputSource, /parameters\.(?:componentType|propertyPath).*SetValue/su);
  assert.match(visualSource, /Library.*UnityAI.*screenshots/u);
  assert.doesNotMatch(visualSource, /Assets/u);
  assert.match(compilationSource, /CompilationPipeline\.assemblyCompilationFinished/u);
  assert.match(compilationSource, /CompilationPipeline\.compilationFinished/u);
  assert.doesNotMatch(compilationSource, /System\.Diagnostics|Process\.Start/u);
  for (const method of [
    "bridge.ping",
    "editor.status",
    "editor.requestCompilation",
    "play.enter",
    "play.exit",
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
  ]) {
    assert.match(bridgeSource, new RegExp(method.replace(".", "\\."), "u"));
  }
});
