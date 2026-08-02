import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { UnityIntegrationError } from "@unityai/unity";

import { UnityEditorProcessManager } from "../src/unityEditorProcessManager.js";
import type { UnityEditorLauncher } from "../src/unityEditorProcessManager.js";
import {
  WindowsOsInputFallback,
} from "../src/windowsInputFallback.js";
import type {
  WindowsNativeInputBackend,
  WindowsOsInputCommand,
  WindowsOsInputTarget,
} from "../src/windowsInputFallback.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

const fixture = async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "unityai-m8-os-input-"));
  roots.add(projectPath);
  let terminateCalls = 0;
  const launcher: UnityEditorLauncher = {
    launch: async () => ({
      pid: 4242,
      exit: new Promise(() => undefined),
      terminate: async () => { terminateCalls += 1; },
    }),
  };
  const editors = new UnityEditorProcessManager(launcher);
  await editors.start({
    taskId: "TASK-0001",
    executablePath: "C:/Fake/Unity.exe",
    projectPath,
    logPath: join(projectPath, "Editor.log"),
  });
  const calls: Array<WindowsOsInputTarget & { readonly command: WindowsOsInputCommand }> = [];
  const backend: WindowsNativeInputBackend = {
    send: async (input) => {
      calls.push(input);
      return { windowTitle: "Fixture - Unity" };
    },
  };
  const fallback = new WindowsOsInputFallback(editors, backend);
  const target: WindowsOsInputTarget = {
    taskId: "TASK-0001",
    editorProcessId: 4242,
    managedProjectPath: projectPath,
    projectNameHint: "Fixture",
  };
  return { projectPath, editors, fallback, target, calls, terminateCalls };
};

test("guarded OS fallback is opt-in, targets only an owned Unity Game View, records evidence, and releases held controls", async () => {
  const value = await fixture();
  const down = await value.fallback.send(value.target, { kind: "KEY", key: "SPACE", pressed: true });
  await value.fallback.send(value.target, { kind: "MOUSE_BUTTON", button: "LEFT", pressed: true });
  assert.equal(down.inputSource, "WINDOWS_SENDINPUT");
  assert.equal(down.target, "UNITY_GAME_VIEW");
  assert.equal(down.editorProcessId, 4242);
  assert.equal(down.control, "SPACE");
  assert.equal(await value.fallback.releaseAll(value.target), 2);
  assert.deepEqual(
    value.calls.map((entry) => entry.command),
    [
      { kind: "KEY", key: "SPACE", pressed: true },
      { kind: "MOUSE_BUTTON", button: "LEFT", pressed: true },
      { kind: "KEY", key: "SPACE", pressed: false },
      { kind: "MOUSE_BUTTON", button: "LEFT", pressed: false },
    ],
  );
});

test("guarded OS fallback refuses non-owned PID, mismatched worktree, and backend focus failures", async () => {
  const value = await fixture();
  const expectedUnsafe = (error: unknown): boolean =>
    error instanceof UnityIntegrationError && error.code === "OS_INPUT_FOCUS_UNSAFE";
  await assert.rejects(
    () => value.fallback.send({ ...value.target, editorProcessId: 9999 }, { kind: "KEY", key: "SPACE", pressed: true }),
    expectedUnsafe,
  );
  await assert.rejects(
    () => value.fallback.send({ ...value.target, managedProjectPath: join(value.projectPath, "other") }, { kind: "KEY", key: "SPACE", pressed: true }),
    expectedUnsafe,
  );
  const unsafe = new WindowsOsInputFallback(value.editors, {
    send: async () => {
      throw new UnityIntegrationError("OS_INPUT_FOCUS_UNSAFE", "Game View focus cannot be guaranteed.");
    },
  });
  await assert.rejects(
    () => unsafe.send(value.target, { kind: "MOUSE_MOVE", x: 5, y: -2 }),
    expectedUnsafe,
  );
  assert.equal(value.calls.length, 0);
});
