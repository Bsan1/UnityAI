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
  readonly reply?: (request: Record<string, unknown>, socket: Socket) => void;
} = {}): Promise<FakeBridge> => {
  const root = await createUnityProject();
  const token = options.token ?? "a".repeat(48);
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
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
          bridgeVersion: "0.1.0",
          unityVersion: "6000.3.11f1",
          projectPath: root,
          processId: 1234,
        },
        "editor.status": {
          isPlaying: false,
          isPaused: false,
          isCompiling: false,
          isUpdating: false,
          activeScene: "SampleScene",
          activePlatform: "StandaloneWindows64",
        },
        "editor.requestCompilation": { requested: true },
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
      };
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
    bridgeVersion: "0.1.0",
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
    assert.equal((await client.editorStatus()).activeScene, "SampleScene");
    assert.equal((await client.requestCompilation()).requested, true);
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
  assert.equal(packageJson.name, "com.unityai.editor-bridge");
  assert.deepEqual(assembly.includePlatforms, ["Editor"]);
  assert.doesNotMatch(bridgeSource, /execute_csharp|Process\.Start|File\.Write|MenuItem/u);
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
  ]) {
    assert.match(bridgeSource, new RegExp(method.replace(".", "\\."), "u"));
  }
});
