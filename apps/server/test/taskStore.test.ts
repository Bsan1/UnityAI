import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { TaskSettings } from "@unityai/core";

import { ServerError } from "../src/errors.js";
import { TaskService } from "../src/taskService.js";
import { TaskStore } from "../src/taskStore.js";

const temporaryRoots: string[] = [];
const settings: TaskSettings = {
  crossReviewEnabled: true,
  automaticFixesEnabled: true,
};

const makeRuntimeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "unityai-m1-test-"));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

test("tasks persist, reload, list, and continue IDs after restart", async () => {
  const runtimeRoot = await makeRuntimeRoot();
  const firstStore = new TaskStore(runtimeRoot);
  await firstStore.initialize();
  const firstService = new TaskService(firstStore, settings);

  const first = await firstService.create({
    originalRequest: "First task",
    targetProjectPath: "D:/Games/FirstGame",
    strength: "LIGHT",
  });
  const second = await firstService.create({
    originalRequest: "Second task",
    strength: "STRONG",
  });

  assert.equal(first.id, "TASK-0001");
  assert.equal(second.id, "TASK-0002");

  const restartedStore = new TaskStore(runtimeRoot);
  await restartedStore.initialize();
  const restartedService = new TaskService(restartedStore, settings);
  const reloaded = await restartedService.list();

  assert.deepEqual(
    reloaded.map((task) => task.id),
    ["TASK-0001", "TASK-0002"],
  );
  assert.equal(reloaded[0]?.originalRequest, "First task");
  assert.equal(reloaded[0]?.crossReviewEnabled, true);

  const third = await restartedService.create({
    originalRequest: "Created after restart",
    strength: "STANDARD",
  });
  assert.equal(third.id, "TASK-0003");
});

test("persisted task updates survive a new store instance", async () => {
  const runtimeRoot = await makeRuntimeRoot();
  const store = new TaskStore(runtimeRoot);
  await store.initialize();
  const service = new TaskService(store, settings);
  const created = await service.create({
    originalRequest: "Analyze this task",
    strength: "STANDARD",
  });
  await service.analyze(created.id);

  const restartedStore = new TaskStore(runtimeRoot);
  await restartedStore.initialize();
  const reloaded = await restartedStore.get(created.id);
  assert.equal(reloaded?.state, "ANALYZING");
  assert.equal(reloaded?.events.at(-1)?.type, "STATE_CHANGED");
});

test("corrupted persisted JSON fails clearly during initialization", async () => {
  const runtimeRoot = await makeRuntimeRoot();
  const taskDirectory = join(runtimeRoot, "tasks", "TASK-0001");
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(join(taskDirectory, "task.json"), "{not-json", "utf8");

  const store = new TaskStore(runtimeRoot);
  await assert.rejects(
    () => store.initialize(),
    (error: unknown) =>
      error instanceof ServerError &&
      error.code === "PERSISTENCE_ERROR" &&
      /Persisted task TASK-0001 is invalid/.test(error.message),
  );
});

test("schema-invalid persisted task data is never silently accepted", async () => {
  const runtimeRoot = await makeRuntimeRoot();
  const taskDirectory = join(runtimeRoot, "tasks", "TASK-0001");
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(
    join(taskDirectory, "task.json"),
    JSON.stringify({ id: "TASK-0001", state: "COMPLETED" }),
    "utf8",
  );

  const store = new TaskStore(runtimeRoot);
  await assert.rejects(
    () => store.initialize(),
    (error: unknown) =>
      error instanceof ServerError &&
      error.code === "PERSISTENCE_ERROR" &&
      /Persisted task TASK-0001 is invalid/.test(error.message),
  );
});
